import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { getFontPreset, type FontDownload, type FontPreset } from "./font-presets.js";

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const FONT_COMMAND_TIMEOUT_MS = 3_000;
const FONT_MAGIC = ["00010000", "4f54544f", "74727565", "74797031"];
const DEFAULT_DOWNLOAD_HOSTS = new Set(["raw.githubusercontent.com", "github.com"]);

export type FontInstallStatus = "available" | "installed" | "missing" | "unsupported";

export interface FontInstallRequest {
  themeId: string;
  installIfMissing: boolean;
}

export interface FontInstallReport {
  status: FontInstallStatus;
  themeId: string;
  family: string;
  platform: NodeJS.Platform;
  installDirectory: string | null;
  files: string[];
  matched: string | null;
  verified: boolean;
  message: string;
  userAction?: string;
}

export interface FontInstallerDependencies {
  platform?: NodeJS.Platform;
  homeDir?: string;
  environment?: NodeJS.ProcessEnv;
  fontDirectory?: string;
  fetch?: typeof fetch;
  matchFont?: (family: string) => Promise<string | null>;
  refreshFontCache?: () => Promise<void>;
  downloadHostAllowlist?: ReadonlySet<string>;
}

export interface FontInstaller {
  ensure(request: FontInstallRequest): Promise<FontInstallReport>;
}

function userFontDirectory(platform: NodeJS.Platform, home: string, environment: NodeJS.ProcessEnv): string | null {
  if (platform === "darwin") return join(home, "Library", "Fonts");
  if (platform === "linux") return join(environment.XDG_DATA_HOME || join(home, ".local", "share"), "fonts", "marpppt");
  return null;
}

function allowedHost(host: string, allowlist: ReadonlySet<string>): boolean {
  return [...allowlist].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function validFontBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic = Buffer.from(bytes.subarray(0, 4)).toString("hex").toLowerCase();
  return FONT_MAGIC.includes(magic);
}

function safeFileName(value: string): string {
  const fileName = basename(value).replace(/[^A-Za-z0-9._-]/gu, "_");
  if (!fileName || fileName === "." || fileName === ".." || fileName.length > 160) throw new Error("FONT_FILE_NAME_INVALID");
  return fileName;
}

