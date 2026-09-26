import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresentationPlan } from "../../src/contracts/presentation-plan.js";
import { resolveAttachments, type AuthorizedFileParam, type AttachmentResolverDeps } from "../../src/attachments/attachment-resolver.js";
import { withTempWorkspace } from "../../src/attachments/temp-workspace.js";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const markdown = new TextEncoder().encode("# Source\n");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const decoder = { decode: vi.fn(async () => ({ width: 1, height: 1, format: "png" as const })) };
const validPlan = (assetId = "img-1", source = markdown, imageBytes = png): PresentationPlan => ({
  version: 1,
  title: "Deck",
  language: "zh-TW",
  themeId: "default",
  sourceDigest: sha(source),
  imageAssetIds: [assetId],
  assetManifest: [{ assetId, fileName: "photo.png", mimeType: "image/png", byteLength: imageBytes.length, sha256: sha(imageBytes) }],
  slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [], sourceRefs: [] }],
});
const localSource = { fileName: "source.md", mimeType: "text/markdown", assetId: "stage:source" };
const localImage = { fileName: "photo.png", mimeType: "image/png", assetId: "stage:image" };
const localResolver = { read: vi.fn(async (ref: { assetId?: string }) => ref.assetId === "stage:source" ? markdown : png) };

let temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true })));
  temporaryRoots = [];
});

function tempRoot() {
  return mkdtemp(join(tmpdir(), "marp-ppt-test-root-"));
}

