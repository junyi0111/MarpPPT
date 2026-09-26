import { spawn, type ChildProcess } from "node:child_process";
import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStoreError, assertServerArtifactIdentity, MARP_BUNDLE_MIME, MARP_MIME, PPTX_MIME, PREVIEW_MIME, type ArtifactRef, type HttpArtifactStore } from "../artifacts/artifact-store.js";
import { cleanupTempWorkspacesForJobId, getDefaultTempWorkspaceRoot } from "../attachments/temp-workspace.js";
import { RenderPresentationOutputSchema, type PresentationFailure, type RenderFinalizedEvent, type RenderPresentationOutput } from "./tools/render-presentation.js";

export const HTTP_RENDER_DEADLINE_MS = 60_000;
export const HTTP_RENDER_WORKER_INPUT_LIMIT_BYTES = 2 * 1024 * 1024;
export const HTTP_RENDER_WORKER_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TERMINATE_GRACE_MS = 500;

export interface HttpRenderWorkerOptions {
  jobId: string;
  input: unknown;
  outputRoot: string;
  tempRoot?: string;
  artifactStore: HttpArtifactStore;
  workerEntry?: string;
  timeoutMs?: number;
  terminateGraceMs?: number;
  outputLimitBytes?: number;
  /** Test seam for a bounded async initialization step before the child starts. */
  preflight?: () => Promise<void>;
  /** Test seam to verify cleanup remains outside the render deadline. */
  cleanupTempWorkspaces?: () => Promise<void>;
  onFinalized?: (event: RenderFinalizedEvent) => void;
}

interface WorkerEnvelope {
  version: 1;
  output: unknown;
}

interface CloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function failureOutput(jobId: string, code: string, stage: PresentationFailure["failure"]["stage"], message: string, retryable = true): RenderPresentationOutput {
  return {
    status: "failed",
    jobId,
    failure: { code, stage, message, retryable },
    warnings: [],
  };
}

function workerGroupExists(child: ChildProcess): boolean {
  if (process.platform === "win32" || child.pid === undefined) return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalWorkerGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      child.kill(signal);
      return true;
    }
  }
  try { return child.kill(signal); } catch { return false; }
}

async function reapResidualWorkerGroup(child: ChildProcess, graceMs: number): Promise<void> {
  if (process.platform === "win32" || !workerGroupExists(child)) return;
  signalWorkerGroup(child, "SIGTERM");
  const termDeadline = performance.now() + graceMs;
  while (workerGroupExists(child) && performance.now() < termDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (workerGroupExists(child)) signalWorkerGroup(child, "SIGKILL");
}

function terminateAndAwait(child: ChildProcess, closed: Promise<CloseResult>, graceMs: number): Promise<void> {
  signalWorkerGroup(child, "SIGTERM");
  return new Promise((resolve) => {
    let settled = false;
    let leaderClosed = false;
    let graceElapsed = false;
    const finish = () => {
      if (settled || !leaderClosed || !graceElapsed) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      graceElapsed = true;
      if (workerGroupExists(child)) signalWorkerGroup(child, "SIGKILL");
      finish();
    }, graceMs);
    void closed.then(() => {
      leaderClosed = true;
      if (!workerGroupExists(child)) {
        settled = true;
        clearTimeout(timer);
        resolve();
        return;
      }
      finish();
    });
  });
}

