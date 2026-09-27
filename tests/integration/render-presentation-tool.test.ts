import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresentationPlan } from "../../src/contracts/presentation-plan.js";
import { serializeMarp as serializeRealMarp } from "../../src/marp/serialize-marp.js";
import type { PreviewReport } from "../../src/preview/render-preview.js";
import { buildSlideLayout } from "../../src/layout/build-slide.js";
import { getCanvas } from "../../src/layout/geometry.js";
import { findOverflow } from "../../src/layout/overflow.js";
import { createLocalArtifactStore } from "../../src/artifacts/local-artifact-store.js";
import { renderPresentation, type RenderFinalizedEvent } from "../../src/mcp/tools/render-presentation.js";
import { createFontThemeCatalog } from "../../src/theme/font-presets.js";
import { loadDefaultTheme } from "../helpers/layout-fixtures.js";

const pptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const sourceBytes = Buffer.from("# Cache compression\n\nThree key facts for the deck.\n", "utf8");

async function makeFixture(slideCount = 1) {
  const imageBytes = await sharp({ create: { width: 16, height: 12, channels: 4, background: "#336699" } }).png().toBuffer();
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const imageRefs = [
    { fileName: "used-cache.png", mimeType: "image/png", assetId: "stage:used" },
    { fileName: "unmapped-architecture.png", mimeType: "image/png", assetId: "stage:appendix" },
  ];
  const slides = Array.from({ length: slideCount }, (_, index) => ({
    id: `slide-${index + 1}`,
    title: `Key point ${index + 1}`,
    layout: index === 0 ? "image-text" as const : "bullets" as const,
    blocks: [
      { id: `fact-${index + 1}-1`, text: "Keep the source values" },
      { id: `fact-${index + 1}-2`, text: "Use bounded compression" },
      { id: `fact-${index + 1}-3`, text: "Validate the measured result" },
    ],
    imageIds: index === 0 ? ["image-1"] : [],
    sourceRefs: ["## Key points"],
  }));
  const plan: PresentationPlan = {
    version: 1,
    title: "KV cache compression",
    language: "en",
    themeId: "default",
    sourceDigest: sha256(sourceBytes),
    slides,
    imageAssetIds: ["image-1", "image-2"],
    assetManifest: imageRefs.map((ref, index) => ({
      assetId: `image-${index + 1}`,
      fileName: ref.fileName,
      mimeType: "image/png" as const,
      byteLength: imageBytes.byteLength,
      sha256: sha256(imageBytes),
    })),
  };
  return { plan, imageRefs, imageBytes };
}

function readyPreview(paths: string[]): PreviewReport {
  return {
    status: "ready",
    slideCount: paths.length,
    pdfPageCount: paths.length,
    pageCount: paths.length,
    pdfPath: null,
    pngPaths: paths,
    contactSheetPath: null,
    font: { requested: "Noto Sans CJK TC", selected: "Noto Sans CJK TC", substituted: false },
    warnings: [],
    errors: [],
    visualQaPassed: false,
  };
}

