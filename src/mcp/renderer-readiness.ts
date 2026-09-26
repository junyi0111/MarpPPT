import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export interface RendererCommand {
  file: string;
  args: string[];
}

export interface RendererReadinessOptions {
  commands?: Partial<Record<"soffice" | "pdfinfo" | "pdftoppm", RendererCommand>>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

function commandFromEnvironment(name: "soffice" | "pdfinfo" | "pdftoppm"): RendererCommand {
  const variable = name === "soffice" ? "MARPPPT_SOFFICE" : name === "pdfinfo" ? "MARPPPT_PDFINFO" : "MARPPPT_PDFTOPPM";
  return {
    file: process.env[variable] || name,
    args: name === "soffice" ? ["--version"] : ["-v"],
  };
}

function checkCommand(command: RendererCommand, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = nodeSpawn(command.file, command.args, { shell: false, stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      complete(false);
    }, timeoutMs);
    timer.unref?.();
    const complete = (result: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.once("error", () => complete(false));
    child.once("close", (code) => complete(!timedOut && code === 0));
  });
}

export function createRendererReadiness(options: RendererReadinessOptions = {}): () => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000) {
    throw new RangeError("Renderer readiness timeout must be between 50 milliseconds and 10 seconds.");
  }
  const commands = ["soffice", "pdfinfo", "pdftoppm"] as const;
  const selected = commands.map((name) => options.commands?.[name] ?? commandFromEnvironment(name));
  let cached: Promise<boolean> | undefined;
  return () => {
    cached ??= Promise.all(selected.map((command) => checkCommand(command, timeoutMs)))
      .then((results) => results.every(Boolean))
      .catch(() => false);
    return cached;
  };
}