async function verifyAndRegisterOutput(
  output: RenderPresentationOutput,
  options: HttpRenderWorkerOptions,
): Promise<RenderPresentationOutput> {
  if (output.status === "failed") return output;
  if (output.jobId !== options.jobId) throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The worker result job ID did not match its parent request.");
  const store = options.artifactStore;
  if (!store.registerExisting) throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The HTTP artifact store cannot register worker output files.");
  const realRoot = await realpath(options.outputRoot);
  const jobPath = join(realRoot, options.jobId);
  const jobStat = await lstat(jobPath);
  if (!jobStat.isDirectory() || jobStat.isSymbolicLink() || (process.getuid && jobStat.uid !== process.getuid()) || (jobStat.mode & 0o077) !== 0) {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The worker job output directory is not private.");
  }

  const roles: Array<{ ref: ArtifactRef; expectedMime: string; extension: string }> = [
    { ref: output.pptx, expectedMime: PPTX_MIME, extension: ".pptx" },
    { ref: output.marp, expectedMime: MARP_MIME, extension: ".marp.md" },
    ...(output.marpBundle ? [{ ref: output.marpBundle, expectedMime: MARP_BUNDLE_MIME, extension: ".marp.zip" }] : []),
    ...output.previews.map((ref) => ({ ref, expectedMime: PREVIEW_MIME, extension: ".png" })),
  ];
  const seenFileNames = new Set<string>();
  const verifiedRefs: ArtifactRef[] = [];
  for (const { ref, expectedMime, extension } of roles) {
    assertServerArtifactIdentity(options.jobId, ref.fileName, ref.mimeType);
    if (ref.mimeType !== expectedMime || !ref.fileName.toLowerCase().endsWith(extension)
        || ref.expiresAt !== null || seenFileNames.has(ref.fileName)) {
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "A worker artifact identity did not match its output role.");
    }
    seenFileNames.add(ref.fileName);
    let parsedUri: URL;
    try { parsedUri = new URL(ref.uri); }
    catch (error) { throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "A worker artifact reference was not a valid URL.", { cause: error }); }
    if (parsedUri.protocol !== "file:" || parsedUri.host || parsedUri.search || parsedUri.hash) throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "A worker artifact reference was not a local file URI.");
    const localPath = fileURLToPath(parsedUri);
    const expectedPath = join(jobPath, ref.fileName);
    if (localPath !== expectedPath) {
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "A worker artifact reference did not point to its expected job file.");
    }
    const fileStat = await lstat(expectedPath);
    const fileReal = await realpath(expectedPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileReal !== expectedPath
        || (process.getuid && fileStat.uid !== process.getuid()) || (fileStat.mode & 0o077) !== 0) {
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "A worker artifact was not a regular file in its private job directory.");
    }
    verifiedRefs.push(ref);
  }

  const registrations: ArtifactRef[] = [];
  for (const ref of verifiedRefs) registrations.push(await store.registerExisting!(options.jobId, ref.fileName, ref.mimeType, ref.uri));
  const byFileName = new Map(registrations.map((ref) => [ref.fileName, ref]));
  const pptx = byFileName.get(output.pptx.fileName)!;
  const marp = byFileName.get(output.marp.fileName)!;
  const marpBundle = output.marpBundle ? byFileName.get(output.marpBundle.fileName) : undefined;
  const previews: ArtifactRef[] = [];
  for (const preview of output.previews) previews.push(byFileName.get(preview.fileName)!);
  return RenderPresentationOutputSchema.parse({
    ...output,
    pptx,
    marp,
    ...(marpBundle ? { marpBundle } : {}),
    previews,
  }) as RenderPresentationOutput;
}

async function cleanup(options: HttpRenderWorkerOptions, deleteOutput: boolean): Promise<"succeeded" | "failed" | "not-needed"> {
  let attempted = false;
  let failed = false;
  if (deleteOutput) {
    attempted = true;
    try {
      if (!options.artifactStore.deleteJob) throw new Error("HTTP artifact store cannot delete a job");
      await options.artifactStore.deleteJob(options.jobId);
    }
    catch { failed = true; }
  }
  try {
    attempted = true;
    if (options.cleanupTempWorkspaces) await options.cleanupTempWorkspaces();
    else await cleanupTempWorkspacesForJobId(options.jobId, { root: options.tempRoot ?? getDefaultTempWorkspaceRoot() });
  } catch { failed = true; }
  return !attempted ? "not-needed" : failed ? "failed" : "succeeded";
}

async function deferFinalization(
  options: HttpRenderWorkerOptions,
  output: RenderPresentationOutput,
  startedAt: number,
  deleteOutput: boolean,
  pending: Promise<unknown> | undefined,
  deferReleaseUntil?: (pending: Promise<unknown>) => void,
): Promise<void> {
  const finalizer = Promise.resolve(pending).catch(() => undefined).then(async () => {
    const cleanupOutcome = await cleanup(options, deleteOutput);
    emitFinalized(options, startedAt, output, cleanupOutcome);
  });
  if (deferReleaseUntil) deferReleaseUntil(finalizer);
  else await finalizer;
}

async function resolveWorkerCommand(workerEntry?: string): Promise<string[]> {
  if (workerEntry) return [workerEntry];
  const builtEntry = fileURLToPath(new URL("./http-render-worker-child.js", import.meta.url));
  try {
    await access(builtEntry);
    return [builtEntry];
  } catch {
    const sourceEntry = fileURLToPath(new URL("./http-render-worker-child.ts", import.meta.url));
    await access(sourceEntry);
    return ["--import", "tsx", sourceEntry];
  }
}

function emitFinalized(options: HttpRenderWorkerOptions, startedAt: number, output: RenderPresentationOutput, cleanupOutcome: RenderFinalizedEvent["cleanupOutcome"]): void {
  const event: RenderFinalizedEvent = {
    jobId: options.jobId,
    status: output.status,
    ...(output.status === "failed" ? { errorCode: output.failure.code } : {}),
    durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
    cleanupOutcome,
  };
  try { options.onFinalized?.(event); } catch { /* Telemetry cannot change the render result. */ }
}

