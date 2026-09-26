import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, open, readFile, realpath, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { inspectPptx, type PptxInspection } from "../pptx/render-pptx.js";
import { createContactSheet } from "./contact-sheet.js";

const MAX_TIMEOUT_MS = 60_000;
const STDERR_LIMIT = 4096;
const EXEC_MAX_BUFFER = 256 * 1024;
const DEFAULT_FONT = "Noto Sans CJK TC";
const COMMAND_ENV: Record<"soffice" | "pdfinfo" | "pdftoppm" | "fc-match", string> = {
  soffice: "MARPPPT_SOFFICE",
  pdfinfo: "MARPPPT_PDFINFO",
  pdftoppm: "MARPPPT_PDFTOPPM",
  "fc-match": "MARPPPT_FC_MATCH",
};

export type PreviewStage = "input" | "pptx" | "soffice" | "pdf" | "pdfinfo" | "pdftoppm" | "pages" | "contact-sheet" | "fc-match";
export type PreviewIssueCode =
  | "PREVIEW_INVALID_INPUT"
  | "PPTX_INVALID"
  | "PREVIEW_UNAVAILABLE"
  | "PREVIEW_TIMEOUT"
  | "PREVIEW_RENDER_FAILED"
  | "PAGE_COUNT_MISMATCH"
  | "PAGE_SEQUENCE_INVALID"
  | "PREVIEW_CLEANUP_FAILED"
  | "FONT_MATCHER_UNAVAILABLE"
  | "FONT_SUBSTITUTED"
  | "CONTACT_SHEET_FAILED";

export interface PreviewIssue {
  code: PreviewIssueCode;
  stage: PreviewStage;
  message: string;
  stderr?: string;
  expectedPages?: number;
  actualPages?: number;
  missingPageNumbers?: number[];
  unexpectedPageNumbers?: number[];
}

export interface PreviewReport {
  status: "ready" | "draft";
  slideCount: number | null;
  pdfPageCount: number | null;
  pageCount: number;
  pdfPath: string | null;
  pngPaths: string[];
  contactSheetPath: string | null;
  font: { requested: string; selected: string | null; substituted: boolean };
  warnings: PreviewIssue[];
  errors: PreviewIssue[];
  /** Rendering is a preview aid; a person or a later vision gate must perform visual QA. */
  visualQaPassed: false;
}

export interface PreviewCommand {
  file: string;
  /** Arguments prepended before the adapter's standard arguments; intended for stable test runners. */
  args?: string[];
}

