import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { probeAttachments } from "../../src/probe/attachment-probe.js";

const markdown = "title: Deck\n";
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const signedUrl = "https://private.example/source.md?token=secret-signed-input-url";
const validProbeInput = {
  sourceFile: { fileName: "source.md", mimeType: "text/markdown", url: signedUrl },
  imageFiles: [{ fileName: "photo.png", mimeType: "image/png", assetId: "image-1" }],
};

describe("probeAttachments", () => {
  it("reports attachment metadata without exposing input content or references", async () => {
    const read = vi.fn(async (file: { fileName: string }) =>
      file.fileName === "source.md" ? new TextEncoder().encode(markdown) : png,
    );
    const report = await probeAttachments(validProbeInput, { read });

    expect(read).toHaveBeenCalledTimes(2);
    expect(report.files).toEqual([
      {
        fileName: "source.md",
        mimeType: "text/markdown",
        byteLength: 12,
        sha256: createHash("sha256").update(markdown).digest("hex"),
      },
      {
        fileName: "photo.png",
        mimeType: "image/png",
        byteLength: 8,
        sha256: createHash("sha256").update(png).digest("hex"),
      },
    ]);
    expect(Object.keys(report)).toEqual(["files", "sampleArtifactUri"]);
    expect(report.sampleArtifactUri).toMatch(/^file:\/\//);
    const payload = JSON.stringify(report);
    expect(payload).not.toContain(markdown.trim());
    expect(payload).not.toContain("secret-signed-input-url");
    expect(payload).not.toContain(signedUrl);
    expect(payload).not.toContain(Buffer.from(png).toString("base64"));
    expect(payload).not.toContain(JSON.stringify(Array.from(png)));
    expect(payload).not.toContain("base64");
  });

  it("rejects repeated image IDs and more than 30 image references", async () => {
    const read = vi.fn(async () => png);
    const sourceFile = { fileName: "source.md", mimeType: "text/markdown", assetId: "stage:source" };
    const image = { fileName: "photo.png", mimeType: "image/png", assetId: "same-image" };
    await expect(probeAttachments({ sourceFile, imageFiles: [image, image] }, { read })).rejects.toThrow();
    await expect(probeAttachments({
      sourceFile,
      imageFiles: Array.from({ length: 31 }, (_, index) => ({ ...image, assetId: `image-${index}` })),
    }, { read })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects wrong source/image roles and more than 50 MB of attachment bytes", async () => {
    const sourceFile = { fileName: "source.md", mimeType: "text/markdown", assetId: "source" };
    const image = { fileName: "photo.png", mimeType: "image/png", assetId: "image-1" };
    const read = vi.fn(async () => png);
    await expect(probeAttachments({ sourceFile: { ...sourceFile, mimeType: "image/png" }, imageFiles: [] }, { read })).rejects.toThrow();
    await expect(probeAttachments({ sourceFile, imageFiles: [{ ...image, mimeType: "text/markdown" }] }, { read })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    const largeImage = new Uint8Array(10 * 1024 * 1024);
    const largeSource = new Uint8Array(1024 * 1024);
    const images = Array.from({ length: 5 }, (_, index) => ({ ...image, assetId: `image-${index}` }));
    await expect(probeAttachments({ sourceFile, imageFiles: images }, {
      read: async (ref) => ref.mimeType === "text/markdown" ? largeSource : largeImage,
    })).rejects.toThrow();
  });
});