describe("render_presentation pipeline", () => {
  let outputRoot: string;
  const tempRoots: string[] = [];

  beforeEach(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), "marpppt-render-output-"));
  });

  afterEach(async () => {
    await Promise.all([rm(outputRoot, { recursive: true, force: true }), ...tempRoots.map((path) => rm(path, { recursive: true, force: true }))]);
    tempRoots.length = 0;
  });

  async function setup(slideCount = 1, overrides: Record<string, unknown> = {}) {
    const fixture = await makeFixture(slideCount);
    const localStore = await createLocalArtifactStore({ outputRoot });
    const refs = new Map<string, Uint8Array>([
      ["source.md", sourceBytes],
      ["used-cache.png", fixture.imageBytes],
      ["unmapped-architecture.png", fixture.imageBytes],
    ]);
    const input = {
      plan: fixture.plan,
      sourceFile: { fileName: "source.md", mimeType: "text/markdown", assetId: "stage:source" },
      imageFiles: fixture.imageRefs,
      imageAssetIds: ["image-1", "image-2"],
    };
    const deps = {
      attachmentResolver: {
        probeResolver: { read: async (ref: { fileName: string }) => refs.get(ref.fileName)! },
      },
      artifactStore: localStore,
      theme: loadDefaultTheme(),
      preview: async (_pptxPath: string, workDir: string) => {
        const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#00aa55" } }).png().toBuffer();
        const previewPaths: string[] = [];
        for (let index = 1; index <= 2; index++) {
          const previewPath = join(workDir, `page-${index}.png`);
          await writeFile(previewPath, png, { flag: "wx", mode: 0o600 });
          previewPaths.push(previewPath);
        }
        return readyPreview(previewPaths);
      },
      ...overrides,
    };
    return { fixture, input, deps, localStore, refs };
  }

  it("renders editable PPTX and Marp from one final plan and bundles all received images", async () => {
    const { input, deps } = await setup();
    const finalizations: RenderFinalizedEvent[] = [];
    let pptxPlan: PresentationPlan | undefined;
    let marpPlan: PresentationPlan | undefined;
    const result = await renderPresentation(input, {
      ...deps,
      onRenderFinalized: (event) => finalizations.push(event),
      renderPptx: async (plan: PresentationPlan, assets: unknown[], theme: unknown) => {
        pptxPlan = plan;
        const { renderPptx } = await import("../../src/pptx/render-pptx.js");
        return renderPptx(plan, assets as never[], theme as never);
      },
      serializeMarp: (plan: PresentationPlan, theme: unknown) => {
        marpPlan = plan;
        return serializeRealMarp(plan, theme as never);
      },
    });

    expect(result.status).toBe("completed");
    expect(finalizations).toMatchObject([{
      jobId: result.jobId,
      status: "completed",
      cleanupOutcome: "succeeded",
      durationMs: expect.any(Number),
    }]);
    expect(JSON.stringify(finalizations)).not.toMatch(/source\.md|used-cache\.png|stage:|private\/tmp|Three key facts/u);
    if (result.status !== "completed") return;
    expect(pptxPlan).toEqual(marpPlan);
    expect(pptxPlan?.slides).toHaveLength(2);
    expect(pptxPlan?.slides[1]).toMatchObject({ id: "appendix-image-1", layout: "image", imageIds: ["image-2"] });
    expect(result.pptx.mimeType).toBe(pptxMime);
    const serializedMarp = (await readFile(new URL(result.marp.uri))).toString("utf8");
    expect(serializedMarp).toContain("assets/image-1.png");
    expect(serializedMarp).toContain("assets/image-2.png");
    expect(result.marpBundle).toBeDefined();
    expect(result.previews).toHaveLength(2);
    expect(result.validation.visualQaPassed).toBe(false);
    expect(result.imageUsage).toEqual([
      { assetId: "image-1", fileName: "used-cache.png", slideIds: ["slide-1"] },
      { assetId: "image-2", fileName: "unmapped-architecture.png", slideIds: ["appendix-image-1"] },
    ]);

    const bundleBytes = await readFile(new URL(result.marpBundle!.uri));
    const bundle = unzipSync(bundleBytes);
    expect(Object.keys(bundle).sort()).toEqual(["assets/image-1.png", "assets/image-2.png", "kv-cache-compression.marp.md"].sort());
    expect(strFromU8(bundle["kv-cache-compression.marp.md"]!)).toContain("marp: true");
  });

  it("passes the selected font theme to both PPTX and Marp renderers", async () => {
    const { input, deps } = await setup();
    input.plan.themeId = "default-serif";
    deps.themes = createFontThemeCatalog(deps.theme);
    let pptxFont = "";
    let marpFont = "";
    const result = await renderPresentation(input, {
      ...deps,
      renderPptx: async (plan: PresentationPlan, assets: unknown[], theme: unknown) => {
        pptxFont = (theme as { typography: { fontFace: string } }).typography.fontFace;
        const { renderPptx } = await import("../../src/pptx/render-pptx.js");
        return renderPptx(plan, assets as never[], theme as never);
      },
      serializeMarp: (plan: PresentationPlan, theme: unknown) => {
        marpFont = (theme as { typography: { fontFace: string } }).typography.fontFace;
        return serializeRealMarp(plan, theme as never);
      },
    });

    expect(result.status).toBe("completed");
    expect(pptxFont).toBe("Noto Serif CJK TC");
    expect(marpFont).toBe("Noto Serif CJK TC");
  });

  it("reports a failed input result with no cleanup required", async () => {
    const { deps } = await setup();
    const finalizations: RenderFinalizedEvent[] = [];
    const result = await renderPresentation({}, {
      ...deps,
      onRenderFinalized: (event) => finalizations.push(event),
    });

    expect(result).toMatchObject({ status: "failed", failure: { code: "SOURCE_MISSING" } });
    expect(finalizations).toMatchObject([{
      jobId: result.jobId,
      status: "failed",
      errorCode: "SOURCE_MISSING",
      cleanupOutcome: "not-needed",
      durationMs: expect.any(Number),
    }]);
  });

  it("rejects an editorial brief before rendering when its source digest is stale", async () => {
    const { input, deps } = await setup();
    (input as Record<string, unknown>).editorialBrief = {
      version: 1,
      sourceDigest: "0".repeat(64),
      audience: "產品團隊",
      purpose: "說明關鍵指標",
      useCase: "presenting",
      requestedSlideCount: 1,
      mustKeepFacts: [],
      assets: [],
      slides: [{
        slideId: "slide-1",
        purpose: "說明關鍵指標",
        evidence: [],
        factIds: [],
        form: "summary",
        variant: "default",
        focus: { kind: "block", id: "fact-1-1" },
        limitations: [],
        speakerNotes: [],
      }],
    };
    const result = await renderPresentation(input, deps);
    expect(result).toMatchObject({ status: "failed", failure: { code: "EDITORIAL_SOURCE_DIGEST_MISMATCH", stage: "plan" } });
  });

  it("does not append an unplanned image page beyond an editorial page cap", async () => {
    const { input, deps, fixture } = await setup();
    (input as Record<string, unknown>).editorialBrief = {
      version: 1,
      sourceDigest: fixture.plan.sourceDigest,
      audience: "產品團隊",
      purpose: "只交付一頁",
      useCase: "presenting",
      requestedSlideCount: 1,
      mustKeepFacts: [],
      assets: [],
      slides: [{
        slideId: "slide-1", purpose: "交付一頁", evidence: [], factIds: [], form: "summary", variant: "default",
        focus: { kind: "block", id: "fact-1-1" }, limitations: [], speakerNotes: [],
      }],
    };
    const result = await renderPresentation(input, deps);
    expect(result).toMatchObject({ status: "failed", failure: { code: "EDITORIAL_PAGE_CAPACITY", stage: "plan" } });
  });

  it("deletes already-published files when the published output fails schema validation", async () => {
    const { input, deps, localStore } = await setup();
    let putCount = 0;
    const result = await renderPresentation(input, {
      ...deps,
      artifactStore: {
        put: async (...args) => {
          const ref = await localStore.put(...args);
          putCount += 1;
          return putCount === 2 ? { ...ref, fileName: "" } : ref;
        },
        deleteJob: (jobId) => localStore.deleteJob(jobId),
      },
    });

    expect(result).toMatchObject({ status: "failed", failure: { code: "ARTIFACT_UNOPENABLE", stage: "publish" } });
    expect(putCount).toBe(5);
    expect(await readdir(outputRoot)).toEqual([]);
    await localStore.close?.();
  });

  it("reports a failed cleanup without copying its error details into telemetry", async () => {
    const { input, deps, localStore } = await setup();
    input.plan.slides[0]!.title = "很長的標題".repeat(25);
    const finalizations: RenderFinalizedEvent[] = [];
    const result = await renderPresentation(input, {
      ...deps,
      artifactStore: {
        put: (...args) => localStore.put(...args),
        deleteJob: async () => { throw new Error("private cleanup path must not be logged"); },
      },
      onRenderFinalized: (event) => finalizations.push(event),
    });

    expect(result).toMatchObject({ status: "failed", failure: { code: "SUMMARY_REQUIRED" } });
    expect(finalizations).toMatchObject([{
      jobId: result.jobId,
      status: "failed",
      errorCode: "SUMMARY_REQUIRED",
      cleanupOutcome: "failed",
      durationMs: expect.any(Number),
    }]);
    expect(JSON.stringify(finalizations)).not.toContain("private cleanup path");
  });

  it("returns a draft with no preview refs when preview rendering fails", async () => {
    const { input, deps } = await setup(1, {
      preview: async () => ({ ...readyPreview(["/removed"]), status: "draft", errors: [{ code: "PREVIEW_UNAVAILABLE", stage: "soffice", message: "Renderer unavailable." }] }),
    });
    const result = await renderPresentation(input, deps);
    expect(result.status).toBe("draft");
    if (result.status === "draft") {
      expect(result.previews).toEqual([]);
      expect(result.validation.visualQaPassed).toBe(false);
      expect(result.warnings.join(" ")).toMatch(/preview|預覽/i);
    }
  });

  it("returns a typed fatal result, retries PPTX inspection once, publishes no artifacts, and cleans the workspace", async () => {
    const inspectPptx = vi.fn(async () => { throw new Error("invalid PPTX"); });
    let workspacePath: string | undefined;
    const { input, deps, localStore } = await setup(1, {
      inspectPptx,
      renderPptx: async (plan: PresentationPlan, assets: unknown[], theme: unknown) => {
        workspacePath = dirname((assets[0] as { path: string }).path);
        const { renderPptx } = await import("../../src/pptx/render-pptx.js");
        return renderPptx(plan, assets as never[], theme as never);
      },
      preview: async (_pptxPath: string, workDir: string) => {
        workspacePath = workDir;
        return readyPreview([join(workDir, "unused.png")]);
      },
    });
    const result = await renderPresentation(input, deps);

    expect(result.status).toBe("failed");
    expect(inspectPptx).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ failure: { code: "RENDER_FAILED", stage: "verify", retryable: true } });
    expect((await readdir(outputRoot)).filter((name) => name !== ".DS_Store")).toEqual([]);
    expect(workspacePath).toBeDefined();
    await expect(access(workspacePath!)).rejects.toMatchObject({ code: "ENOENT" });
    await localStore.close?.();
  });

  it("returns exact layout issue IDs without calling either serializer", async () => {
    const { input, deps } = await setup(1);
    input.plan.slides[0]!.title = "很長的標題".repeat(25);
    const renderPptx = vi.fn();
    const serializeMarp = vi.fn();
    const result = await renderPresentation(input, { ...deps, renderPptx, serializeMarp });

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      failure: { code: "SUMMARY_REQUIRED", stage: "plan", affectedFileOrSlide: "slide-1" },
      validation: { issues: [{ slideId: "slide-1", objectId: "slide-1:title" }] },
    });
    expect(renderPptx).not.toHaveBeenCalled();
    expect(serializeMarp).not.toHaveBeenCalled();
  });

  it("fails actionably instead of dropping appendix images when the slide cap is reached", async () => {
    const { input, deps } = await setup(60);
    const renderPptx = vi.fn();
    const result = await renderPresentation(input, { ...deps, renderPptx });
    expect(result).toMatchObject({ status: "failed", failure: { code: "PRESENTATION_LIMIT_EXCEEDED", stage: "plan", retryable: false } });
    expect(renderPptx).not.toHaveBeenCalled();
  });

  it("keeps the full long filename traceable without overflowing the appendix title", async () => {
    const { fixture, input, deps, refs } = await setup();
    const priorRef = input.imageFiles[1]!;
    const longFileName = `cache-${"x".repeat(238)}.png`;
    input.imageFiles[1] = { ...priorRef, fileName: longFileName };
    input.plan.assetManifest[1]!.fileName = longFileName;
    refs.delete(priorRef.fileName);
    refs.set(longFileName, fixture.imageBytes);

    let renderedPlan: PresentationPlan | undefined;
    const result = await renderPresentation(input, {
      ...deps,
      serializeMarp: (plan, theme) => {
        renderedPlan = plan;
        return serializeRealMarp(plan, theme as never);
      },
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(Array.from(renderedPlan!.slides[1]!.title).length).toBeLessThanOrEqual(22);
    expect(result.imageUsage[1]).toMatchObject({ assetId: "image-2", fileName: longFileName, slideIds: ["appendix-image-1"] });
    const serializedMarp = (await readFile(new URL(result.marp.uri))).toString("utf8");
    expect(serializedMarp).toContain(`![cache\\-${"x".repeat(238)}\\.png](assets/image-2.png)`);
  });

  it("keeps a long Traditional Chinese filename traceable while its appendix title passes overflow validation", async () => {
    const { fixture, input, deps, refs } = await setup();
    const priorRef = input.imageFiles[1]!;
    const longFileName = `${"圖".repeat(72)}.png`;
    input.imageFiles[1] = { ...priorRef, fileName: longFileName };
    input.plan.assetManifest[1]!.fileName = longFileName;
    refs.delete(priorRef.fileName);
    refs.set(longFileName, fixture.imageBytes);

    let renderedPlan: PresentationPlan | undefined;
    const result = await renderPresentation(input, {
      ...deps,
      serializeMarp: (plan, theme) => {
        renderedPlan = plan;
        return serializeRealMarp(plan, theme as never);
      },
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const appendixSlide = renderedPlan!.slides.find((slide) => slide.id === "appendix-image-1")!;
    expect(Array.from(appendixSlide.title).length).toBeLessThanOrEqual(22);
    expect(findOverflow(buildSlideLayout(appendixSlide, deps.theme), getCanvas(deps.theme))).toEqual([]);
    expect(result.imageUsage[1]).toMatchObject({ assetId: "image-2", fileName: longFileName, slideIds: ["appendix-image-1"] });
    const serializedMarp = (await readFile(new URL(result.marp.uri))).toString("utf8");
    expect(serializedMarp).toContain(`![${"圖".repeat(72)}\\.png](assets/image-2.png)`);
  });

  it("rejects model-supplied paths before invoking the resolver", async () => {
    const { input, deps } = await setup();
    input.sourceFile = { ...input.sourceFile, path: "/private/document.md" } as typeof input.sourceFile;
    const read = vi.fn(async () => sourceBytes);
    const result = await renderPresentation(input, { ...deps, attachmentResolver: { probeResolver: { read } } });
    expect(result).toMatchObject({ status: "failed", failure: { code: "PLAN_INVALID", stage: "input" } });
    expect(read).not.toHaveBeenCalled();
  });
});
