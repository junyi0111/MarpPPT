import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { link, lstat, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ArtifactStoreError,
  SERVER_JOB_ID_PATTERN,
  assertServerArtifactIdentity,
  type ArtifactRef,
  type ArtifactStore,
} from "./artifact-store.js";

export interface LocalArtifactStoreOptions {
  outputRoot?: string;
}

export interface LocalArtifactStore extends ArtifactStore {
  readonly outputRoot: string;
}

function configuredRoot(options: LocalArtifactStoreOptions): string {
  const root = options.outputRoot ?? process.env.PPTX_OUTPUT_ROOT ?? join(homedir(), ".marpppt", "artifacts");
  if (!root || !isAbsolute(root)) {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "Configure PPTX_OUTPUT_ROOT as an absolute output directory.");
  }
  return root;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.getuid && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0) {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The configured artifact directory must be a real directory owned by this user.");
  }
}

export async function createLocalArtifactStore(options: LocalArtifactStoreOptions = {}): Promise<LocalArtifactStore> {
  const requestedRoot = configuredRoot(options);
  await ensurePrivateDirectory(requestedRoot);
  const outputRoot = await realpath(requestedRoot);

  return {
    outputRoot,
    async put(jobId, fileName, mimeType, bytes): Promise<ArtifactRef> {
      assertServerArtifactIdentity(jobId, fileName, mimeType);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "Artifact content must be a non-empty byte array.");
      }

      const jobPath = join(outputRoot, jobId);
      let createdJobDirectory = false;
      try {
        try {
          await mkdir(jobPath, { mode: 0o700 });
          createdJobDirectory = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const jobStat = await lstat(jobPath);
        if (!jobStat.isDirectory() || jobStat.isSymbolicLink()
            || (process.getuid && jobStat.uid !== process.getuid())) {
          throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The artifact job directory is not a private directory.");
        }
        const realJobPath = await realpath(jobPath);
        if (realJobPath !== join(outputRoot, jobId)) {
          throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The artifact job directory escaped the configured output root.");
        }

        const temporaryPath = join(jobPath, `.publish-${randomUUID()}`);
        const destinationPath = join(jobPath, fileName);
        const handle = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporaryPath, destinationPath);
        } finally {
          await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        const directoryHandle = await open(jobPath, constants.O_RDONLY);
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
        return { fileName, mimeType, uri: pathToFileURL(destinationPath).href, expiresAt: null };
      } catch (error) {
        if (createdJobDirectory) await rm(jobPath, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof ArtifactStoreError) throw error;
        throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The artifact could not be written below the configured output directory.", { cause: error });
      }
    },
    async deleteJob(jobId) {
      if (!SERVER_JOB_ID_PATTERN.test(jobId)) return;
      const jobPath = join(outputRoot, jobId);
      const stat = await lstat(jobPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) return;
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The artifact job directory changed type before cleanup.");
      }
      await rm(jobPath, { recursive: true, force: true });
    },
  };
}
