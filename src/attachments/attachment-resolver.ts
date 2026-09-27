import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { PresentationPlan } from "../contracts/presentation-plan.js";
import { validatePresentationPlan } from "../contracts/presentation-plan.js";
import type { ProbeFileRef, ProbeResolver } from "./attachment-reference.js";
import {
  AttachmentValidationError,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_MARKDOWN_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  type ImageDecoder,
  type ImageAttachmentBytes,
  validateAttachmentSet,
  validateImage,
  validateMarkdown,
} from "./file-validation.js";
import { createTempWorkspace } from "./temp-workspace.js";

export const MAX_DOWNLOAD_TIMEOUT_MS = 15_000;

export interface AuthorizedFileParam {
  kind: "host-file";
  fileId: string;
  fileName: string;
  mimeType: string;
  downloadUrl: string;
}

export type AttachmentReference = ProbeFileRef | AuthorizedFileParam;

export interface FetchAuthorizedFileOptions {
  redirect: "manual";
  signal: AbortSignal;
  file: AuthorizedFileParam;
  /** The adapter must connect only to one of these prevalidated addresses while retaining TLS hostname verification. */
  resolvedAddresses: string[];
}

export interface AttachmentResolverDeps {
  probeResolver: ProbeResolver;
  authorizeFileParam?: (file: AuthorizedFileParam, options: { signal: AbortSignal }) => boolean | Promise<boolean>;
  fetchAuthorizedFile?: (url: string, options: FetchAuthorizedFileOptions) => Promise<Response>;
  allowedOrigins?: string[];
  resolveHostname?: (hostname: string) => Promise<string[]>;
  tempRoot?: string;
  imageDecoder?: ImageDecoder;
  timeoutMs?: number;
}

export interface ResolveAttachmentsInput {
  jobId: string;
  sourceFile: AttachmentReference;
  imageFiles: AttachmentReference[];
  imageAssetIds: string[];
  plan: PresentationPlan;
}

export interface ResolvedImageAsset {
  assetId: string;
  fileName: string;
  mimeType: "image/png" | "image/jpeg";
  path: string;
  sha256: string;
  byteLength: number;
}

export interface ResolvedAttachments {
  markdown: Buffer;
  images: ResolvedImageAsset[];
  workspacePath: string;
  cleanup(): Promise<void>;
}

export type AttachmentResolverErrorCode =
  | "INVALID_ATTACHMENT_REF"
  | "ATTACHMENT_UNAUTHORIZED"
  | "URL_NOT_HTTPS"
  | "ORIGIN_NOT_ALLOWED"
  | "PRIVATE_ADDRESS_BLOCKED"
  | "REDIRECT_BLOCKED"
  | "DOWNLOAD_FAILED"
  | "DOWNLOAD_TIMEOUT"
  | "DOWNLOAD_TOO_LARGE"
  | "SOURCE_DIGEST_MISMATCH"
  | "ASSET_MANIFEST_MISMATCH"
  | "MISSING_IMAGE_ID"
  | "PLAN_INVALID"
  | "ATTACHMENT_RESOLUTION_FAILED";

export class AttachmentResolverError extends Error {
  readonly code: AttachmentResolverErrorCode;
  readonly fileName?: string;
  readonly recoveryMessage: string;
  readonly retryable: boolean;