export interface PreviewOptions {
  commands?: Partial<Record<"soffice" | "pdfinfo" | "pdftoppm" | "fc-match", PreviewCommand>>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** When set, renderer subprocesses inherit the caller's process group (hosted worker only). */
  processGroupId?: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandFailure extends Error {
  cause?: unknown;
  stderr: string;
  timedOut: boolean;
}

function initialReport(requested = DEFAULT_FONT): PreviewReport {
  return {
    status: "draft",
    slideCount: null,
    pdfPageCount: null,
    pageCount: 0,
    pdfPath: null,
    pngPaths: [],
    contactSheetPath: null,
    font: { requested, selected: null, substituted: false },
    warnings: [],
    errors: [],
    visualQaPassed: false,
  };
}

function boundedStderr(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(-STDERR_LIMIT);
}

function failureIssue(stage: PreviewStage, error: CommandFailure): PreviewIssue {
  const code: PreviewIssueCode = error.timedOut
    ? "PREVIEW_TIMEOUT"
    : (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? "PREVIEW_UNAVAILABLE"
      : "PREVIEW_RENDER_FAILED";
  const message = code === "PREVIEW_TIMEOUT"
    ? `Preview command timed out during ${stage}.`
    : code === "PREVIEW_UNAVAILABLE"
      ? `Required preview renderer is unavailable during ${stage}.`
      : `Preview command failed during ${stage}.`;
  const stderr = boundedStderr(error.stderr);
  return { code, stage, message, ...(stderr ? { stderr } : {}) };
}

function killRendererProcess(child: ChildProcess, processGroupId?: number, terminateWorkerGroup = false): void {
  const pid = child.pid;
  if (processGroupId !== undefined && process.platform !== "win32") {
    if (terminateWorkerGroup) {
      try { process.kill(-processGroupId, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    } else {
      // A renderer-local failure must not kill its hosted worker. Any renderer
      // descendants left behind are reaped when the parent closes its group.
      child.kill("SIGKILL");
    }
    return;
  }
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else {
      const killer = nodeSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => undefined);
      killer.unref();
      child.kill("SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

function runCommand(file: string, args: string[], timeoutMs: number, signal?: AbortSignal, processGroupId?: number): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (timeoutMs <= 0) {
      const error = new Error("Preview deadline exceeded") as CommandFailure;
      error.stderr = "";
      error.timedOut = true;
      rejectPromise(error);
      return;
    }

    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let spawnError: Error | undefined;
    let stdoutLength = 0;
    let stderrLength = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // Local stdio rendering isolates each renderer process group. Hosted renderers inherit
    // the worker group so the parent can reap leftovers after the worker closes.
    const child = nodeSpawn(file, args, {
      shell: false,
      detached: process.platform !== "win32" && processGroupId === undefined,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (target: Buffer[], data: Buffer | string, currentLength: number): number => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const remaining = Math.max(0, EXEC_MAX_BUFFER - currentLength);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining) {
        outputExceeded = true;
        killRendererProcess(child, processGroupId);
      }
      return currentLength + Math.min(chunk.length, remaining);
    };
    child.stdout?.on("data", (data: Buffer | string) => { stdoutLength = capture(stdoutChunks, data, stdoutLength); });
    child.stderr?.on("data", (data: Buffer | string) => { stderrLength = capture(stderrChunks, data, stderrLength); });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      optionsSignal?.removeEventListener("abort", abortCommand);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (spawnError || timedOut || aborted || outputExceeded || code !== 0) {
        const message = timedOut ? "Preview command timed out" : aborted ? "Preview command was aborted" : outputExceeded ? "Preview command output exceeded the capture limit" : spawnError?.message ?? `Preview command exited with ${signal ?? code}`;
        const failure = new Error(message) as CommandFailure;
        failure.cause = spawnError;
        failure.stderr = stderr;
        failure.timedOut = timedOut;
        rejectPromise(failure);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    const optionsSignal = signal;
    const abortCommand = () => {
      aborted = true;
      killRendererProcess(child, processGroupId, true);
    };
    if (signal?.aborted) abortCommand();
    else signal?.addEventListener("abort", abortCommand, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killRendererProcess(child, processGroupId);
    }, timeoutMs);
    timer.unref?.();
  });
}

function assertWithinDirectory(directory: string, file: string): boolean {
  const relativePath = relative(directory, file);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

async function validateInput(pptxPath: string, workDir: string): Promise<{ realPptxPath: string; realWorkDir: string; bytes: Uint8Array }> {
  if (!isAbsolute(pptxPath) || !isAbsolute(workDir) || extname(pptxPath).toLowerCase() !== ".pptx") {
    throw new TypeError("PPTX path and temporary work directory must be absolute local paths");
  }
  const [directoryStat, fileStat] = await Promise.all([lstat(workDir), lstat(pptxPath)]);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new TypeError("Preview work directory must be a real directory");
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new TypeError("PPTX path must be a regular file, not a symlink");
  const [realWorkDir, realPptxPath] = await Promise.all([realpath(workDir), realpath(pptxPath)]);
  if (!assertWithinDirectory(realWorkDir, realPptxPath)) throw new TypeError("PPTX must be inside its temporary work directory");
  const bytes = await readFile(realPptxPath);
  if (bytes.length === 0) throw new TypeError("PPTX file is empty");
  return { realPptxPath, realWorkDir, bytes };
}

function themeFont(bytes: Uint8Array): string {
  try {
    const archive = unzipSync(bytes);
    const themeBytes = archive["ppt/theme/theme1.xml"];
    if (!themeBytes) return DEFAULT_FONT;
    const xml = strFromU8(themeBytes);
    const fontTag = /<a:latin\b[^>]*\btypeface="([^"]+)"/u.exec(xml)?.[1];
    if (!fontTag || !fontTag.trim()) return DEFAULT_FONT;
    return fontTag.replaceAll("&amp;", "&").trim();
  } catch {
    return DEFAULT_FONT;
  }
}

interface RenderedPageFile {
  pageNumber: number;
  path: string;
}

function sortedPngPages(names: string[], prefix: string, directory: string): RenderedPageFile[] {
  const expression = new RegExp(`^${prefix}(\\d+)\\.png$`, "iu");
  return names.flatMap((name) => {
    const match = expression.exec(name);
    return match ? [{ pageNumber: Number(match[1]), path: join(directory, name) }] : [];
  }).sort((left, right) => left.pageNumber - right.pageNumber);
}

function addError(report: PreviewReport, error: PreviewIssue): void {
  report.errors.push(error);
  report.status = "draft";
}

async function discardPreviewArtifacts(report: PreviewReport, previewDirectory: string): Promise<PreviewReport> {
  try {
    await rm(previewDirectory, { recursive: true, force: true });
  } catch (error) {
    addError(report, {
      code: "PREVIEW_CLEANUP_FAILED",
      stage: "input",
      message: error instanceof Error ? error.message : "Cannot remove the failed preview workspace; the enclosing job cleanup must remove it.",
    });
  }
  report.pdfPath = null;
  report.pngPaths = [];
  report.contactSheetPath = null;
  return report;
}

export async function renderPreview(pptxPath: string, workDir: string, options: PreviewOptions = {}): Promise<PreviewReport> {
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(options.timeoutMs ?? MAX_TIMEOUT_MS)));
  const deadline = Date.now() + timeoutMs;
  const report = initialReport();
  let input: Awaited<ReturnType<typeof validateInput>>;
  try {
    input = await validateInput(pptxPath, workDir);
  } catch (error) {
    addError(report, { code: "PREVIEW_INVALID_INPUT", stage: "input", message: error instanceof Error ? error.message : "Invalid preview input." });
    return report;
  }

