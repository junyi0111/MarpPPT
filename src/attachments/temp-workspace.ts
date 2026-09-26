import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempWorkspace {
  path: string;
  writeFile(fileName: string, bytes: Uint8Array): Promise<string>;
  cleanup(): Promise<void>;
}

export interface TempWorkspaceOptions {
  root?: string;
}

const SAFE_SERVER_FILE = /^[A-Za-z0-9_-]{1,80}\.(?:md|png|jpe?g)$/i;

export function getDefaultTempWorkspaceRoot(): string {
  return join(tmpdir(), `marp-ppt-private-${process.getuid?.() ?? "local"}`);
}

function jobWorkspacePrefix(jobId: string): string {
  return `job-${createHash("sha256").update(jobId).digest("hex").slice(0, 20)}-`;
}

async function ensurePrivateRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Temporary workspace root must be a private directory owned by the current user");
  }
}

export async function createTempWorkspace(jobId: string, options: TempWorkspaceOptions = {}): Promise<TempWorkspace> {
  if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 256) {
    throw new Error("A non-empty bounded job ID is required");
  }
  const root = options.root ?? getDefaultTempWorkspaceRoot();
  await ensurePrivateRoot(root);
  const workspacePath = await mkdtemp(join(root, jobWorkspacePrefix(jobId)));
  let cleaned = false;

  return {
    path: workspacePath,
    async writeFile(fileName, bytes) {
      if (!SAFE_SERVER_FILE.test(fileName)) throw new Error("Unsafe server-generated temporary filename");
      const path = join(workspacePath, fileName);
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return path;
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      const stat = await lstat(workspacePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw new Error("Temporary workspace changed type before cleanup");
      }
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}

export async function cleanupTempWorkspacesForJobId(jobId: string, options: TempWorkspaceOptions = {}): Promise<void> {
  if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 256) throw new Error("A non-empty bounded job ID is required");
  const root = options.root ?? getDefaultTempWorkspaceRoot();
  await ensurePrivateRoot(root);
  const realRoot = await realpath(root);
  const prefix = jobWorkspacePrefix(jobId);
  const names = await readdir(realRoot);
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(realRoot, name);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || (process.getuid && stat.uid !== process.getuid())
        || (stat.mode & 0o077) !== 0) {
      throw new Error("Temporary workspace changed type or permissions before cleanup");
    }
    await rm(path, { recursive: true, force: true });
  }
}

export async function withTempWorkspace<T>(
  jobId: string,
  fn: (workspace: TempWorkspace) => Promise<T>,
  options: TempWorkspaceOptions = {},
): Promise<T> {
  const workspace = await createTempWorkspace(jobId, options);
  try {
    return await fn(workspace);
  } finally {
    await workspace.cleanup();
  }
}