  constructor(
    code: AttachmentResolverErrorCode,
    fileName: string | undefined,
    recoveryMessage: string,
    options: { cause?: unknown; retryable?: boolean; message?: string } = {},
  ) {
    super(options.message ?? recoveryMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AttachmentResolverError";
    this.code = code;
    this.fileName = fileName;
    this.recoveryMessage = recoveryMessage;
    this.retryable = options.retryable ?? false;
  }
}

interface ReadImage extends ImageAttachmentBytes {
  ref: AttachmentReference;
  sha256: string;
  detectedMime: "image/png" | "image/jpeg";
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isOpaqueId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/.test(value)) return true;
  // Colons are reserved for the two internally defined, opaque reference
  // namespaces. Other colon-bearing strings can be URL schemes or drive paths.
  return /^(?:stage|fixture):[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/.test(value);
}

function isHostFile(value: unknown): value is AuthorizedFileParam {
  if (!record(value) || !exactKeys(value, ["kind", "fileId", "fileName", "mimeType", "downloadUrl"])) return false;
  return value.kind === "host-file"
    && isOpaqueId(value.fileId)
    && typeof value.fileName === "string"
    && typeof value.mimeType === "string"
    && typeof value.downloadUrl === "string";
}

function isProbeRef(value: unknown): value is ProbeFileRef {
  if (!record(value) || !exactKeys(value, ["fileName", "mimeType", "assetId"])) return false;
  return typeof value.fileName === "string"
    && typeof value.mimeType === "string"
    && (value.assetId === undefined || isOpaqueId(value.assetId));
}

function isValidReference(value: unknown): value is AttachmentReference {
  return isHostFile(value) || isProbeRef(value);
}

function resolutionError(
  code: AttachmentResolverErrorCode,
  fileName: string | undefined,
  recoveryMessage: string,
  options: { cause?: unknown; retryable?: boolean; message?: string } = {},
): AttachmentResolverError {
  return new AttachmentResolverError(code, fileName, recoveryMessage, options);
}

function normalizeOrigin(origin: string): string | undefined {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:")) return true;
  // Only global unicast (2000::/3) is allowed. This rejects ULA, link-local,
  // multicast, IPv4-compatible, and unspecified ranges by default.
  if (!/^[23]/.test(normalized)) return true;
  if (normalized.startsWith("2001:db8:") || normalized.startsWith("2001:0:") || normalized.startsWith("2002:")) return true;
  return false;
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return true;
}

async function assertPublicHost(url: URL, deps: AttachmentResolverDeps, fileName: string, deadline: number): Promise<string[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalVersion = isIP(hostname);
  let addresses: string[];
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw resolutionError("DOWNLOAD_TIMEOUT", fileName, "The attachment host check exceeded the 15-second deadline.", { retryable: true });
  }
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(resolutionError(
      "DOWNLOAD_TIMEOUT",
      fileName,
      "The attachment host check exceeded the 15-second deadline.",
      { retryable: true },
    )), remainingMs);
  });
  try {
    const resolve = literalVersion
      ? Promise.resolve([hostname])
      : (deps.resolveHostname ?? (async (host) => (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address)))(hostname);
    addresses = await Promise.race([resolve, timeout]);
  } catch (error) {
    if (error instanceof AttachmentResolverError) throw error;
    throw resolutionError("PRIVATE_ADDRESS_BLOCKED", fileName, "The file host could not be verified as a public address.", { cause: error });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw resolutionError("PRIVATE_ADDRESS_BLOCKED", fileName, "The file URL resolves to a private or non-public network address.");
  }
  return addresses;
}

async function validateHostUrl(ref: AuthorizedFileParam, deps: AttachmentResolverDeps, deadline: number): Promise<{ url: URL; resolvedAddresses: string[] }> {
  let url: URL;
  try {
    url = new URL(ref.downloadUrl);
  } catch (error) {
    throw resolutionError("URL_NOT_HTTPS", ref.fileName, "Use a host-authorized HTTPS attachment URL.", { cause: error });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw resolutionError("URL_NOT_HTTPS", ref.fileName, "Use a host-authorized HTTPS attachment URL without credentials or fragments.");
  }
  const allowed = (deps.allowedOrigins ?? []).map(normalizeOrigin);
  if (allowed.length === 0 || allowed.some((origin) => origin === undefined) || !allowed.includes(url.origin)) {
    throw resolutionError("ORIGIN_NOT_ALLOWED", ref.fileName, "The attachment URL origin is not in the configured allowlist.");
  }
  const resolvedAddresses = await assertPublicHost(url, deps, ref.fileName, deadline);
  return { url, resolvedAddresses };
}

function downloadMaxBytes(isSource: boolean, remainingTotalBytes: number): number {
  return Math.min(isSource ? MAX_MARKDOWN_BYTES : MAX_IMAGE_BYTES, remainingTotalBytes);
}