export async function runHttpRenderWorker(
  options: HttpRenderWorkerOptions,
  deferReleaseUntil?: (pending: Promise<unknown>) => void,
): Promise<RenderPresentationOutput> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? HTTP_RENDER_DEADLINE_MS;
  const deadlineAt = startedAt + timeoutMs;
  const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  const outputLimitBytes = options.outputLimitBytes ?? HTTP_RENDER_WORKER_OUTPUT_LIMIT_BYTES;
  let output: RenderPresentationOutput;
  let cleanupOutcome: RenderFinalizedEvent["cleanupOutcome"] = "not-needed";
  let keepOutput = false;
  let started = false;

  let inputJson: string;
  try {
    inputJson = JSON.stringify(options.input);
  } catch {
    output = failureOutput(options.jobId, "WORKER_INPUT_INVALID", "input", "The render request could not be serialized for the isolated worker.", false);
    emitFinalized(options, startedAt, output, cleanupOutcome);
    return output;
  }
  if (Buffer.byteLength(inputJson, "utf8") > HTTP_RENDER_WORKER_INPUT_LIMIT_BYTES) {
    output = failureOutput(options.jobId, "WORKER_INPUT_TOO_LARGE", "input", "The render request exceeds the isolated worker input limit.", false);
    emitFinalized(options, startedAt, output, cleanupOutcome);
    return output;
  }
  if (!isAbsolute(options.outputRoot) || !isAbsolute(options.tempRoot ?? getDefaultTempWorkspaceRoot())
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(terminateGraceMs) || terminateGraceMs < 1
      || !Number.isInteger(outputLimitBytes) || outputLimitBytes < 1) {
    output = failureOutput(options.jobId, "WORKER_CONFIG_INVALID", "input", "The isolated render worker configuration is invalid.", false);
    emitFinalized(options, startedAt, output, cleanupOutcome);
    return output;
  }

  let timedOut = false;
  let child: ChildProcess | undefined;
  let closed: Promise<CloseResult> | undefined;
  let stopPromise: Promise<void> | undefined;
  let resolveDeadline!: () => void;
  const deadlineReached = new Promise<void>((resolve) => { resolveDeadline = resolve; });
  const stop = () => {
    if (!child || !closed) return Promise.resolve();
    stopPromise ??= terminateAndAwait(child, closed, terminateGraceMs);
    return stopPromise;
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    resolveDeadline();
    void stop();
  }, Math.max(1, Math.ceil(deadlineAt - performance.now())));

  let workerCommand: string[];
  let workerOutputRoot: string;
  try {
    const preflight = Promise.resolve().then(async () => {
      await options.preflight?.();
      const [command, outputRoot] = await Promise.all([
        resolveWorkerCommand(options.workerEntry),
        realpath(options.outputRoot),
      ]);
      return { kind: "ready" as const, command, outputRoot };
    });
    const preflightResult = await Promise.race([
      preflight,
      deadlineReached.then(() => ({ kind: "timeout" as const })),
    ]);
    if (preflightResult.kind === "timeout" || timedOut || performance.now() >= deadlineAt) {
      timedOut = true;
      clearTimeout(deadline);
      output = failureOutput(options.jobId, "RENDER_TIMEOUT", "render", "The presentation render exceeded its 60-second worker deadline.");
      await deferFinalization(options, output, startedAt, true, undefined, deferReleaseUntil);
      return output;
    }
    workerCommand = preflightResult.command;
    workerOutputRoot = preflightResult.outputRoot;
  } catch {
    clearTimeout(deadline);
    if (timedOut || performance.now() >= deadlineAt) {
      timedOut = true;
      output = failureOutput(options.jobId, "RENDER_TIMEOUT", "render", "The presentation render exceeded its 60-second worker deadline.");
      await deferFinalization(options, output, startedAt, true, undefined, deferReleaseUntil);
    } else {
      output = failureOutput(options.jobId, "WORKER_CONFIG_INVALID", "input", "The isolated render worker entry point or private output directory is unavailable.", false);
      emitFinalized(options, startedAt, output, cleanupOutcome);
    }
    return output;
  }
  if (timedOut || performance.now() >= deadlineAt) {
    clearTimeout(deadline);
    timedOut = true;
    output = failureOutput(options.jobId, "RENDER_TIMEOUT", "render", "The presentation render exceeded its 60-second worker deadline.");
    await deferFinalization(options, output, startedAt, true, undefined, deferReleaseUntil);
    return output;
  }
  try {
    child = spawn(process.execPath, [...workerCommand, options.jobId], {
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        PPTX_OUTPUT_ROOT: workerOutputRoot,
        MARPPPT_PRIVATE_TEMP_ROOT: options.tempRoot ?? getDefaultTempWorkspaceRoot(),
      },
    });
    started = true;
  } catch {
    clearTimeout(deadline);
    output = failureOutput(options.jobId, "WORKER_SPAWN_FAILED", "render", "The isolated render worker could not be started.");
    cleanupOutcome = await cleanup(options, true);
    emitFinalized(options, startedAt, output, cleanupOutcome);
    return output;
  }

  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let outputTooLarge = false;
  let spawnError: Error | undefined;
  closed = new Promise<CloseResult>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => { spawnError = error; });
  });
  child.stdin?.on("error", (error) => { spawnError = error; });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += bytes.byteLength;
    if (stdoutBytes > outputLimitBytes) {
      outputTooLarge = true;
      void stop();
      return;
    }
    stdoutChunks.push(bytes);
  });
  try {
    child.stdin?.end(inputJson, "utf8");
    const closeResult = await closed;
    if (stopPromise) await stopPromise;
    else await reapResidualWorkerGroup(child, terminateGraceMs);
    if (timedOut) {
      output = failureOutput(options.jobId, "RENDER_TIMEOUT", "render", "The presentation render exceeded its 60-second worker deadline.");
    } else if (outputTooLarge) {
      output = failureOutput(options.jobId, "WORKER_OUTPUT_TOO_LARGE", "render", "The isolated render worker output exceeded its supported limit.");
    } else if (spawnError || closeResult.code !== 0) {
      output = failureOutput(options.jobId, "WORKER_FAILED", "render", "The isolated presentation worker did not complete successfully.");
    } else {
      let envelope: WorkerEnvelope | undefined;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const candidate = parsed as Partial<WorkerEnvelope>;
          const keys = Object.keys(candidate);
          if (candidate.version === 1 && "output" in candidate && keys.length === 2 && keys.every((key) => key === "version" || key === "output")) {
            envelope = candidate as WorkerEnvelope;
          }
        }
      } catch { /* A malformed worker response becomes a generic typed failure. */ }
      if (!envelope) {
        output = failureOutput(options.jobId, "WORKER_OUTPUT_INVALID", "verify", "The isolated render worker returned an invalid result.");
      } else {
        const registration = (async () => {
          const parsedOutput = RenderPresentationOutputSchema.parse(envelope.output) as RenderPresentationOutput;
          if (parsedOutput.jobId !== options.jobId) throw new Error("worker job ID mismatch");
          return verifyAndRegisterOutput(parsedOutput, options);
        })();
        const registrationResult = await Promise.race([
          registration.then(
            (registeredOutput) => ({ kind: "complete" as const, output: registeredOutput }),
            () => ({ kind: "invalid" as const }),
          ),
          deadlineReached.then(() => ({ kind: "timeout" as const })),
        ]);
        if (registrationResult.kind === "timeout" || timedOut || performance.now() >= deadlineAt) {
          if (!timedOut) {
            timedOut = true;
            resolveDeadline();
            void stop();
          }
          clearTimeout(deadline);
          output = failureOutput(options.jobId, "RENDER_TIMEOUT", "render", "The presentation render exceeded its 60-second worker deadline.");
          const pendingFinalization = Promise.all([registration.catch(() => undefined), stopPromise ?? Promise.resolve()]);
          await deferFinalization(options, output, startedAt, true, pendingFinalization, deferReleaseUntil);
          return output;
        }
        if (registrationResult.kind === "complete") {
          output = registrationResult.output;
          keepOutput = output.status !== "failed";
        } else {
          output = failureOutput(options.jobId, "WORKER_ARTIFACT_INVALID", "verify", "The isolated render worker returned invalid or untrusted artifacts.");
        }
      }
    }
  } catch {
    if (stopPromise) await stopPromise;
    output = failureOutput(options.jobId, "WORKER_FAILED", "render", "The isolated presentation worker did not complete successfully.");
  }

  if (performance.now() >= deadlineAt) timedOut = true;
  if (timedOut) {
    output = failureOutput(options.jobId, "RENDER_TIMEOUT", "render", "The presentation render exceeded its 60-second worker deadline.");
    keepOutput = false;
  }
  clearTimeout(deadline);
  if (timedOut) {
    await deferFinalization(options, output!, startedAt, true, stopPromise, deferReleaseUntil);
    return output!;
  }
  cleanupOutcome = await cleanup(options, !keepOutput || !started);
  emitFinalized(options, startedAt, output!, cleanupOutcome);
  return output!;
}