  let inspection: PptxInspection;
  try {
    inspection = await inspectPptx(input.bytes);
    report.slideCount = inspection.slideCount;
    report.font.requested = themeFont(input.bytes);
  } catch (error) {
    addError(report, { code: "PPTX_INVALID", stage: "pptx", message: error instanceof Error ? error.message : "PPTX structural validation failed." });
    return report;
  }

  let previewDirectory: string;
  try {
    previewDirectory = await mkdtemp(join(input.realWorkDir, ".preview-"));
  } catch (error) {
    addError(report, { code: "PREVIEW_INVALID_INPUT", stage: "input", message: error instanceof Error ? error.message : "Cannot create a private preview directory." });
    return report;
  }

  const remainingMs = (): number => Math.max(0, deadline - Date.now());
  const execute = async (stage: PreviewStage, key: "soffice" | "pdfinfo" | "pdftoppm" | "fc-match", standardArgs: string[]): Promise<CommandResult | undefined> => {
    const command = options.commands?.[key] ?? { file: process.env[COMMAND_ENV[key]] || key };
    try {
      return await runCommand(command.file, [...(command.args ?? []), ...standardArgs], remainingMs(), options.signal, options.processGroupId);
    } catch (error) {
      addError(report, failureIssue(stage, error as CommandFailure));
      return undefined;
    }
  };

  const pdfPath = join(previewDirectory, `${basename(input.realPptxPath, extname(input.realPptxPath))}.pdf`);
  const profileDirectory = join(previewDirectory, "lo-profile");
  const profileUri = pathToFileURL(profileDirectory).href;
  const libreOffice = await execute("soffice", "soffice", [
    "--headless",
    "--convert-to", "pdf",
    "--outdir", previewDirectory,
    `-env:UserInstallation=${profileUri}`,
    input.realPptxPath,
  ]);
  if (!libreOffice) return discardPreviewArtifacts(report, previewDirectory);

  try {
    const pdfStat = await lstat(pdfPath);
    if (!pdfStat.isFile() || pdfStat.isSymbolicLink() || pdfStat.size < 5) throw new Error("LibreOffice produced no usable PDF file");
    const pdfHandle = await open(pdfPath, "r");
    try {
      const signature = Buffer.alloc(5);
      const { bytesRead } = await pdfHandle.read(signature, 0, signature.length, 0);
      if (bytesRead !== 5 || signature.toString("ascii") !== "%PDF-") throw new Error("LibreOffice output does not have a PDF signature");
    } finally {
      await pdfHandle.close();
    }
    report.pdfPath = pdfPath;
  } catch (error) {
    addError(report, { code: "PREVIEW_RENDER_FAILED", stage: "pdf", message: error instanceof Error ? error.message : "LibreOffice did not produce a valid PDF." });
    return discardPreviewArtifacts(report, previewDirectory);
  }

  const pdfInfo = await execute("pdfinfo", "pdfinfo", [pdfPath]);
  if (!pdfInfo) return discardPreviewArtifacts(report, previewDirectory);
  const pdfPages = /^Pages:\s+(\d+)\s*$/mu.exec(pdfInfo.stdout)?.[1];
  if (!pdfPages || Number(pdfPages) < 1) {
    addError(report, { code: "PREVIEW_RENDER_FAILED", stage: "pdfinfo", message: "Poppler could not determine the PDF page count." });
    return discardPreviewArtifacts(report, previewDirectory);
  }
  report.pdfPageCount = Number(pdfPages);

  const imagePrefix = join(previewDirectory, "page");
  const poppler = await execute("pdftoppm", "pdftoppm", ["-png", "-r", "110", pdfPath, imagePrefix]);
  if (!poppler) return discardPreviewArtifacts(report, previewDirectory);