async function readResponse(response: Response, maxBytes: number, fileName: string): Promise<Buffer> {
  if (response.status >= 300 && response.status < 400) {
    throw resolutionError("REDIRECT_BLOCKED", fileName, "The file host redirected the download; attach the file again through the authorized host interface.");
  }
  if (response.status < 200 || response.status >= 300) {
    throw resolutionError("DOWNLOAD_FAILED", fileName, "The authorized file download did not succeed.", { retryable: response.status >= 500 });
  }
  if (response.redirected) {
    throw resolutionError("REDIRECT_BLOCKED", fileName, "Redirected attachment downloads are not accepted.");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw resolutionError("DOWNLOAD_FAILED", fileName, "The file host returned an invalid byte count.");
    }
    if (length > maxBytes) {
      throw resolutionError("DOWNLOAD_TOO_LARGE", fileName, "The attachment exceeds its allowed byte limit.");
    }
  }
  if (!response.body) throw resolutionError("DOWNLOAD_FAILED", fileName, "The file host returned no attachment bytes.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw resolutionError("DOWNLOAD_TOO_LARGE", fileName, "The attachment exceeds its allowed byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw resolutionError("DOWNLOAD_FAILED", fileName, "The downloaded attachment is empty.");
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function readHostFile(ref: AuthorizedFileParam, deps: AttachmentResolverDeps, isSource: boolean, remainingTotalBytes: number): Promise<Buffer> {
  if (!deps.authorizeFileParam || !deps.fetchAuthorizedFile) {
    throw resolutionError("ATTACHMENT_UNAUTHORIZED", ref.fileName, "This host does not provide an authorized file-reading adapter.");
  }
  const timeoutMs = Math.min(deps.timeoutMs ?? MAX_DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw resolutionError("DOWNLOAD_TIMEOUT", ref.fileName, "Use a positive download timeout no longer than 15 seconds.");
  }
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(resolutionError("DOWNLOAD_TIMEOUT", ref.fileName, "The authorized attachment authorization, DNS check, or download exceeded 15 seconds.", { retryable: true }));
    }, timeoutMs);
  });
  const work = (async () => {
    let authorized: boolean;
    try {
      authorized = await deps.authorizeFileParam!(ref, { signal: controller.signal });
    } catch (error) {
      if (timedOut) throw error;
      throw resolutionError("ATTACHMENT_UNAUTHORIZED", ref.fileName, "The host could not authorize this attachment reference.", { cause: error });
    }
    if (!authorized) {
      throw resolutionError("ATTACHMENT_UNAUTHORIZED", ref.fileName, "Only file references confirmed by the host authorization adapter can be read.");
    }

    const { url, resolvedAddresses } = await validateHostUrl(ref, deps, deadline);
    const maxBytes = downloadMaxBytes(isSource, remainingTotalBytes);
    if (maxBytes <= 0) {
      throw resolutionError("DOWNLOAD_TOO_LARGE", ref.fileName, "The attachment set has reached the 50 MiB total limit.");
    }

    const response = await deps.fetchAuthorizedFile!(url.href, {
      redirect: "manual",
      signal: controller.signal,
      file: ref,
      resolvedAddresses,
    });
    if (response.url) {
      let finalUrl: URL;
      try {
        finalUrl = new URL(response.url);
      } catch (error) {
        throw resolutionError("DOWNLOAD_FAILED", ref.fileName, "The file host returned an invalid response URL.", { cause: error });
      }
      if (finalUrl.origin !== url.origin) {
        throw resolutionError("REDIRECT_BLOCKED", ref.fileName, "Redirects to another origin are not accepted.");
      }
    }
    return readResponse(response, maxBytes, ref.fileName);
  })();
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (error instanceof AttachmentResolverError) throw error;
    if (timedOut) throw resolutionError("DOWNLOAD_TIMEOUT", ref.fileName, "The authorized attachment authorization, DNS check, or download exceeded 15 seconds.", { cause: error, retryable: true });
    throw resolutionError("DOWNLOAD_FAILED", ref.fileName, "The authorized attachment could not be downloaded.", { cause: error, retryable: true });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (!controller.signal.aborted) controller.abort();
  }
}

async function readReference(ref: AttachmentReference, deps: AttachmentResolverDeps, isSource: boolean, remainingTotalBytes: number): Promise<Uint8Array> {
  if (isHostFile(ref)) return readHostFile(ref, deps, isSource, remainingTotalBytes);
  try {
    return await deps.probeResolver.read(ref);
  } catch (error) {
    throw resolutionError("ATTACHMENT_RESOLUTION_FAILED", ref.fileName, "The staged attachment could not be read; stage the file again and retry.", { cause: error, retryable: true });
  }
}

function validateRefMetadata(ref: AttachmentReference, isSource: boolean): void {
  if (!ref.fileName || ref.fileName.length > 255 || /[\\/\0\x00-\x1f\x7f]/u.test(ref.fileName) || ref.fileName === "." || ref.fileName === "..") {
    throw resolutionError("INVALID_ATTACHMENT_REF", typeof ref.fileName === "string" ? ref.fileName : undefined, "Provide a plain filename without path components.");
  }
  const mime = ref.mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (isSource ? mime !== "text/markdown" : mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/jpg") {
    throw resolutionError("INVALID_ATTACHMENT_REF", ref.fileName, isSource ? "The source must be declared as text/markdown." : "Images must be declared as PNG or JPEG.");
  }
}

function validatePlan(plan: PresentationPlan, imageAssetIds: string[]): void {
  const issues = validatePresentationPlan(plan, imageAssetIds);
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length) {
    const missing = errors.find((issue) => issue.code === "MISSING_IMAGE_ID");
    if (missing) {
      const fileName = plan.assetManifest.find((asset) => asset.assetId === missing.imageId)?.fileName ?? missing.imageId;
      throw resolutionError("MISSING_IMAGE_ID", fileName, "Attach the missing image, or remove its reference from the plan and regenerate the deck.", { message: missing.message });
    }
    throw resolutionError("PLAN_INVALID", undefined, "Correct the slide plan and retry attachment validation.", { message: errors[0]?.message });
  }
}

