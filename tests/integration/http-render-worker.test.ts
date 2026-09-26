import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpArtifactStore } from "../../src/artifacts/http-artifact-store.js";
import { createLocalArtifactStore } from "../../src/artifacts/local-artifact-store.js";
import { createHttpAdmission, withRenderJobAdmission } from "../../src/mcp/http-admission.js";
import { runHttpRenderWorker } from "../../src/mcp/http-render-worker.js";
import { removeStagedJob, stageAttachments } from "../../src/attachments/local-attachment-stage.js";

const fixture = fileURLToPath(new URL("../fixtures/http-render-worker-fixture.mjs", import.meta.url));
const crashFixture = fileURLToPath(new URL("../fixtures/http-render-worker-crash.mjs", import.meta.url));
const orphanFixture = fileURLToPath(new URL("../fixtures/http-render-worker-orphan.mjs", import.meta.url));
const roots: string[] = [];
const jobIds: string[] = [];
const stagedJobIds: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "marpppt-http-worker-test-"));
  roots.push(root);
  const outputRoot = join(root, "output");
  const tempRoot = join(root, "private-temp");
  const localStore = await createLocalArtifactStore({ outputRoot });
  const downloadStore = createHttpArtifactStore({ localStore, publicBaseUrl: "https://example.invalid" });
  const jobId = "00000000-0000-4000-8000-000000000001";
  jobIds.push(jobId);
  return { root, outputRoot, tempRoot, localStore, downloadStore, jobId };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(stagedJobIds.splice(0).map((jobId) => removeStagedJob(jobId).catch(() => undefined)));
  jobIds.length = 0;
});

