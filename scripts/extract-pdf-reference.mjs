import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

function parseArgs(args) {
  const options = { file: undefined, page: undefined, from: undefined, to: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--file") options.file = value;
    else if (flag === "--page") options.page = Number(value);
    else if (flag === "--from") options.from = Number(value);
    else if (flag === "--to") options.to = Number(value);
    else throw new Error(`Unsupported option: ${flag}`);
    index += 1;
  }
  if (!options.file) throw new Error("Specify --file <absolute-pdf-path>.");
  if (options.page !== undefined && (options.from !== undefined || options.to !== undefined)) {
    throw new Error("Use --page or --from/--to, not both.");
  }
  if ((options.from === undefined) !== (options.to === undefined)) {
    throw new Error("Specify both --from and --to for a page range.");
  }
  for (const page of [options.page, options.from, options.to]) {
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 1)) {
      throw new Error("Page numbers must be positive integers.");
    }
  }
  if (options.from !== undefined && options.from > options.to) {
    throw new Error("The --from page must not exceed --to.");
  }
  return options;
}

async function extract(options) {
  const inputPath = resolve(options.file);
  const info = await stat(inputPath);
  if (!info.isFile() || info.size < 1 || info.size > MAX_PDF_BYTES) {
    throw new Error("PDF must be a non-empty regular file no larger than 256 MiB.");
  }
  const args = ["-layout"];
  if (options.page !== undefined) args.push("-f", String(options.page), "-l", String(options.page));
  else if (options.from !== undefined) args.push("-f", String(options.from), "-l", String(options.to));
  args.push(inputPath, "-");

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("pdftotext", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let timedOut = false;
    let outputTooLarge = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGTERM");
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errorBytes < 32_768) {
        const accepted = chunk.subarray(0, 32_768 - errorBytes);
        stderr.push(accepted);
        errorBytes += accepted.length;
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        rejectPromise(new Error("Poppler pdftotext is unavailable. Install or enable Poppler, which MarpPPT also uses for local preview."));
      } else rejectPromise(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return rejectPromise(new Error("PDF text extraction exceeded the 60-second limit."));
      if (outputTooLarge) return rejectPromise(new Error("Extracted PDF text exceeded the 8 MiB output limit; select fewer pages."));
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        return rejectPromise(new Error(`pdftotext failed${detail ? `: ${detail}` : ` with exit code ${code}`}`));
      }
      resolvePromise(Buffer.concat(stdout));
    });
  }).then((output) => process.stdout.write(output));
}

try {
  await extract(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