describe("resolveAttachments", () => {
  it("resolves opaque staged ProbeFileRefs without URL fetching and validates plan digests and manifest", async () => {
    const root = await tempRoot(); temporaryRoots.push(root);
    const fetchAuthorizedFile = vi.fn();
    const result = await resolveAttachments({
      jobId: "../untrusted-job-id",
      sourceFile: localSource,
      imageFiles: [localImage],
      imageAssetIds: ["img-1"],
      plan: validPlan(),
    }, {
      probeResolver: localResolver,
      fetchAuthorizedFile,
      tempRoot: root,
      imageDecoder: decoder,
    });
    expect(result.markdown).toEqual(Buffer.from(markdown));
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ assetId: "img-1", fileName: "photo.png", mimeType: "image/png", sha256: sha(png), byteLength: png.length });
    expect(await readFile(result.images[0]!.path)).toEqual(Buffer.from(png));
    expect(result.images[0]!.path).toContain(root);
    expect(fetchAuthorizedFile).not.toHaveBeenCalled();
    expect(localResolver.read).toHaveBeenCalledTimes(2);
    await result.cleanup();
    await expect(stat(result.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects MCP references containing arbitrary filesystem paths before reading", async () => {
    const root = await tempRoot(); temporaryRoots.push(root);
    const badRef = { fileName: "source.md", mimeType: "text/markdown", path: "/etc/passwd" } as never;
    const read = vi.fn();
    await expect(resolveAttachments({
      jobId: "job", sourceFile: badRef, imageFiles: [], imageAssetIds: [],
      plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] },
    }, { probeResolver: { read }, tempRoot: root })).rejects.toMatchObject({ code: "INVALID_ATTACHMENT_REF" });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects path-like and URL-like values where an opaque ProbeFileRef ID is required", async () => {
    const read = vi.fn();
    for (const assetId of ["../../etc/passwd", "file:///etc/passwd", "https://evil.example/a"]) {
      await expect(resolveAttachments({
        jobId: "job",
        sourceFile: { fileName: "source.md", mimeType: "text/markdown", assetId },
        imageFiles: [],
        imageAssetIds: [],
        plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] },
      }, { probeResolver: { read } })).rejects.toMatchObject({ code: "INVALID_ATTACHMENT_REF" });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects URL- and path-like colon namespaces before local reads or host authorization", async () => {
    const read = vi.fn(async () => markdown);
    const authorizeFileParam = vi.fn(async () => true);
    const malformedIds = ["https:internal-host", "file:secret", "C:secret", "http:internal-host", "custom:secret"];
    for (const assetId of malformedIds) {
      await expect(resolveAttachments({
        jobId: "job",
        sourceFile: { fileName: "source.md", mimeType: "text/markdown", assetId },
        imageFiles: [],
        imageAssetIds: [],
        plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] },
      }, { probeResolver: { read }, authorizeFileParam })).rejects.toMatchObject({ code: "INVALID_ATTACHMENT_REF" });
      await expect(resolveAttachments({
        jobId: "job",
        sourceFile: { kind: "host-file", fileId: assetId, fileName: "source.md", mimeType: "text/markdown", downloadUrl: "https://files.example.test/a" },
        imageFiles: [],
        imageAssetIds: [],
        plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] },
      }, { probeResolver: { read }, authorizeFileParam })).rejects.toMatchObject({ code: "INVALID_ATTACHMENT_REF" });
    }
    expect(read).not.toHaveBeenCalled();
    expect(authorizeFileParam).not.toHaveBeenCalled();
  });

  it("continues to accept the known fixture namespace as an opaque staged resolver ID", async () => {
    const read = vi.fn(async (ref: { assetId?: string }) => {
      if (ref.assetId === "fixture:source-md") return markdown;
      throw new Error("unknown fixture");
    });
    const plan: PresentationPlan = {
      ...validPlan(), imageAssetIds: [], assetManifest: [],
      slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }],
    };
    const result = await resolveAttachments({
      jobId: "job", sourceFile: { fileName: "source.md", mimeType: "text/markdown", assetId: "fixture:source-md" },
      imageFiles: [], imageAssetIds: [], plan,
    }, { probeResolver: { read } });
    expect(result.markdown).toEqual(Buffer.from(markdown));
    await result.cleanup();
  });

  it("rejects plan sourceDigest and actual assetManifest mismatches", async () => {
    const root = await tempRoot(); temporaryRoots.push(root);
    const wrongSourceDigest = { ...validPlan(), sourceDigest: "0".repeat(64) };
    await expect(resolveAttachments({ jobId: "job", sourceFile: localSource, imageFiles: [localImage], imageAssetIds: ["img-1"], plan: wrongSourceDigest }, {
      probeResolver: localResolver, tempRoot: root, imageDecoder: decoder,
    })).rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH", fileName: "source.md" });
    const wrongManifest = validPlan();
    wrongManifest.assetManifest[0]!.sha256 = "0".repeat(64);
    await expect(resolveAttachments({ jobId: "job", sourceFile: localSource, imageFiles: [localImage], imageAssetIds: ["img-1"], plan: wrongManifest }, {
      probeResolver: localResolver, tempRoot: root, imageDecoder: decoder,
    })).rejects.toMatchObject({ code: "ASSET_MANIFEST_MISMATCH", fileName: "photo.png" });
  });

  it("requires the parallel image asset IDs to match the plan and attachment count", async () => {
    await expect(resolveAttachments({ jobId: "job", sourceFile: localSource, imageFiles: [localImage], imageAssetIds: ["other"], plan: validPlan() }, {
      probeResolver: localResolver, imageDecoder: decoder,
    })).rejects.toMatchObject({ code: "MISSING_IMAGE_ID", fileName: "photo.png" });
    await expect(resolveAttachments({ jobId: "job", sourceFile: localSource, imageFiles: [localImage], imageAssetIds: [], plan: validPlan() }, {
      probeResolver: localResolver, imageDecoder: decoder,
    })).rejects.toMatchObject({ code: "INVALID_ATTACHMENT_SET" });
  });

  it("accepts a host FileParam only after injected authorization and a secure HTTPS allowlist check", async () => {
    const root = await tempRoot(); temporaryRoots.push(root);
    const sourceFile: AuthorizedFileParam = { kind: "host-file", fileId: "file-1", fileName: "source.md", mimeType: "text/markdown", downloadUrl: "https://files.example.test/a" };
    const imageFile: AuthorizedFileParam = { kind: "host-file", fileId: "file-2", fileName: "photo.png", mimeType: "image/png", downloadUrl: "https://files.example.test/b" };
    const fetchAuthorizedFile = vi.fn(async (url: string) => new Response(url.endsWith("/a") ? markdown : png, { status: 200 }));
    const authorizeFileParam = vi.fn(async () => true);
    const deps: AttachmentResolverDeps = {
      probeResolver: localResolver,
      authorizeFileParam,
      fetchAuthorizedFile,
      allowedOrigins: ["https://files.example.test"],
      resolveHostname: vi.fn(async () => ["93.184.216.34"]),
      tempRoot: root,
      imageDecoder: decoder,
    };
    const result = await resolveAttachments({ jobId: "job", sourceFile, imageFiles: [imageFile], imageAssetIds: ["img-1"], plan: validPlan() }, deps);
    expect(result.markdown).toEqual(Buffer.from(markdown));
    expect(authorizeFileParam).toHaveBeenCalledTimes(2);
    expect(fetchAuthorizedFile).toHaveBeenCalledWith(sourceFile.downloadUrl, expect.objectContaining({
      redirect: "manual",
      signal: expect.any(AbortSignal),
      resolvedAddresses: ["93.184.216.34"],
    }));
    await result.cleanup();
  });

  it("rejects unauthorized FileParams without a network request", async () => {
    const sourceFile: AuthorizedFileParam = { kind: "host-file", fileId: "forged", fileName: "source.md", mimeType: "text/markdown", downloadUrl: "https://files.example.test/a" };
    const fetchAuthorizedFile = vi.fn();
    await expect(resolveAttachments({ jobId: "job", sourceFile, imageFiles: [], imageAssetIds: [], plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] } }, {
      probeResolver: localResolver,
      authorizeFileParam: vi.fn(async () => false),
      fetchAuthorizedFile,
      allowedOrigins: ["https://files.example.test"],
      resolveHostname: vi.fn(async () => ["93.184.216.34"]),
    })).rejects.toMatchObject({ code: "ATTACHMENT_UNAUTHORIZED", fileName: "source.md" });
    expect(fetchAuthorizedFile).not.toHaveBeenCalled();
  });

  it.each([
    ["rejects non-HTTPS URLs", { downloadUrl: "http://files.example.test/a" }, "URL_NOT_HTTPS"],
    ["rejects origins outside the allowlist", { downloadUrl: "https://evil.example/a" }, "ORIGIN_NOT_ALLOWED"],
  ])("%s", async (_label, change, code) => {
    const sourceFile = { kind: "host-file", fileId: "file-1", fileName: "source.md", mimeType: "text/markdown", downloadUrl: "https://files.example.test/a", ...change } as AuthorizedFileParam;
    const fetchAuthorizedFile = vi.fn();
    await expect(resolveAttachments({ jobId: "job", sourceFile, imageFiles: [], imageAssetIds: [], plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] } }, {
      probeResolver: localResolver,
      authorizeFileParam: vi.fn(async () => true),
      fetchAuthorizedFile,
      allowedOrigins: ["https://files.example.test"],
      resolveHostname: vi.fn(async () => ["93.184.216.34"]),
    })).rejects.toMatchObject({ code });
    expect(fetchAuthorizedFile).not.toHaveBeenCalled();
  });

  it("blocks localhost and private-network DNS answers before requesting a URL", async () => {
    const sourceFile: AuthorizedFileParam = { kind: "host-file", fileId: "file-1", fileName: "source.md", mimeType: "text/markdown", downloadUrl: "https://files.example.test/a" };
    const fetchAuthorizedFile = vi.fn();
    await expect(resolveAttachments({ jobId: "job", sourceFile, imageFiles: [], imageAssetIds: [], plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] } }, {
      probeResolver: localResolver,
      authorizeFileParam: vi.fn(async () => true), fetchAuthorizedFile,
      allowedOrigins: ["https://files.example.test"],
      resolveHostname: vi.fn(async () => ["127.0.0.1"]),
    })).rejects.toMatchObject({ code: "PRIVATE_ADDRESS_BLOCKED" });
    expect(fetchAuthorizedFile).not.toHaveBeenCalled();
  });

  it("bounds DNS resolution by the same 15-second deadline and never starts the download on timeout", async () => {
    const sourceFile: AuthorizedFileParam = { kind: "host-file", fileId: "file-1", fileName: "source.md", mimeType: "text/markdown", downloadUrl: "https://files.example.test/a" };
    const fetchAuthorizedFile = vi.fn();
    await expect(resolveAttachments({ jobId: "job", sourceFile, imageFiles: [], imageAssetIds: [], plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] } }, {
      probeResolver: localResolver,
      authorizeFileParam: vi.fn(async () => true), fetchAuthorizedFile,
      allowedOrigins: ["https://files.example.test"],
      resolveHostname: vi.fn(() => new Promise<string[]>(() => undefined)),
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: "DOWNLOAD_TIMEOUT" });
    expect(fetchAuthorizedFile).not.toHaveBeenCalled();
  });

  it("limits a host download by the remaining 50 MiB aggregate quota", async () => {
    const source = markdown;
    const largeImage = new Uint8Array(10 * 1024 * 1024);
    largeImage.set(png, 0);
    const imageRefs: AuthorizedFileParam[] = Array.from({ length: 5 }, (_, index) => ({
      kind: "host-file",
      fileId: `image-${index}`,
      fileName: `photo-${index}.png`,
      mimeType: "image/png",
      downloadUrl: `https://files.example.test/image-${index}`,
    }));
    const ids = imageRefs.map((_, index) => `asset-${index}`);
    const plan: PresentationPlan = {
      version: 1,
      title: "Deck",
      language: "zh-TW",
      themeId: "default",
      sourceDigest: sha(source),
      imageAssetIds: ids,
      assetManifest: imageRefs.map((ref, index) => ({
        assetId: ids[index]!, fileName: ref.fileName, mimeType: "image/png" as const,
        byteLength: largeImage.length, sha256: sha(largeImage),
      })),
      slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }],
    };
    let call = 0;
    const fetchAuthorizedFile = vi.fn(async () => {
      const current = call++;
      if (current === 0) return new Response(source, { status: 200 });
      if (current <= 4) return new Response(largeImage, { status: 200 });
      return new Response(null, { status: 200, headers: { "content-length": String(largeImage.length) } });
    });
    await expect(resolveAttachments({
      jobId: "job", sourceFile: { kind: "host-file", fileId: "source", fileName: "source.md", mimeType: "text/markdown", downloadUrl: "https://files.example.test/source" },
      imageFiles: imageRefs, imageAssetIds: ids, plan,
    }, {
      probeResolver: localResolver,
      authorizeFileParam: vi.fn(async () => true), fetchAuthorizedFile,
      allowedOrigins: ["https://files.example.test"],
      resolveHostname: vi.fn(async () => ["93.184.216.34"]),
      imageDecoder: decoder,
    })).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE", fileName: "photo-4.png" });
    expect(fetchAuthorizedFile).toHaveBeenCalledTimes(6);
  });

  it("rejects cross-origin redirects, non-2xx status, and streamed bytes over quota", async () => {
    const sourceFile: AuthorizedFileParam = { kind: "host-file", fileId: "file-1", fileName: "source.md", mimeType: "text/markdown", downloadUrl: "https://files.example.test/a" };
    const common = {
      probeResolver: localResolver,
      authorizeFileParam: vi.fn(async () => true),
      allowedOrigins: ["https://files.example.test"],
      resolveHostname: vi.fn(async () => ["93.184.216.34"]),
    };
    await expect(resolveAttachments({ jobId: "job", sourceFile, imageFiles: [], imageAssetIds: [], plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] } }, {
      ...common,
      fetchAuthorizedFile: vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://other.example/a" } })),
    })).rejects.toMatchObject({ code: "REDIRECT_BLOCKED" });
    await expect(resolveAttachments({ jobId: "job", sourceFile, imageFiles: [], imageAssetIds: [], plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] } }, {
      ...common,
      fetchAuthorizedFile: vi.fn(async () => new Response("no", { status: 403 })),
    })).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    const tooBig = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); controller.close(); } });
    await expect(resolveAttachments({ jobId: "job", sourceFile, imageFiles: [], imageAssetIds: [], plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] } }, {
      ...common,
      fetchAuthorizedFile: vi.fn(async () => new Response(tooBig, { status: 200 })),
    })).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE" });
  });

  it("times out host downloads after the configured maximum and aborts the request", async () => {
    const sourceFile: AuthorizedFileParam = { kind: "host-file", fileId: "file-1", fileName: "source.md", mimeType: "text/markdown", downloadUrl: "https://files.example.test/a" };
    let signal: AbortSignal | undefined;
    const fetchAuthorizedFile = vi.fn((_url: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<Response>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    await expect(resolveAttachments({ jobId: "job", sourceFile, imageFiles: [], imageAssetIds: [], plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] } }, {
      probeResolver: localResolver,
      authorizeFileParam: vi.fn(async () => true), fetchAuthorizedFile,
      allowedOrigins: ["https://files.example.test"],
      resolveHostname: vi.fn(async () => ["93.184.216.34"]),
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: "DOWNLOAD_TIMEOUT" });
    expect(signal?.aborted).toBe(true);
  });

  it("bounds asynchronous host authorization by the same deadline and aborts its signal", async () => {
    const sourceFile: AuthorizedFileParam = { kind: "host-file", fileId: "file-1", fileName: "source.md", mimeType: "text/markdown", downloadUrl: "https://files.example.test/a" };
    let signal: AbortSignal | undefined;
    const authorizeFileParam = vi.fn((_file: AuthorizedFileParam, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<boolean>(() => undefined);
    });
    const fetchAuthorizedFile = vi.fn();
    await expect(resolveAttachments({ jobId: "job", sourceFile, imageFiles: [], imageAssetIds: [], plan: { ...validPlan(), imageAssetIds: [], assetManifest: [], slides: [{ id: "cover", title: "Deck", layout: "cover", imageIds: [] }] } }, {
      probeResolver: localResolver,
      authorizeFileParam, fetchAuthorizedFile,
      allowedOrigins: ["https://files.example.test"],
      resolveHostname: vi.fn(async () => ["93.184.216.34"]),
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: "DOWNLOAD_TIMEOUT" });
    expect(signal?.aborted).toBe(true);
    expect(fetchAuthorizedFile).not.toHaveBeenCalled();
  }, 250);
});

describe("temporary workspace", () => {
  it("removes its randomized workspace when the job throws", async () => {
    const root = await tempRoot(); temporaryRoots.push(root);
    let workspacePath = "";
    await expect(withTempWorkspace("../not-a-path", async (workspace) => {
      workspacePath = workspace.path;
      await workspace.writeFile("source.md", markdown);
      throw new Error("renderer failed");
    }, { root })).rejects.toThrow("renderer failed");
    expect(workspacePath).toContain(root);
    await expect(stat(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