async function runCommand(file: string, args: string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(file, args, { shell: false, stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, FONT_COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function defaultMatchFont(family: string): Promise<string | null> {
  return await new Promise((resolve) => {
    let output = "";
    let settled = false;
    let child;
    try {
      child = spawn("fc-match", ["-f", "%{family}\n", family], { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, FONT_COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code === 0 ? output.trim().split(/\r?\n/u).find(Boolean) ?? null : null));
  });
}

async function defaultRefreshFontCache(): Promise<void> {
  await runCommand("fc-cache", ["-f"]);
}

function matchesFamily(matched: string | null, requested: string): boolean {
  return Boolean(matched && matched.toLocaleLowerCase().includes(requested.toLocaleLowerCase()));
}

async function readResponse(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`FONT_DOWNLOAD_FAILED: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_DOWNLOAD_BYTES) throw new Error("FONT_DOWNLOAD_TOO_LARGE");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("FONT_DOWNLOAD_EMPTY");
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("FONT_DOWNLOAD_TOO_LARGE");
  return bytes;
}

interface FontPayload {
  fileName: string;
  bytes: Uint8Array;
}

function payloadsFromArchive(bytes: Uint8Array, source: FontDownload): FontPayload[] {
  const files = unzipSync(bytes);
  const matcher = source.entryPattern ? new RegExp(source.entryPattern, "u") : /\.(?:otf|ttf)$/iu;
  const payloads = Object.entries(files)
    .filter(([entry, value]) => matcher.test(entry) && /\.(?:otf|ttf)$/iu.test(entry) && value.length > 0)
    .map(([entry, value]) => ({ fileName: safeFileName(entry), bytes: value }));
  if (!payloads.length) throw new Error("FONT_ARCHIVE_NO_FONTS");
  if (payloads.some((payload) => !validFontBytes(payload.bytes))) throw new Error("FONT_ARCHIVE_INVALID_FONT");
  return payloads.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

async function downloadPayloads(preset: FontPreset, dependencies: Required<Pick<FontInstallerDependencies, "fetch" | "downloadHostAllowlist">>): Promise<FontPayload[]> {
  const payloads: FontPayload[] = [];
  for (const source of preset.downloads) {
    const parsed = new URL(source.url);
    if (parsed.protocol !== "https:" || !allowedHost(parsed.hostname, dependencies.downloadHostAllowlist)) throw new Error("FONT_DOWNLOAD_HOST_NOT_ALLOWED");
    const response = await dependencies.fetch(source.url, { redirect: "follow" });
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== "https:" || !allowedHost(finalUrl.hostname, dependencies.downloadHostAllowlist)) throw new Error("FONT_DOWNLOAD_REDIRECT_NOT_ALLOWED");
    }
    const bytes = await readResponse(response);
    if (source.kind === "font") {
      if (!validFontBytes(bytes)) throw new Error("FONT_DOWNLOAD_INVALID_FONT");
      payloads.push({ fileName: safeFileName(source.fileName ?? `${preset.id}.font`), bytes });
    } else {
      payloads.push(...payloadsFromArchive(bytes, source));
    }
  }
  return payloads;
}

async function writePayloads(directory: string, payloads: FontPayload[]): Promise<string[]> {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const files: string[] = [];
  for (const payload of payloads) {
    const fileName = safeFileName(payload.fileName);
    const target = join(directory, fileName);
    const temporary = join(directory, `.marpppt-${randomUUID()}-${fileName}.tmp`);
    await writeFile(temporary, payload.bytes, { mode: 0o644 });
    await rename(temporary, target);
    files.push(fileName);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function createFontInstaller(options: FontInstallerDependencies = {}): FontInstaller {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const environment = options.environment ?? process.env;
  const directory = options.fontDirectory ?? userFontDirectory(platform, home, environment);
  const fetchImpl = options.fetch ?? fetch;
  const matchFont = options.matchFont ?? defaultMatchFont;
  const refreshFontCache = options.refreshFontCache ?? defaultRefreshFontCache;
  const downloadHostAllowlist = options.downloadHostAllowlist ?? DEFAULT_DOWNLOAD_HOSTS;

  return {
    async ensure(request) {
      const preset = getFontPreset(request.themeId);
      const matchedBefore = await matchFont(preset.family);
      if (matchesFamily(matchedBefore, preset.family)) {
        return {
          status: "available",
          themeId: preset.id,
          family: preset.family,
          platform,
          installDirectory: directory,
          files: [],
          matched: matchedBefore,
          verified: true,
          message: `字體已存在：${preset.family}`,
        };
      }
      if (!request.installIfMissing) {
        return {
          status: "missing",
          themeId: preset.id,
          family: preset.family,
          platform,
          installDirectory: directory,
          files: [],
          matched: matchedBefore,
          verified: false,
          message: `找不到字體：${preset.family}`,
          userAction: `請使用 ensure_font 並設定 installIfMissing=true，或手動安裝 ${preset.label}。`,
        };
      }
      if (!directory || (platform !== "darwin" && platform !== "linux")) {
        return {
          status: "unsupported",
          themeId: preset.id,
          family: preset.family,
          platform,
          installDirectory: directory,
          files: [],
          matched: matchedBefore,
          verified: false,
          message: `目前平台 ${platform} 不支援由 MarpPPT 自動安裝字體。`,
          userAction: `請從 ${preset.sourceUrl} 下載 ${preset.label}，安裝後重新啟動 PowerPoint。`,
        };
      }
      const payloads = await downloadPayloads(preset, { fetch: fetchImpl, downloadHostAllowlist });
      const files = await writePayloads(directory, payloads);
      await refreshFontCache();
      const matchedAfter = await matchFont(preset.family);
      return {
        status: "installed",
        themeId: preset.id,
        family: preset.family,
        platform,
        installDirectory: directory,
        files,
        matched: matchedAfter,
        verified: matchesFamily(matchedAfter, preset.family),
        message: matchesFamily(matchedAfter, preset.family)
          ? `已安裝並確認字體：${preset.family}`
          : `已寫入字體檔，但目前尚未從 fontconfig 確認：${preset.family}`,
        userAction: matchesFamily(matchedAfter, preset.family) ? "請重新執行 preflight，再開始渲染。" : "請重新啟動 Codex／PowerPoint 後重新執行 preflight。",
      };
    },
  };
}
