import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import type { ProbeFileRef } from "./attachment-reference.js";

const ROOT = join(tmpdir(), `marpppt-attachments-${process.getuid?.() ?? "local"}`);
const MAX_MARKDOWN = 2 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_IMAGES = 30;
const LIFETIME_MS = 30 * 60_000;
const ID = /^[a-f0-9]{32}$/;

async function startJobReaper(jobDir: string, delayMs: number): Promise<void> {
  const reaper = spawn(process.execPath, [
    "-e",
    "setTimeout(async()=>{const {rm}=await import('node:fs/promises');await rm(process.argv[1],{recursive:true,force:true})},Number(process.argv[2]))",
    jobDir,
    String(delayMs),
  ], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    reaper.once("spawn", resolve);
    reaper.once("error", reject);
  });
  reaper.unref();
}

interface StagedFile {
  id: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
}

interface Manifest {
  version: 1;
  jobId: string;
  expiresAt: number;
  files: StagedFile[];
  mac: string;
}

export interface StagedAttachments {
  jobId: string;
  sourceFile: ProbeFileRef;
  imageFiles: ProbeFileRef[];
  imageAssetIds: string[];
  expiresAt: number;
}

function id(): string {
  return randomBytes(16).toString("hex");
}

function fileRef(jobId: string, file: StagedFile): ProbeFileRef {
  return { fileName: file.fileName, mimeType: file.mimeType, assetId: `stage:${jobId}:${file.id}` };
}

function assertJobId(jobId: string): void {
  if (!ID.test(jobId)) throw new Error("Invalid staged attachment ID");
}

export function stagedJobDirectory(jobId: string): string {
  assertJobId(jobId);
  return join(ROOT, jobId);
}

async function ensureRoot(): Promise<void> {
  await mkdir(ROOT, { mode: 0o700, recursive: true });
  const stat = await lstat(ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Attachment staging root is not private");
  }
}

async function assertPrivateJobDirectory(jobDir: string): Promise<void> {
  const stat = await lstat(jobDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Staged attachment job directory is not private");
  }
}