  let names: string[];
  let renderedPages: RenderedPageFile[];
  try {
    names = await readdir(previewDirectory);
    renderedPages = sortedPngPages(names, "page-", previewDirectory);
    report.pngPaths = renderedPages.map(({ path }) => path);
  } catch (error) {
    addError(report, { code: "PREVIEW_RENDER_FAILED", stage: "pdftoppm", message: error instanceof Error ? error.message : "Cannot list rendered preview pages." });
    return discardPreviewArtifacts(report, previewDirectory);
  }
  report.pageCount = report.pngPaths.length;
  if (report.pdfPageCount !== inspection.slideCount || report.pageCount !== report.pdfPageCount) {
    const actualPages = report.pdfPageCount !== inspection.slideCount ? report.pdfPageCount : report.pageCount;
    addError(report, {
      code: "PAGE_COUNT_MISMATCH",
      stage: "pages",
      message: `Preview reports ${report.pdfPageCount} PDF pages and ${report.pageCount} rendered PNG pages for a ${inspection.slideCount}-slide PPTX.`,
      expectedPages: inspection.slideCount,
      actualPages,
    });
  }
  const expectedPageNumbers = Array.from({ length: report.pdfPageCount }, (_, index) => index + 1);
  const actualPageNumbers = renderedPages.map(({ pageNumber }) => pageNumber);
  const missingPageNumbers = expectedPageNumbers.filter((pageNumber) => !actualPageNumbers.includes(pageNumber));
  const unexpectedPageNumbers = actualPageNumbers.filter((pageNumber) => !expectedPageNumbers.includes(pageNumber));
  if (missingPageNumbers.length > 0 || unexpectedPageNumbers.length > 0) {
    addError(report, {
      code: "PAGE_SEQUENCE_INVALID",
      stage: "pages",
      message: `Rendered PNG page numbers [${actualPageNumbers.join(", ")}] do not match the PDF page sequence 1..${report.pdfPageCount}.`,
      expectedPages: report.pdfPageCount,
      actualPages: report.pageCount,
      missingPageNumbers,
      unexpectedPageNumbers,
    });
  }
  if (report.pageCount === 0) {
    addError(report, { code: "PREVIEW_RENDER_FAILED", stage: "pdftoppm", message: "Poppler produced no PNG preview pages." });
  }
  if (report.errors.length > 0) return discardPreviewArtifacts(report, previewDirectory);

  try {
    for (const pngPath of report.pngPaths) {
      const imageStat = await lstat(pngPath);
      if (!imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size === 0) throw new Error("Poppler produced an empty or invalid page image");
    }
    report.contactSheetPath = await createContactSheet(report.pngPaths, previewDirectory);
  } catch (error) {
    addError(report, { code: "CONTACT_SHEET_FAILED", stage: "contact-sheet", message: error instanceof Error ? error.message : "Cannot create a preview contact sheet." });
  }

  const fontCheck = await execute("fc-match", "fc-match", ["-f", "%{family[0]}", report.font.requested]);
  if (!fontCheck) {
    const lastError = report.errors.at(-1);
    if (lastError?.stage === "fc-match") {
      report.errors.pop();
      report.warnings.push({
        code: lastError.code === "PREVIEW_TIMEOUT" ? "PREVIEW_TIMEOUT" : "FONT_MATCHER_UNAVAILABLE",
        stage: "fc-match",
        message: lastError.code === "PREVIEW_TIMEOUT" ? "Font selection lookup exceeded the preview deadline." : "fontconfig fc-match is unavailable; selected font was not verified.",
        ...(lastError.stderr ? { stderr: lastError.stderr } : {}),
      });
    }
  } else {
    const selected = fontCheck.stdout.trim().split(/\r?\n/u)[0]?.trim() ?? "";
    if (selected) {
      report.font.selected = selected;
      report.font.substituted = selected.toLocaleLowerCase() !== report.font.requested.toLocaleLowerCase();
      if (report.font.substituted) {
        report.warnings.push({
          code: "FONT_SUBSTITUTED",
          stage: "fc-match",
          message: `fontconfig selected “${selected}” for requested font “${report.font.requested}”.`,
        });
      }
    } else {
      report.warnings.push({ code: "FONT_MATCHER_UNAVAILABLE", stage: "fc-match", message: "fontconfig returned no selected font family." });
    }
  }

  report.status = report.errors.length === 0 ? "ready" : "draft";
  return report.status === "draft" ? discardPreviewArtifacts(report, previewDirectory) : report;
}
