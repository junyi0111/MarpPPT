import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  AttachmentValidationError,
  MAX_IMAGE_PIXELS,
  validateAttachmentSet,
  validateImage,
  validateMarkdown,
} from "../../src/attachments/file-validation.js";

const jpegPrefix = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const pngPrefix = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fakeDecoder = { decode: vi.fn(async () => ({ width: 1, height: 1, format: "jpeg" as const })) };

const image = (assetId = "img-1", bytes: Uint8Array = pngPrefix) => ({
  assetId,
  fileName: "photo.png",
  mimeType: "image/png",
  bytes,
});

describe("attachment file validation", () => {
  it("rejects declared MIME that conflicts with detected content and names the file", async () => {
    await expect(validateImage(jpegPrefix, "photo.png", "image/png", fakeDecoder))
      .rejects.toMatchObject({ code: "MIME_MISMATCH", fileName: "photo.png", recoveryMessage: expect.any(String) });
  });

  it("uses detected bytes rather than the extension alone", async () => {
    const result = await validateImage(jpegPrefix, "photo.png", "image/jpeg", fakeDecoder);
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("rejects images above the per-file limit", async () => {
    const overTenMegabytes = new Uint8Array(10 * 1024 * 1024 + 1);
    await expect(validateImage(overTenMegabytes, "large.png", "image/png", fakeDecoder))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE", fileName: "large.png" });
  });

  it("rejects a truncated PNG that passes signature detection but cannot be decoded", async () => {
    const decoder = { decode: vi.fn().mockRejectedValue(new Error("truncated image")) };
    await expect(validateImage(pngPrefix, "broken.png", "image/png", decoder))
      .rejects.toMatchObject({ code: "IMAGE_DECODE_FAILED", fileName: "broken.png" });
  });

  it("decodes real PNG pixels with Sharp before accepting the image", async () => {
    const validPng = await sharp({ create: { width: 2, height: 3, channels: 4, background: "#ffffff" } }).png().toBuffer();
    await expect(validateImage(validPng, "real.png", "image/png"))
      .resolves.toMatchObject({ mimeType: "image/png", width: 2, height: 3 });
    await expect(validateImage(pngPrefix, "truncated.png", "image/png"))
      .rejects.toMatchObject({ code: "IMAGE_DECODE_FAILED", fileName: "truncated.png" });
  });

  it("rejects unsupported image formats with the accepted format list", async () => {
    await expect(validateImage(Uint8Array.from([0, 1, 2]), "graphic.gif", "image/gif", fakeDecoder))
      .rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE_FORMAT", fileName: "graphic.gif", recoveryMessage: expect.stringContaining("PNG") });
  });

  it("validates Markdown UTF-8, extension, non-empty bytes, and the 2 MiB limit", () => {
    expect(validateMarkdown(new TextEncoder().encode("# Hello"), "source.md").toString()).toBe("# Hello");
    expect(() => validateMarkdown(Uint8Array.from([0xff]), "source.md"))
      .toThrowError(expect.objectContaining({ code: "INVALID_MARKDOWN" }));
    expect(() => validateMarkdown(new TextEncoder().encode("# Hello"), "source.txt"))
      .toThrowError(expect.objectContaining({ code: "INVALID_MARKDOWN" }));
    expect(() => validateMarkdown(new TextEncoder().encode(" \t\r\n\u3000"), "blank.md"))
      .toThrowError(expect.objectContaining({ code: "INVALID_MARKDOWN", fileName: "blank.md" }));
    expect(() => validateMarkdown(new Uint8Array(2 * 1024 * 1024 + 1), "large.md"))
      .toThrowError(expect.objectContaining({ code: "FILE_TOO_LARGE", fileName: "large.md" }));
  });

  it("enforces count, unique image IDs, matching parallel IDs, and total byte quota", () => {
    const source = new TextEncoder().encode("# Source");
    expect(() => validateAttachmentSet(source, [image("same"), image("same")], ["same", "same"]))
      .toThrowError(expect.objectContaining({ code: "INVALID_ATTACHMENT_SET" }));
    expect(() => validateAttachmentSet(source, [image("one")], ["other"]))
      .toThrowError(expect.objectContaining({ code: "INVALID_ATTACHMENT_SET" }));
    expect(() => validateAttachmentSet(source, Array.from({ length: 31 }, (_, i) => image(`img-${i}`)), Array.from({ length: 31 }, (_, i) => `img-${i}`)))
      .toThrowError(expect.objectContaining({ code: "TOO_MANY_IMAGES" }));
    const hugeImages = [
      { ...image("a"), bytes: new Uint8Array(9 * 1024 * 1024) },
      { ...image("b"), bytes: new Uint8Array(9 * 1024 * 1024) },
      { ...image("c"), bytes: new Uint8Array(9 * 1024 * 1024) },
      { ...image("d"), bytes: new Uint8Array(9 * 1024 * 1024) },
      { ...image("e"), bytes: new Uint8Array(9 * 1024 * 1024) },
      { ...image("f"), bytes: new Uint8Array(5 * 1024 * 1024) },
    ];
    expect(() => validateAttachmentSet(source, hugeImages, hugeImages.map((entry) => entry.assetId)))
      .toThrowError(expect.objectContaining({ code: "TOTAL_TOO_LARGE" }));
  });

  it("exports a typed attachment error", () => {
    const error = new AttachmentValidationError("INVALID_MARKDOWN", "source.md", "Choose a UTF-8 Markdown file.");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "INVALID_MARKDOWN", fileName: "source.md", recoveryMessage: "Choose a UTF-8 Markdown file." });
  });

  it("caps decoded raster dimensions before Sharp allocates pixel buffers", () => {
    expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
  });
});
