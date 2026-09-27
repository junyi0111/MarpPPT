import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PageSelector } from "./source-contracts.js";

export const MAX_PDF_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_TEXT_BYTES = 4 * 1024 * 1024;
export const PDF_TEXT_TIMEOUT_MS = 60_000;

export type PdfTextErrorCode =
  | "PDF_INVALID"
  | "PDF_EXTRACTOR_UNAVAILABLE"
  | "PDF_EXTRACT_FAILED"
  | "PDF_EXTRACT_TIMEOUT"
  | "PDF_EXTRACT_OUTPUT_LIMIT";

export class PdfTextError extends Error {
  readonly code: PdfTextErrorCode;

  constructor(code: PdfTextErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PdfTextError";
    this.code = code;
  }
}

export interface PdfTextRunnerContext {
  signal: AbortSignal;
  maxOutputBytes: number;
}

export type PdfTextRunner = (
  filePath: string,
  args: string[],
  context: PdfTextRunnerContext,
) => Promise<Buffer>;

export interface PdfTextOptions {
  tempRoot?: string;
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  run?: PdfTextRunner;
}

function validPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5
    && Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 5)).equals(Buffer.from("%PDF-", "ascii"));
}

function pageArgs(pageRange: PageSelector | undefined): string[] {
  if (!pageRange) return [];
  if ("page" in pageRange) return ["-f", String(pageRange.page), "-l", String(pageRange.page)];
  return ["-f", String(pageRange.from), "-l", String(pageRange.to)];
}

async function runPdfTextCommand(
  filePath: string,
  args: string[],
  context: PdfTextRunnerContext,
  command: string,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (error: PdfTextError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finish = (output: Buffer) => {
      if (settled) return;
      settled = true;
      resolve(output);
    };
    const abort = () => {
      child.kill("SIGTERM");
      fail(new PdfTextError("PDF_EXTRACT_TIMEOUT", "PDF text extraction exceeded its time limit."));
    };
    if (context.signal.aborted) {
      abort();
      return;
    }
    context.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > context.maxOutputBytes) {
        child.kill("SIGTERM");
        fail(new PdfTextError("PDF_EXTRACT_OUTPUT_LIMIT", "Extracted PDF text exceeded its output limit."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).byteLength < 32 * 1024) stderr.push(chunk.subarray(0, 32 * 1024));
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      fail(new PdfTextError(
        error.code === "ENOENT" ? "PDF_EXTRACTOR_UNAVAILABLE" : "PDF_EXTRACT_FAILED",
        error.code === "ENOENT" ? "Poppler pdftotext is unavailable." : "The PDF text extractor could not start.",
        { cause: error },
      ));
    });
    child.once("close", (code) => {
      context.signal.removeEventListener("abort", abort);
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        fail(new PdfTextError("PDF_EXTRACT_FAILED", `pdftotext failed${detail ? `: ${detail}` : ` with exit code ${code}`}`));
        return;
      }
      finish(Buffer.concat(stdout, outputBytes));
    });
  });
}

export async function extractPdfText(
  bytes: Uint8Array,
  pageRange?: PageSelector,
  options: PdfTextOptions = {},
): Promise<string> {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_PDF_TEXT_BYTES;
  const timeoutMs = options.timeoutMs ?? PDF_TEXT_TIMEOUT_MS;
  if (!validPdf(bytes) || bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfTextError("PDF_INVALID", "The PDF is empty, oversized, or does not have a valid PDF signature.");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_PDF_TEXT_BYTES) {
    throw new RangeError("PDF text output limit is outside the supported range.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PDF_TEXT_TIMEOUT_MS) {
    throw new RangeError("PDF extraction timeout is outside the supported range.");
  }
  const root = options.tempRoot ?? tmpdir();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(join(root, "marpppt-pdf-"));
  const filePath = join(workDir, "input.pdf");
  await writeFile(filePath, bytes, { mode: 0o600 });
  const args = ["-layout", ...pageArgs(pageRange), filePath, "-"];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const run = options.run ?? ((path, commandArgs, context) => runPdfTextCommand(path, commandArgs, context, options.command ?? "pdftotext"));
    let output: Buffer;
    try {
      output = await run(filePath, args, { signal: controller.signal, maxOutputBytes });
    } catch (error) {
      if (error instanceof PdfTextError) throw error;
      if (controller.signal.aborted) throw new PdfTextError("PDF_EXTRACT_TIMEOUT", "PDF text extraction exceeded its time limit.", { cause: error });
      throw new PdfTextError("PDF_EXTRACT_FAILED", "The PDF text extractor failed.", { cause: error });
    }
    if (output.byteLength > maxOutputBytes) throw new PdfTextError("PDF_EXTRACT_OUTPUT_LIMIT", "Extracted PDF text exceeded its output limit.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(output);
    } catch (error) {
      throw new PdfTextError("PDF_EXTRACT_FAILED", "The PDF text extractor returned invalid UTF-8.", { cause: error });
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    await rm(workDir, { recursive: true, force: true });
  }
}
