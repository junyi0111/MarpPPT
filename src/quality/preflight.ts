import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { RendererCommand } from "../mcp/renderer-readiness.js";
import type { LocalPreflightReport, PreflightCommandName, QualityIssue } from "./types.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_FONT = "Noto Sans CJK TC";

export interface LocalPreflightOptions {
  outputRoot: string;
  commands?: Partial<Record<PreflightCommandName, RendererCommand>>;
  mcpEntrypoint?: string;
  requiredFont?: string;
  timeoutMs?: number;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
}

function defaultCommand(name: PreflightCommandName): RendererCommand {
  if (name === "fc-match") return { file: process.env.MARPPPT_FCMATCH || "fc-match", args: ["-f", "%{family}\\n", DEFAULT_FONT] };
  const variable = name === "soffice" ? "MARPPPT_SOFFICE"
    : name === "pdfinfo" ? "MARPPPT_PDFINFO"
      : name === "pdftoppm" ? "MARPPPT_PDFTOPPM"
        : "MARPPPT_PDFTOTEXT";
  return { file: process.env[variable] || name, args: name === "soffice" ? ["--version"] : ["-v"] };
}

function runCommand(command: RendererCommand, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let settled = false;
    let child;
    try {
      child = spawn(command.file, command.args, { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolveResult({ ok: false, stdout });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ ok, stdout: stdout.trim() });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function issue(code: string, message: string, suggestedAction: string, severity: QualityIssue["severity"] = "error"): QualityIssue {
  return { code, severity, message, suggestedAction };
}

export async function runLocalPreflight(options: LocalPreflightOptions): Promise<LocalPreflightReport> {
  const checkedAt = new Date().toISOString();
  const requestedFont = options.requiredFont ?? DEFAULT_FONT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000) throw new RangeError("Preflight timeout must be between 50 milliseconds and 10 seconds.");

  const outputRoot = resolve(options.outputRoot);
  const output = { absolute: isAbsolute(options.outputRoot), directory: false, writable: false };
  const issues: QualityIssue[] = [];
  if (!output.absolute) issues.push(issue("OUTPUT_ROOT_NOT_ABSOLUTE", "輸出目錄必須是絕對路徑，才能可靠支援外接磁碟與重開驗證。", "請提供 /Volumes/... 或其他絕對輸出路徑。"));
  try {
    await mkdir(outputRoot, { recursive: true });
    const info = await stat(outputRoot);
    output.directory = info.isDirectory();
    if (!output.directory) issues.push(issue("OUTPUT_ROOT_NOT_DIRECTORY", "輸出路徑不是目錄。", "請改用可建立或已存在的目錄。"));
    else {
      await access(outputRoot, constants.W_OK);
      output.writable = true;
    }
  } catch {
    issues.push(issue("OUTPUT_ROOT_NOT_WRITABLE", "輸出目錄不存在或目前不可寫入。", "請檢查磁碟掛載、權限與剩餘空間。"));
  }

  const nodeSupported = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 22;
  const node = { version: process.version, supported: nodeSupported };
  if (!nodeSupported) issues.push(issue("NODE_UNSUPPORTED", `目前 Node.js ${process.version} 不符合套件要求。`, "請安裝 Node.js 22 或更新版本。"));

  const entrypoint = options.mcpEntrypoint ?? resolve(process.cwd(), "dist/mcp/stdio.js");
  let mcpAvailable = false;
  try { mcpAvailable = (await stat(entrypoint)).isFile(); } catch { /* reported below */ }
  const mcp = { entrypoint, available: mcpAvailable };
  if (!mcpAvailable) issues.push(issue("MCP_ENTRYPOINT_MISSING", "找不到已建置的 MCP 入口，不能宣稱安裝後可直接使用。", "先執行套件建置並確認 dist/mcp/stdio.js 存在。"));

  const rendererNames = ["soffice", "pdfinfo", "pdftoppm", "pdftotext"] as const;
  const rendererResults = await Promise.all(rendererNames.map(async (name) => [name, await runCommand(options.commands?.[name] ?? defaultCommand(name), timeoutMs)] as const));
  const renderers = Object.fromEntries(rendererResults.map(([name, result]) => [name, { available: result.ok }])) as LocalPreflightReport["renderers"];
  for (const [name, result] of rendererResults) if (!result.ok) issues.push(issue(`${name.toUpperCase()}_MISSING`, `找不到或無法執行 ${name}，無法完成正式預覽驗證。`, `請安裝 ${name}，或在目前環境先使用草稿模式。`));

  const fontCommand = options.commands?.["fc-match"] ?? { ...defaultCommand("fc-match"), args: ["-f", "%{family}\\n", requestedFont] };
  const fontResult = await runCommand(fontCommand, timeoutMs);
  const matched = fontResult.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
  const fontAvailable = fontResult.ok && Boolean(matched && matched.toLocaleLowerCase().includes(requestedFont.toLocaleLowerCase()));
  const font = { requested: requestedFont, matched, available: fontAvailable };
  if (!fontAvailable) issues.push(issue("FONT_NOT_MATCHED", `沒有確認到要求的實際字型 family：${requestedFont}。`, `請安裝 ${requestedFont}，或明確交付為字型未驗證的草稿。`));

  const status = issues.some((entry) => entry.severity === "error") ? "failed" : "passed";
  return { status, checkedAt, outputRoot, node, mcp, output, renderers, font, issues };
}
