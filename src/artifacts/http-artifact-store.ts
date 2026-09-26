import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArtifactStoreError,
  HTTP_ARTIFACT_TTL_MS,
  assertServerArtifactIdentity,
  type ArtifactDownload,
  type ArtifactRef,
  type ArtifactStore,
  type HttpArtifactStore,
} from "./artifact-store.js";

export interface HttpArtifactStoreOptions {
  localStore: ArtifactStore;
  publicBaseUrl: string;
  now?: () => number;
  cleanupIntervalMs?: number;
}

interface TokenRecord {
  jobId: string;
  localUri: string;
  fileName: string;
  mimeType: string;
  expiresAtMs: number;
}

function validateBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "Configure a valid public HTTP(S) artifact origin.", { cause: error });
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "Configure an HTTP(S) artifact origin without credentials, path, query, or fragment.");
  }
  return parsed.origin;
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function validToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(token);
}

export function createHttpArtifactStore(options: HttpArtifactStoreOptions): HttpArtifactStore {
  const baseUrl = validateBaseUrl(options.publicBaseUrl);
  const now = options.now ?? Date.now;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
  if (!Number.isInteger(cleanupIntervalMs) || cleanupIntervalMs < 1_000 || cleanupIntervalMs > 5 * 60_000) {
    throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "Artifact token cleanup interval must be between 1 second and 5 minutes.");
  }
  const tokens = new Map<string, TokenRecord>();
  const expiredTokens = new Map<string, number>();
  const timer = setInterval(() => { void pruneExpired(); }, cleanupIntervalMs);
  timer.unref?.();
  let closed = false;

  async function pruneExpired(): Promise<void> {
    const timestamp = now();
    for (const [token, record] of tokens) {
      if (record.expiresAtMs <= timestamp) {
        tokens.delete(token);
        expiredTokens.set(token, record.expiresAtMs + HTTP_ARTIFACT_TTL_MS);
      }
    }
    for (const [token, tombstoneExpiry] of expiredTokens) {
      if (tombstoneExpiry <= timestamp) expiredTokens.delete(token);
    }
  }

  function findRecord(token: string): TokenRecord {
    if (!validToken(token)) throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact download token was not found.");
    const record = tokens.get(token);
    if (!record) {
      if (expiredTokens.has(token)) throw new ArtifactStoreError("ARTIFACT_EXPIRED", "Artifact download token has expired. The saved local output remains available.");
      throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "Artifact download token was not found.");
    }
    if (record.expiresAtMs <= now()) {
      tokens.delete(token);
      expiredTokens.set(token, record.expiresAtMs + HTTP_ARTIFACT_TTL_MS);
      throw new ArtifactStoreError("ARTIFACT_EXPIRED", "Artifact download token has expired. The saved local output remains available.");
    }
    return record;
  }

  async function readRecord(token: string): Promise<ArtifactDownload> {
    const record = findRecord(token);
    try {
      const bytes = await readFile(fileURLToPath(record.localUri));
      return { fileName: record.fileName, mimeType: record.mimeType, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        tokens.delete(token);
        throw new ArtifactStoreError("ARTIFACT_NOT_FOUND", "The saved artifact is no longer available.", { cause: error });
      }
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The saved artifact could not be read.", { cause: error });
    }
  }

  async function registerExisting(jobId: string, fileName: string, mimeType: string, localUri: string): Promise<ArtifactRef> {
    if (closed) throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "Artifact store is closed.");
    assertServerArtifactIdentity(jobId, fileName, mimeType);
    const root = (options.localStore as ArtifactStore & { outputRoot?: string }).outputRoot;
    if (!root || !isAbsolute(root)) throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The local output root is unavailable for worker artifact registration.");
    let localPath: string;
    try {
      const parsed = new URL(localUri);
      if (parsed.protocol !== "file:" || parsed.host || parsed.search || parsed.hash) throw new Error("invalid file URI");
      localPath = fileURLToPath(parsed);
    } catch (error) {
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The worker artifact reference is not a local file URI.", { cause: error });
    }
    const expectedRoot = join(root, jobId);
    const expectedPath = join(expectedRoot, fileName);
    if (localPath !== expectedPath) throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The worker artifact reference does not match its job and filename.");
    try {
      const [rootReal, jobStat, fileStat] = await Promise.all([realpath(root), lstat(expectedRoot), lstat(expectedPath)]);
      if (!jobStat.isDirectory() || jobStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()
          || (process.getuid && (jobStat.uid !== process.getuid() || fileStat.uid !== process.getuid()))
          || (jobStat.mode & 0o077) !== 0 || (fileStat.mode & 0o077) !== 0) {
        throw new Error("worker output is not a regular file in a real job directory");
      }
      const [jobReal, fileReal] = await Promise.all([realpath(expectedRoot), realpath(expectedPath)]);
      const expectedJobReal = join(rootReal, jobId);
      const fromJob = relative(expectedJobReal, fileReal);
      if (jobReal !== expectedJobReal || fileReal !== expectedPath || fromJob !== fileName || fromJob.includes(sep)) {
        throw new Error("worker artifact escaped its private job directory");
      }
    } catch (error) {
      throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "The worker artifact could not be verified below its private job output directory.", { cause: error });
    }
    let token = newToken();
    while (tokens.has(token)) token = newToken();
    const expiresAtMs = now() + HTTP_ARTIFACT_TTL_MS;
    tokens.set(token, { jobId, localUri, fileName, mimeType, expiresAtMs });
    return { fileName, mimeType, uri: `${baseUrl}/artifacts/${token}`, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  return {
    async put(jobId, fileName, mimeType, bytes): Promise<ArtifactRef> {
      if (closed) throw new ArtifactStoreError("ARTIFACT_STORE_FAILED", "Artifact store is closed.");
      assertServerArtifactIdentity(jobId, fileName, mimeType);
      const localRef = await options.localStore.put(jobId, fileName, mimeType, bytes);
      let token = newToken();
      while (tokens.has(token)) token = newToken();
      const expiresAtMs = now() + HTTP_ARTIFACT_TTL_MS;
      tokens.set(token, { jobId, localUri: localRef.uri, fileName, mimeType, expiresAtMs });
      return {
        fileName,
        mimeType,
        uri: `${baseUrl}/artifacts/${token}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
    registerExisting,
    async get(token): Promise<Uint8Array> {
      return (await readRecord(token)).bytes;
    },
    async read(token): Promise<ArtifactDownload> {
      return readRecord(token);
    },
    async deleteJob(jobId): Promise<void> {
      for (const [token, record] of tokens) {
        if (record.jobId === jobId) tokens.delete(token);
      }
      await options.localStore.deleteJob?.(jobId);
    },
    async pruneExpired(): Promise<void> {
      await pruneExpired();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      tokens.clear();
      expiredTokens.clear();
    },
  };
}