function assertAssetManifest(plan: PresentationPlan, images: ReadImage[]): void {
  const manifest = new Map(plan.assetManifest.map((entry) => [entry.assetId, entry]));
  for (const image of images) {
    const entry = manifest.get(image.assetId);
    if (!entry || entry.fileName !== image.fileName || entry.mimeType !== image.detectedMime
        || entry.byteLength !== image.bytes.byteLength || entry.sha256.toLowerCase() !== image.sha256) {
      throw resolutionError("ASSET_MANIFEST_MISMATCH", image.fileName, "Refresh the slide plan from the received image names, MIME types, byte lengths, and SHA-256 values.");
    }
  }
}

function serverFileName(index: number, mimeType: "image/png" | "image/jpeg"): string {
  const extension = mimeType === "image/png" ? "png" : "jpg";
  return `image-${index}-${randomBytes(8).toString("hex")}.${extension}`;
}

export async function resolveAttachments(input: ResolveAttachmentsInput, deps: AttachmentResolverDeps): Promise<ResolvedAttachments> {
  if (!isValidReference(input.sourceFile) || !Array.isArray(input.imageFiles) || input.imageFiles.some((ref) => !isValidReference(ref))) {
    throw resolutionError("INVALID_ATTACHMENT_REF", undefined, "Pass only opaque staged ProbeFileRefs or host FileParams authorized by the injected host adapter.");
  }
  if (input.imageFiles.length > MAX_IMAGE_COUNT) {
    throw new AttachmentValidationError("TOO_MANY_IMAGES", undefined, "Reduce the image attachments to 30 or fewer.");
  }
  for (const ref of [input.sourceFile, ...input.imageFiles]) validateRefMetadata(ref, ref === input.sourceFile);
  if (!Array.isArray(input.imageAssetIds) || input.imageAssetIds.length !== input.imageFiles.length
      || new Set(input.imageAssetIds).size !== input.imageAssetIds.length
      || input.imageAssetIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new AttachmentValidationError("INVALID_ATTACHMENT_SET", undefined, "Provide one unique image asset ID for each attached image, in the same order.");
  }
  validatePlan(input.plan, input.imageAssetIds);

  const sourceRaw = await readReference(input.sourceFile, deps, true, MAX_TOTAL_ATTACHMENT_BYTES);
  const markdown = validateMarkdown(sourceRaw, input.sourceFile.fileName);
  if (hash(markdown) !== input.plan.sourceDigest.toLowerCase()) {
    throw resolutionError("SOURCE_DIGEST_MISMATCH", input.sourceFile.fileName, "Rebuild the slide plan from the exact Markdown attachment being rendered.");
  }

  const images: ReadImage[] = [];
  let runningTotal = markdown.byteLength;
  for (let index = 0; index < input.imageFiles.length; index++) {
    const ref = input.imageFiles[index]!;
    const raw = await readReference(ref, deps, false, MAX_TOTAL_ATTACHMENT_BYTES - runningTotal);
    if (raw.byteLength > MAX_IMAGE_BYTES) {
      throw new AttachmentValidationError("FILE_TOO_LARGE", ref.fileName, "Reduce each image to 10 MiB or less.");
    }
    runningTotal += raw.byteLength;
    if (runningTotal > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError("TOTAL_TOO_LARGE", ref.fileName, "Reduce attachments to 50 MiB total or less.");
    }
    const validated = await validateImage(raw, ref.fileName, ref.mimeType, deps.imageDecoder);
    const assetId = input.imageAssetIds[index]!;
    images.push({
      assetId,
      fileName: ref.fileName,
      mimeType: validated.mimeType,
      detectedMime: validated.mimeType,
      bytes: raw,
      ref,
      sha256: hash(raw),
    });
  }
  validateAttachmentSet(markdown, images, input.imageAssetIds);
  assertAssetManifest(input.plan, images);

  const workspace = await createTempWorkspace(input.jobId, { root: deps.tempRoot });
  try {
    await workspace.writeFile("source.md", markdown);
    const resolvedImages: ResolvedImageAsset[] = [];
    for (let index = 0; index < images.length; index++) {
      const image = images[index]!;
      const path = await workspace.writeFile(serverFileName(index, image.detectedMime), image.bytes);
      resolvedImages.push({
        assetId: image.assetId,
        fileName: image.fileName,
        mimeType: image.detectedMime,
        path,
        sha256: image.sha256,
        byteLength: image.bytes.byteLength,
      });
    }
    return { markdown, images: resolvedImages, workspacePath: workspace.path, cleanup: workspace.cleanup };
  } catch (error) {
    await workspace.cleanup();
    if (error instanceof AttachmentValidationError || error instanceof AttachmentResolverError) throw error;
    throw resolutionError("ATTACHMENT_RESOLUTION_FAILED", undefined, "Could not create the isolated attachment workspace.", { cause: error, retryable: true });
  }
}
