import sharp from "sharp";

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_COUNT = 30;
export const MAX_IMAGE_PIXELS = 40_000_000;

export type AttachmentValidationCode =
  | "INVALID_ATTACHMENT"
  | "INVALID_ATTACHMENT_SET"
  | "INVALID_MARKDOWN"
  | "FILE_TOO_LARGE"
  | "TOTAL_TOO_LARGE"
  | "TOO_MANY_IMAGES"
  | "UNSUPPORTED_IMAGE_FORMAT"
  | "MIME_MISMATCH"
  | "IMAGE_DECODE_FAILED";

export class AttachmentValidationError extends Error {
  readonly code: AttachmentValidationCode;
  readonly fileName?: string;
  readonly recoveryMessage: string;

  constructor(code: AttachmentValidationCode, fileName: string | undefined, recoveryMessage: string, message?: string) {
    super(message ?? recoveryMessage);
    this.name = "AttachmentValidationError";
    this.code = code;
    this.fileName = fileName;
    this.recoveryMessage = recoveryMessage;
  }
}

export interface ImageDecoder {
  decode(bytes: Uint8Array): Promise<{ width: number; height: number; format: "png" | "jpeg" }>;
}

export interface ValidatedImage {
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export interface ImageAttachmentBytes {
  assetId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

function fail(code: AttachmentValidationCode, fileName: string | undefined, recoveryMessage: string, message?: string): never {
  throw new AttachmentValidationError(code, fileName, recoveryMessage, message);
}

function checkFileName(fileName: string, code: "INVALID_MARKDOWN" | "INVALID_ATTACHMENT"): void {
  if (!fileName || fileName.length > 255 || /[\\/\0\x00-\x1f\x7f]/u.test(fileName) || fileName === "." || fileName === "..") {
    fail(code, fileName, "Use a plain attachment filename without directory components.");
  }
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function validateMarkdown(bytes: Uint8Array, fileName: string): Buffer {
  checkFileName(fileName, "INVALID_MARKDOWN");
  if (!fileName.toLowerCase().endsWith(".md")) {
    fail("INVALID_MARKDOWN", fileName, "Attach a non-empty UTF-8 Markdown file with the .md extension.");
  }
  if (bytes.byteLength === 0) {
    fail("INVALID_MARKDOWN", fileName, "Attach a non-empty UTF-8 Markdown file.");
  }
  if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
    fail("FILE_TOO_LARGE", fileName, "Reduce the Markdown file to 2 MiB or less.");
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_MARKDOWN", fileName, "Save the Markdown file as valid UTF-8 and attach it again.");
  }
  if (!content.trim()) {
    fail("INVALID_MARKDOWN", fileName, "Attach a non-empty UTF-8 Markdown file.");
  }
  return Buffer.from(bytes);
}

function detectImageFormat(bytes: Uint8Array): "image/png" | "image/jpeg" | undefined {
  if (bytes.byteLength >= 8
      && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
      && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
}

const sharpDecoder: ImageDecoder = {
  async decode(bytes) {
    const image = sharp(toBuffer(bytes), { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS });
    const metadata = await image.metadata();
    if ((metadata.format !== "png" && metadata.format !== "jpeg") || !metadata.width || !metadata.height) {
      throw new Error("Image has no supported format or dimensions");
    }
    // Force a complete decode so truncated data and corrupt scanlines do not pass metadata parsing.
    await image.raw().toBuffer();
    return { width: metadata.width, height: metadata.height, format: metadata.format };
  },
};

function normalizeDeclaredImageMime(mimeType: string): "image/png" | "image/jpeg" | undefined {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return undefined;
}

export async function validateImage(
  bytes: Uint8Array,
  fileName: string,
  declaredMime: string,
  decoder: ImageDecoder = sharpDecoder,
): Promise<ValidatedImage> {
  checkFileName(fileName, "INVALID_ATTACHMENT");
  if (bytes.byteLength === 0) {
    fail("UNSUPPORTED_IMAGE_FORMAT", fileName, "Attach a valid PNG or JPEG image.");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    fail("FILE_TOO_LARGE", fileName, "Reduce each image to 10 MiB or less.");
  }
  const detected = detectImageFormat(bytes);
  if (!detected) {
    fail("UNSUPPORTED_IMAGE_FORMAT", fileName, "Use PNG or JPEG images; GIF, WebP, SVG, and other formats are not supported.");
  }
  if (normalizeDeclaredImageMime(declaredMime) !== detected) {
    fail("MIME_MISMATCH", fileName, "Re-export the image as PNG or JPEG and attach it with a matching image MIME type.");
  }
  try {
    const decoded = await decoder.decode(bytes);
    const expectedFormat = detected === "image/png" ? "png" : "jpeg";
    if (decoded.format !== expectedFormat || decoded.width < 1 || decoded.height < 1) {
      throw new Error("Decoded image metadata does not match its byte signature");
    }
    return { mimeType: detected, width: decoded.width, height: decoded.height };
  } catch {
    fail("IMAGE_DECODE_FAILED", fileName, "The image is damaged; export a fresh PNG or JPEG and attach it again.");
  }
}

export function validateAttachmentSet(
  source: Uint8Array,
  images: ImageAttachmentBytes[],
  imageAssetIds: string[],
): { totalByteLength: number } {
  if (source.byteLength < 1 || source.byteLength > MAX_MARKDOWN_BYTES) {
    fail(source.byteLength > MAX_MARKDOWN_BYTES ? "FILE_TOO_LARGE" : "INVALID_ATTACHMENT_SET", undefined, "Provide a non-empty Markdown file no larger than 2 MiB.");
  }
  if (images.length > MAX_IMAGE_COUNT) {
    fail("TOO_MANY_IMAGES", undefined, "Reduce the image attachments to 30 or fewer.");
  }
  if (imageAssetIds.length !== images.length
      || new Set(imageAssetIds).size !== imageAssetIds.length
      || images.some((image, index) => !image.assetId || image.assetId !== imageAssetIds[index])) {
    fail("INVALID_ATTACHMENT_SET", undefined, "Provide one unique image asset ID for each attached image, in the same order.");
  }
  let totalByteLength = source.byteLength;
  for (const image of images) {
    if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
      fail("FILE_TOO_LARGE", image.fileName, "Reduce each image to 10 MiB or less.");
    }
    totalByteLength += image.bytes.byteLength;
    if (totalByteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
      fail("TOTAL_TOO_LARGE", image.fileName, "Reduce attachments to 50 MiB total or less.");
    }
  }
  return { totalByteLength };
}
