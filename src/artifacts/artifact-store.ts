export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const MARP_MIME = "text/markdown";
export const MARP_BUNDLE_MIME = "application/zip";
export const PREVIEW_MIME = "image/png";
export const HTTP_ARTIFACT_TTL_MS = 30 * 60 * 1000;

export interface ArtifactRef {
  fileName: string;
  mimeType: string;
  uri: string;
  /** Local output files persist and are represented by null; HTTP download tokens expire. */
  expiresAt?: string | null;
}

export interface ArtifactStore {
  put(jobId: string, fileName: string, mimeType: string, bytes: Uint8Array): Promise<ArtifactRef>;
  deleteJob?(jobId: string): Promise<void>;
  close?(): Promise<void> | void;
}

export interface ArtifactDownload {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface HttpArtifactStore extends ArtifactStore {
  get(token: string): Promise<Uint8Array>;
  read(token: string): Promise<ArtifactDownload>;
  registerExisting?(jobId: string, fileName: string, mimeType: string, localUri: string): Promise<ArtifactRef>;
  pruneExpired(): Promise<void>;
}

export type ArtifactStoreErrorCode = "ARTIFACT_EXPIRED" | "ARTIFACT_NOT_FOUND" | "ARTIFACT_INVALID_NAME" | "ARTIFACT_STORE_FAILED";

export class ArtifactStoreError extends Error {
  constructor(readonly code: ArtifactStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArtifactStoreError";
  }
}

export const ALLOWED_ARTIFACT_MIME_TYPES = new Set([
  PPTX_MIME,
  MARP_MIME,
  "text/markdown",
  MARP_BUNDLE_MIME,
  PREVIEW_MIME,
]);

export const SERVER_JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const SERVER_ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;

export function assertServerArtifactIdentity(jobId: string, fileName: string, mimeType: string): void {
  if (!SERVER_JOB_ID_PATTERN.test(jobId)
      || !SERVER_ARTIFACT_NAME_PATTERN.test(fileName)
      || fileName === "." || fileName === ".."
      || !ALLOWED_ARTIFACT_MIME_TYPES.has(mimeType)) {
    throw new ArtifactStoreError("ARTIFACT_INVALID_NAME", "Artifact job IDs, filenames, or MIME types are not valid server-generated values.");
  }
}