async function readRegularFile(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
      throw new Error("Attachment is empty, too large, or not a regular file");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximum) throw new Error("Attachment exceeds its size limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const finalStat = await handle.stat();
    if (total !== stat.size || finalStat.size !== stat.size) throw new Error("Attachment changed while reading");
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function validateSource(bytes: Buffer, fileName: string): void {
  if (!fileName.toLowerCase().endsWith(".md")) throw new Error("Source must be a Markdown .md file");
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function imageMime(bytes: Buffer, fileName: string): Promise<string> {
  const lower = fileName.toLowerCase();
  let mimeType: string;
  if (lower.endsWith(".png") && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = "image/png";
  } else if ((lower.endsWith(".jpg") || lower.endsWith(".jpeg")) &&
      bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    mimeType = "image/jpeg";
  } else {
    throw new Error("Image must be a PNG or JPEG with matching file bytes");
  }
  try {
    const image = sharp(bytes, { limitInputPixels: 100_000_000 });
    const metadata = await image.metadata();
    if (metadata.format !== (mimeType === "image/png" ? "png" : "jpeg")) throw new Error("format mismatch");
    await image.stats();
  } catch {
    throw new Error("Image bytes are damaged or unsupported");
  }
  return mimeType;
}

function safeName(path: string): string {
  const name = basename(path);
  if (!name || name === "." || name === ".." || name.length > 255 || /[\x00-\x1f/\\]/u.test(name)) {
    throw new Error("Invalid attachment name");
  }
  return name;
}

function manifestBody(manifest: Omit<Manifest, "mac">): string {
  return JSON.stringify(manifest);
}

async function signingKey(): Promise<Buffer> {
  await ensureRoot();
  const keyPath = join(ROOT, "signing-key");
  const pendingPath = join(ROOT, `signing-key.${id()}`);
  try {
    const handle = await open(pendingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(randomBytes(32));
    } finally {
      await handle.close();
    }
    await link(pendingPath, keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await rm(pendingPath, { force: true });
  }
  const keyStat = await lstat(keyPath);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || (keyStat.mode & 0o077) !== 0 ||
      (process.getuid && keyStat.uid !== process.getuid())) {
    throw new Error("Attachment signing key is not private");
  }
  const key = await readRegularFile(keyPath, 32);
  if (key.length !== 32) throw new Error("Invalid attachment signing key");
  return key;
}

function mac(body: string, key: Buffer): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

async function copyAttachment(path: string, jobDir: string, maximum: number, source: boolean): Promise<StagedFile> {
  const fileName = safeName(path);
  const bytes = await readRegularFile(path, maximum);
  const mimeType = source ? (validateSource(bytes, fileName), "text/markdown") : await imageMime(bytes, fileName);
  const assetId = id();
  await writeFile(join(jobDir, assetId), bytes, { flag: "wx", mode: 0o600 });
  return {
    id: assetId,
    fileName,
    mimeType,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function stageAttachments(
  input: { sourcePath: string; imagePaths: string[] },
  options: { retentionMs?: number } = {},
): Promise<StagedAttachments> {
  if (!Array.isArray(input.imagePaths) || input.imagePaths.length > MAX_IMAGES) {
    throw new Error("Too many images");
  }
  const retentionMs = options.retentionMs ?? LIFETIME_MS;
  if (!Number.isInteger(retentionMs) || retentionMs < 1 || retentionMs > LIFETIME_MS) {
    throw new Error("Invalid attachment retention period");
  }
  const key = await signingKey();
  const jobId = id();
  const jobDir = stagedJobDirectory(jobId);
  const workingDir = join(ROOT, `.staging-${jobId}`);
  await mkdir(workingDir, { mode: 0o700 });
  let published = false;
  try {
    const source = await copyAttachment(input.sourcePath, workingDir, MAX_MARKDOWN, true);
    const images: StagedFile[] = [];
    let total = source.byteLength;
    for (const imagePath of input.imagePaths) {
      const image = await copyAttachment(imagePath, workingDir, MAX_IMAGE, false);
      total += image.byteLength;
      if (total > MAX_TOTAL) throw new Error("Attachments exceed 50 MB total");
      images.push(image);
    }
    const body: Omit<Manifest, "mac"> = {
      version: 1,
      jobId,
      expiresAt: Date.now() + retentionMs,
      files: [source, ...images],
    };
    const manifest: Manifest = { ...body, mac: mac(manifestBody(body), key) };
    await writeFile(join(workingDir, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await rename(workingDir, jobDir);
    published = true;
    await startJobReaper(jobDir, Math.max(1, body.expiresAt - Date.now()));
    const imageFiles = images.map((image) => fileRef(jobId, image));
    return {
      jobId,
      sourceFile: fileRef(jobId, source),
      imageFiles,
      imageAssetIds: imageFiles.map((image) => image.assetId!),
      expiresAt: body.expiresAt,
    };
  } catch (error) {
    await rm(workingDir, { recursive: true, force: true });
    if (published) await rm(jobDir, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(bytes: Buffer, jobId: string, key: Buffer): Manifest {
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid staged attachment manifest");
  const manifest = parsed as Manifest;
  if (manifest.version !== 1 || manifest.jobId !== jobId || !Number.isFinite(manifest.expiresAt) ||
      !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_IMAGES + 1 ||
      typeof manifest.mac !== "string" || !/^[a-f0-9]{64}$/.test(manifest.mac)) {
    throw new Error("Invalid staged attachment manifest");
  }
  const { mac: signature, ...body } = manifest;
  const expected = Buffer.from(mac(manifestBody(body), key), "hex");
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
    throw new Error("Staged attachment manifest was altered");
  }
  return manifest;
}

export async function readStagedAttachment(ref: ProbeFileRef, now = Date.now()): Promise<Uint8Array> {
  if (Object.keys(ref).sort().join(",") !== "assetId,fileName,mimeType" || typeof ref.assetId !== "string") {
    throw new Error("Staged attachment reference has unsupported fields");
  }
  const match = /^stage:([a-f0-9]{32}):([a-f0-9]{32})$/.exec(ref.assetId);
  if (!match) throw new Error("Invalid staged attachment ID");
  const [, jobId, assetId] = match;
  const jobDir = stagedJobDirectory(jobId!);
  const key = await signingKey();
  await assertPrivateJobDirectory(jobDir);
  const manifest = parseManifest(await readRegularFile(join(jobDir, "manifest.json"), 16_384), jobId!, key);
  if (now >= manifest.expiresAt) {
    await removeStagedJob(jobId!);
    throw new Error("Staged attachment has expired");
  }
  const file = manifest.files.find((candidate) => candidate.id === assetId);
  if (!file || file.fileName !== ref.fileName || file.mimeType !== ref.mimeType) {
    throw new Error("Staged attachment reference does not match manifest");
  }
  const maximum = file.mimeType === "text/markdown" ? MAX_MARKDOWN : MAX_IMAGE;
  const bytes = await readRegularFile(join(jobDir, file.id), maximum);
  if (bytes.length !== file.byteLength || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    throw new Error("Staged attachment bytes were altered");
  }
  if (file.mimeType === "text/markdown") validateSource(bytes, file.fileName);
  else if (await imageMime(bytes, file.fileName) !== file.mimeType) throw new Error("Staged image type changed");
  return bytes;
}

export async function removeStagedJob(jobId: string): Promise<void> {
  await rm(stagedJobDirectory(jobId), { recursive: true, force: true });
}

export async function cleanExpiredStagedJobs(now = Date.now()): Promise<void> {
  await ensureRoot();
  const key = await signingKey();
  for (const jobId of await readdir(ROOT)) {
    if (/^signing-key\.[a-f0-9]{32}$/.test(jobId)) {
      const pendingPath = join(ROOT, jobId);
      try {
        const stat = await lstat(pendingPath);
        if (now - stat.mtimeMs >= LIFETIME_MS) await unlink(pendingPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (/^\.staging-[a-f0-9]{32}$/.test(jobId)) {
      const workingDir = join(ROOT, jobId);
      try {
        const stat = await lstat(workingDir);
        if (now - stat.mtimeMs >= LIFETIME_MS) await rm(workingDir, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (!ID.test(jobId)) continue;
    try {
      const manifest = parseManifest(await readRegularFile(join(stagedJobDirectory(jobId), "manifest.json"), 16_384), jobId, key);
      if (now >= manifest.expiresAt) await removeStagedJob(jobId);
    } catch {
      await removeStagedJob(jobId);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let sourcePath: string | undefined;
  const imagePaths: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || (flag !== "--source" && flag !== "--image")) throw new Error("Usage: --source file.md [--image file.png ...]");
    if (flag === "--source") {
      if (sourcePath) throw new Error("Provide exactly one source Markdown file");
      sourcePath = value;
    } else imagePaths.push(value);
  }
  if (!sourcePath) throw new Error("Provide one source Markdown file");
  await cleanExpiredStagedJobs();
  process.stdout.write(JSON.stringify(await stageAttachments({ sourcePath, imagePaths })) + "\n");
}