describe("HTTP render worker isolation", () => {
  it("times out a blocked worker, waits for exit, removes its output and workspace, and holds the job slot through cleanup", async () => {
    const context = await setup();
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    let allowCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { allowCleanup = resolve; });
    const deleteJob = context.downloadStore.deleteJob.bind(context.downloadStore);
    context.downloadStore.deleteJob = async (jobId) => {
      cleanupStarted();
      await cleanupGate;
      await deleteJob(jobId);
    };
    const events: unknown[] = [];
    let finishFinalized!: () => void;
    const finalized = new Promise<void>((resolve) => { finishFinalized = resolve; });
    const admission = createHttpAdmission({ maxActiveRequests: 2, maxActiveJobs: 1 });
    const operation = withRenderJobAdmission(
      () => admission.tryAcquireJob(),
      (deferReleaseUntil) => runHttpRenderWorker({
        jobId: context.jobId,
        input: { mode: "block" },
        workerEntry: fixture,
        outputRoot: context.outputRoot,
        tempRoot: context.tempRoot,
        artifactStore: context.downloadStore,
        timeoutMs: 250,
        terminateGraceMs: 100,
        onFinalized: (event) => { events.push(event); finishFinalized(); },
      }, deferReleaseUntil),
      () => { throw new Error("unexpected admission rejection"); },
    );

    await started;
    expect(admission.tryAcquireJob()).toBeUndefined();
    allowCleanup();
    const output = await operation;
    await finalized;

    expect(output.status).toBe("failed");
    if (output.status === "failed") expect(output.failure.code).toBe("RENDER_TIMEOUT");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ jobId: context.jobId, status: "failed", errorCode: "RENDER_TIMEOUT", cleanupOutcome: "succeeded" });
    expect(await stat(join(context.outputRoot, context.jobId)).catch(() => undefined)).toBeUndefined();
    expect(await readdir(context.tempRoot).catch(() => [])).toEqual([]);
    expect(await readFile(join(context.outputRoot, context.jobId, "after-timeout.txt")).catch(() => undefined)).toBeUndefined();
    expect(admission.tryAcquireJob()).toBeTypeOf("function");
  });

  it("registers verified worker files as HTTP tokens before returning success", async () => {
    const context = await setup();
    const output = await runHttpRenderWorker({
      jobId: context.jobId,
      input: { mode: "success" },
      workerEntry: fixture,
      outputRoot: context.outputRoot,
      tempRoot: context.tempRoot,
      artifactStore: context.downloadStore,
      timeoutMs: 3_000,
      terminateGraceMs: 100,
    });

    expect(output.status, JSON.stringify(output)).toBe("draft");
    if (output.status !== "failed") {
      expect(output.pptx.uri).toMatch(/^https:\/\/example\.invalid\/artifacts\/[A-Za-z0-9_-]{43}$/u);
      expect(output.marp.uri).toMatch(/^https:\/\/example\.invalid\/artifacts\/[A-Za-z0-9_-]{43}$/u);
      const token = new URL(output.pptx.uri).pathname.split("/").at(-1)!;
      expect(await context.downloadStore.get(token)).toEqual(Buffer.from("PPTX DATA"));
    }
  });

  it("does not turn a successful render into RENDER_TIMEOUT when temp cleanup crosses the deadline", async () => {
    const context = await setup();
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    let allowCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { allowCleanup = resolve; });
    const events: unknown[] = [];
    const operation = runHttpRenderWorker({
      jobId: context.jobId,
      input: { mode: "success" },
      workerEntry: fixture,
      outputRoot: context.outputRoot,
      tempRoot: context.tempRoot,
      artifactStore: context.downloadStore,
      timeoutMs: 250,
      terminateGraceMs: 50,
      cleanupTempWorkspaces: async () => { cleanupStarted(); await cleanupGate; },
      onFinalized: (event) => events.push(event),
    });
    await cleanupStarted;
    await new Promise((resolve) => setTimeout(resolve, 300));
    allowCleanup();
    const output = await operation;

    expect(output.status).toBe("draft");
    expect(output.status === "failed" ? output.failure.code : undefined).not.toBe("RENDER_TIMEOUT");
    expect(events).toMatchObject([{ status: "draft", cleanupOutcome: "succeeded" }]);
  }, 5_000);

  it("rejects an escaped worker ref before registering any HTTP token and removes its files", async () => {
    const context = await setup();
    const registerExisting = context.downloadStore.registerExisting!.bind(context.downloadStore);
    let registrations = 0;
    context.downloadStore.registerExisting = async (...args) => {
      registrations++;
      return registerExisting(...args);
    };
    const output = await runHttpRenderWorker({
      jobId: context.jobId,
      input: { mode: "invalid-ref" },
      workerEntry: fixture,
      outputRoot: context.outputRoot,
      tempRoot: context.tempRoot,
      artifactStore: context.downloadStore,
      timeoutMs: 3_000,
      terminateGraceMs: 100,
    });

    expect(output).toMatchObject({ status: "failed", failure: { code: "WORKER_ARTIFACT_INVALID", stage: "verify" } });
    expect(registrations).toBe(0);
    expect(await stat(join(context.outputRoot, context.jobId)).catch(() => undefined)).toBeUndefined();
  });

  it("returns a typed worker failure when a child exits before consuming stdin", async () => {
    const context = await setup();
    const output = await runHttpRenderWorker({
      jobId: context.jobId,
      input: { padding: "x".repeat(1024 * 1024) },
      workerEntry: crashFixture,
      outputRoot: context.outputRoot,
      tempRoot: context.tempRoot,
      artifactStore: context.downloadStore,
      timeoutMs: 3_000,
      terminateGraceMs: 100,
    });

    expect(output).toMatchObject({ status: "failed", failure: { code: "WORKER_FAILED", stage: "render" } });
  });

  it("kills an ignoring renderer grandchild after the timed-out worker leader exits", async () => {
    const context = await setup();
    const markerPath = join(context.root, "grandchild.pid");
    const heartbeatPath = join(context.root, "grandchild.heartbeat");
    const output = await runHttpRenderWorker({
      jobId: context.jobId,
      input: { markerPath, heartbeatPath },
      workerEntry: orphanFixture,
      outputRoot: context.outputRoot,
      tempRoot: context.tempRoot,
      artifactStore: context.downloadStore,
      timeoutMs: 500,
      terminateGraceMs: 150,
    });
    const pid = Number(await readFile(markerPath, "utf8"));
    try {
      const firstHeartbeat = await readFile(heartbeatPath, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(output).toMatchObject({ status: "failed", failure: { code: "RENDER_TIMEOUT" } });
      expect(await readFile(heartbeatPath, "utf8")).toBe(firstHeartbeat);
    } finally {
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already removed with its worker process group. */ }
      }
    }
  });

  it("returns at the deadline while a parent registration is pending and holds the job slot through cleanup", async () => {
    const context = await setup();
    let registrationStarted!: () => void;
    const started = new Promise<void>((resolve) => { registrationStarted = resolve; });
    let allowRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => { allowRegistration = resolve; });
    let finalized!: () => void;
    const backgroundFinalized = new Promise<void>((resolve) => { finalized = resolve; });
    const registerExisting = context.downloadStore.registerExisting!.bind(context.downloadStore);
    context.downloadStore.registerExisting = async (...args) => {
      registrationStarted();
      await registrationGate;
      return registerExisting(...args);
    };
    const admission = createHttpAdmission({ maxActiveRequests: 1, maxActiveJobs: 1 });
    const operation = withRenderJobAdmission(
      () => admission.tryAcquireJob(),
      (deferReleaseUntil) => runHttpRenderWorker({
        jobId: context.jobId,
        input: { mode: "success" },
        workerEntry: fixture,
        outputRoot: context.outputRoot,
        tempRoot: context.tempRoot,
        artifactStore: context.downloadStore,
        timeoutMs: 300,
        terminateGraceMs: 50,
        onFinalized: () => finalized(),
      }, deferReleaseUntil),
      () => { throw new Error("unexpected admission rejection"); },
    );

    await started;
    const response = await operation;
    expect(response).toMatchObject({ status: "failed", failure: { code: "RENDER_TIMEOUT" } });
    expect(admission.tryAcquireJob()).toBeUndefined();

    allowRegistration();
    await backgroundFinalized;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await stat(join(context.outputRoot, context.jobId)).catch(() => undefined)).toBeUndefined();
    expect(admission.tryAcquireJob()).toBeTypeOf("function");
  }, 10_000);

  it("starts its deadline before asynchronous worker preflight and never spawns after preflight expires", async () => {
    const context = await setup();
    let finishPreflight!: () => void;
    const preflightGate = new Promise<void>((resolve) => { finishPreflight = resolve; });
    const spawnedMarker = join(context.root, "worker-spawned.txt");
    const operation = runHttpRenderWorker({
      jobId: context.jobId,
      input: { mode: "success", spawnedMarker },
      workerEntry: fixture,
      preflight: async () => { await preflightGate; },
      outputRoot: context.outputRoot,
      tempRoot: context.tempRoot,
      artifactStore: context.downloadStore,
      timeoutMs: 100,
      terminateGraceMs: 20,
    });

    const output = await operation;
    finishPreflight();
    await Promise.resolve();
    expect(output).toMatchObject({ status: "failed", failure: { code: "RENDER_TIMEOUT" } });
    expect(await stat(spawnedMarker).catch(() => undefined)).toBeUndefined();
    expect(await stat(join(context.outputRoot, context.jobId)).catch(() => undefined)).toBeUndefined();
  }, 5_000);

  it("keeps the 60-second job deadline active through parent artifact registration", async () => {
    const context = await setup();
    let registrationStarted!: () => void;
    const started = new Promise<void>((resolve) => { registrationStarted = resolve; });
    let allowRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => { allowRegistration = resolve; });
    let finalized!: () => void;
    const finalizer = new Promise<void>((resolve) => { finalized = resolve; });
    const registerExisting = context.downloadStore.registerExisting!.bind(context.downloadStore);
    context.downloadStore.registerExisting = async (...args) => {
      registrationStarted();
      await registrationGate;
      return registerExisting(...args);
    };
    const operation = runHttpRenderWorker({
      jobId: context.jobId,
      input: { mode: "success" },
      workerEntry: fixture,
      outputRoot: context.outputRoot,
      tempRoot: context.tempRoot,
      artifactStore: context.downloadStore,
      timeoutMs: 500,
      terminateGraceMs: 100,
      onFinalized: () => finalized(),
    });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 550));
    allowRegistration();
    const output = await operation;
    await finalizer;

    expect(output).toMatchObject({ status: "failed", failure: { code: "RENDER_TIMEOUT", stage: "render" } });
    expect(await stat(join(context.outputRoot, context.jobId)).catch(() => undefined)).toBeUndefined();
  });

  it("runs the actual child entry with same-host staged refs and returns downloadable artifacts", async () => {
    const context = await setup();
    const sourceBytes = Buffer.from("# Worker integration\n\nA staged source crosses the worker boundary.\n", "utf8");
    const sourcePath = join(context.root, "source.md");
    await writeFile(sourcePath, sourceBytes);
    const staged = await stageAttachments({ sourcePath, imagePaths: [] });
    stagedJobIds.push(staged.jobId);
    const output = await runHttpRenderWorker({
      jobId: context.jobId,
      input: {
        plan: {
          version: 1,
          title: "Worker integration",
          language: "en",
          themeId: "default",
          sourceDigest: createHash("sha256").update(sourceBytes).digest("hex"),
          slides: [{ id: "cover", title: "Worker integration", layout: "cover", imageIds: [] }],
          imageAssetIds: [],
          assetManifest: [],
        },
        sourceFile: staged.sourceFile,
        imageFiles: [],
        imageAssetIds: [],
      },
      outputRoot: context.outputRoot,
      tempRoot: context.tempRoot,
      artifactStore: context.downloadStore,
      timeoutMs: 15_000,
      terminateGraceMs: 500,
    });

    expect(["draft", "completed"]).toContain(output.status);
    if (output.status !== "failed") {
      expect(output.jobId).toBe(context.jobId);
      const token = new URL(output.pptx.uri).pathname.split("/").at(-1)!;
      expect((await context.downloadStore.read(token)).fileName).toMatch(/\.pptx$/u);
    }
  }, 20_000);

  it("keeps an oversized hosted preview failure as a draft and reaps its renderer descendant on worker close", async () => {
    const context = await setup();
    const sourceBytes = Buffer.from("# Oversized renderer output\n\nThe PPTX remains editable.\n", "utf8");
    const sourcePath = join(context.root, "oversized-source.md");
    await writeFile(sourcePath, sourceBytes);
    const staged = await stageAttachments({ sourcePath, imagePaths: [] });
    stagedJobIds.push(staged.jobId);
    const rendererPath = join(context.root, "oversized-soffice.mjs");
    const markerPath = join(context.root, "renderer-child.pid");
    const heartbeatPath = join(context.root, "renderer-child.heartbeat");
    const childSource = `const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(heartbeatPath)},"started");setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeatPath)},String(Date.now())),20)`;
    await writeFile(rendererPath, [
      "#!/usr/bin/env node",
      'import { spawn } from "node:child_process";',
      'import { existsSync, writeFileSync } from "node:fs";',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(markerPath)}, String(descendant.pid));`,
      `const until = Date.now() + 2000; while (!existsSync(${JSON.stringify(heartbeatPath)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
      'process.stdout.write("x".repeat(300 * 1024));',
      "setInterval(() => {}, 10000);",
    ].join("\n"), { mode: 0o700 });
    const previousSoffice = process.env.MARPPPT_SOFFICE;
    process.env.MARPPPT_SOFFICE = rendererPath;
    let output;
    let rendererPid = 0;
    try {
      output = await runHttpRenderWorker({
        jobId: context.jobId,
        input: {
          plan: {
            version: 1,
            title: "Oversized renderer output",
            language: "en",
            themeId: "default",
            sourceDigest: createHash("sha256").update(sourceBytes).digest("hex"),
            slides: [{ id: "cover", title: "Oversized renderer output", layout: "cover", imageIds: [] }],
            imageAssetIds: [],
            assetManifest: [],
          },
          sourceFile: staged.sourceFile,
          imageFiles: [],
          imageAssetIds: [],
        },
        outputRoot: context.outputRoot,
        tempRoot: context.tempRoot,
        artifactStore: context.downloadStore,
        timeoutMs: 10_000,
        terminateGraceMs: 100,
      });
      rendererPid = Number(await readFile(markerPath, "utf8"));
      expect(output.status).toBe("draft");
      if (output.status !== "failed") {
        const token = new URL(output.pptx.uri).pathname.split("/").at(-1)!;
        expect((await context.downloadStore.get(token)).subarray(0, 2)).toEqual(Buffer.from("PK"));
      }
      const firstHeartbeat = await readFile(heartbeatPath, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await readFile(heartbeatPath, "utf8")).toBe(firstHeartbeat);
    } finally {
      if (previousSoffice === undefined) delete process.env.MARPPPT_SOFFICE;
      else process.env.MARPPPT_SOFFICE = previousSoffice;
      if (Number.isInteger(rendererPid) && rendererPid > 0) {
        try { process.kill(rendererPid, "SIGKILL"); } catch { /* Already reaped with the worker process group. */ }
      }
    }
  }, 20_000);

  it("kills detached preview descendants when the parent times out the actual render worker", async () => {
    const context = await setup();
    const sourceBytes = Buffer.from("# Worker timeout\n\nExercise renderer cancellation.\n", "utf8");
    const sourcePath = join(context.root, "timeout-source.md");
    await writeFile(sourcePath, sourceBytes);
    const staged = await stageAttachments({ sourcePath, imagePaths: [] });
    stagedJobIds.push(staged.jobId);
    const rendererPath = join(context.root, "hanging-soffice.mjs");
    const markerPath = join(context.root, "renderer-child.pid");
    const heartbeatPath = join(context.root, "renderer-child.heartbeat");
    await writeFile(rendererPath, [
      "#!/usr/bin/env node",
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM",()=>{});setInterval(() => require("node:fs").writeFileSync(${JSON.stringify(heartbeatPath)}, String(Date.now())), 20)`)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(markerPath)}, String(child.pid));`,
      "setInterval(() => {}, 10000);",
    ].join("\n"), { mode: 0o700 });
    const previousSoffice = process.env.MARPPPT_SOFFICE;
    process.env.MARPPPT_SOFFICE = rendererPath;
    let output;
    try {
      output = await runHttpRenderWorker({
        jobId: context.jobId,
        input: {
          plan: {
            version: 1,
            title: "Worker timeout",
            language: "en",
            themeId: "default",
            sourceDigest: createHash("sha256").update(sourceBytes).digest("hex"),
            slides: [{ id: "cover", title: "Worker timeout", layout: "cover", imageIds: [] }],
            imageAssetIds: [],
            assetManifest: [],
          },
          sourceFile: staged.sourceFile,
          imageFiles: [],
          imageAssetIds: [],
        },
        outputRoot: context.outputRoot,
        tempRoot: context.tempRoot,
        artifactStore: context.downloadStore,
        timeoutMs: 5_000,
        terminateGraceMs: 300,
      });
    } finally {
      if (previousSoffice === undefined) delete process.env.MARPPPT_SOFFICE;
      else process.env.MARPPPT_SOFFICE = previousSoffice;
    }

    expect(output).toMatchObject({ status: "failed", failure: { code: "RENDER_TIMEOUT" } });
    const firstHeartbeat = await readFile(heartbeatPath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(heartbeatPath, "utf8")).toBe(firstHeartbeat);
    expect(await stat(join(context.outputRoot, context.jobId)).catch(() => undefined)).toBeUndefined();
    expect(await readdir(context.tempRoot).catch(() => [])).toEqual([]);
  }, 15_000);
});
