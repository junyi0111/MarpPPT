import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresentationPlan } from "../../src/contracts/presentation-plan.js";
import { createLocalArtifactStore } from "../../src/artifacts/local-artifact-store.js";
import { renderPresentation, type RenderPresentationInput, type RenderPresentationDependencies } from "../../src/mcp/tools/render-presentation.js";
import { createContactSheet } from "../../src/preview/contact-sheet.js";
import * as fontCheck from "../../src/preview/font-check.js";
import { loadDefaultTheme } from "../helpers/layout-fixtures.js";

const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
const createdRoots: string[] = [];

async function runFixture(options: {
  mutate?: (input: RenderPresentationInput, bytesByRef: Map<string, Uint8Array>) => void;
  override?: Partial<RenderPresentationDependencies>;
} = {}) {
  const [source, rawPlan, rawRequest] = await Promise.all([
    readFile(join(fixtureRoot, "simple-brief.md")),
    readFile(join(fixtureRoot, "simple-brief.plan.json"), "utf8"),
    readFile(join(fixtureRoot, "simple-brief.request.json"), "utf8"),
  ]);
  const plan = JSON.parse(rawPlan) as PresentationPlan;
  const request = JSON.parse(rawRequest) as { audience: string; targetSlideCount: number; summaryStrength: string };
  const imageFiles = plan.assetManifest.map((asset, index) => ({
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    assetId: `fixture:image-${index + 1}`,
  }));
  const bytesByRef = new Map<string, Uint8Array>([["fixture:source", source]]);
  await Promise.all(imageFiles.map(async (ref) => {
    bytesByRef.set(ref.assetId, await readFile(join(fixtureRoot, "three-images", ref.fileName)));
  }));
  const input: RenderPresentationInput = {
    plan,
    sourceFile: { fileName: "simple-brief.md", mimeType: "text/markdown", assetId: "fixture:source" },
    imageFiles,
    imageAssetIds: [...plan.imageAssetIds],
  };
  options.mutate?.(input, bytesByRef);
  const outputRoot = await mkdtemp(join(tmpdir(), "marpppt-e2e-output-"));
  const tempRoot = await mkdtemp(join(tmpdir(), "marpppt-e2e-input-"));
  createdRoots.push(outputRoot, tempRoot);
  const artifactStore = await createLocalArtifactStore({ outputRoot });
  const dependencies: RenderPresentationDependencies = {
    attachmentResolver: {
      tempRoot,
      probeResolver: {
        read: async (ref) => {
          const bytes = bytesByRef.get(ref.assetId ?? "");
          if (!bytes) throw new Error(`Unknown fixture reference: ${ref.assetId}`);
          return bytes;
        },
      },
    },
    artifactStore,
    theme: loadDefaultTheme(),
    ...options.override,
  };
  const result = await renderPresentation(input, dependencies);
  return { result, plan, request, outputRoot };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("eight-slide end-to-end acceptance", () => {
  it("renders a manager deck with native objects, all three images, matching Marp, and eight preview pages", async () => {
    // Preserve only this synthetic fixture when CI needs raster diagnostics.
    const debugRoot = process.env.MARPPPT_E2E_PREVIEW_DEBUG;
    if (debugRoot) {
      await mkdir(debugRoot, { recursive: true });
      const countTofuGlyphs = fontCheck.countTofuGlyphs;
      vi.spyOn(fontCheck, "countTofuGlyphs").mockImplementation(async (paths) => {
        await Promise.all(paths.map((path, index) => copyFile(path, join(debugRoot, `page-${index + 1}.png`))));
        return countTofuGlyphs(paths);
      });
    }
    const { result, plan, request } = await runFixture();
    expect(request).toEqual({ audience: "managers", targetSlideCount: 8, summaryStrength: "moderate" });
    expect(result.status, JSON.stringify(result)).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.slideCount).toBe(8);
    expect(result.imageUsage).toEqual([
      { assetId: "image-1", fileName: "capacity.png", slideIds: ["capacity"] },
      { assetId: "image-2", fileName: "workflow.png", slideIds: ["workflow"] },
      { assetId: "image-3", fileName: "timeline.png", slideIds: ["timeline"] },
    ]);
    expect(result.validation.pptx).toMatchObject({
      slideCount: 8,
      fullSlidePictureCount: 0,
      slideBoundsValid: true,
      relationshipsValid: true,
      embeddedMediaCount: 3,
    });
    expect(result.validation.pptx.textShapeCount).toBeGreaterThan(8);
    expect(result.validation.pptx.pictureCount).toBeGreaterThanOrEqual(3);
    expect(result.validation.pptx.tableCount).toBeGreaterThanOrEqual(1);
    expect(result.validation.preview).toMatchObject({ status: "ready", pageCount: 8 });
    expect(result.validation.visualQaPassed).toBe(false);
    expect(result.previews).toHaveLength(8);
    const [pptxBytes, marpText, bundleBytes] = await Promise.all([
      readFile(new URL(result.pptx.uri)),
      readFile(new URL(result.marp.uri), "utf8"),
      readFile(new URL(result.marpBundle!.uri)),
    ]);
    expect(pptxBytes.subarray(0, 2).toString()).toBe("PK");
    const pptxEntries = unzipSync(pptxBytes);
    expect(Object.keys(pptxEntries).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(8);
    const frontMatterEnd = marpText.indexOf("\n---\n", 4);
    expect(frontMatterEnd).toBeGreaterThan(0);
    const marpSlides = marpText.slice(frontMatterEnd + 5).split(/\n---\n/u);
    expect(marpSlides).toHaveLength(8);
    expect(marpSlides.map((body) => /^# ([^\n]+)$/mu.exec(body)?.[1])).toEqual(plan.slides.map((slide) => slide.title));
    const expectedContentBySlide = [
      ["2026 年第 4 季", "四週試行"],
      ["限於兩個內部流程", "負責人每週檢查進度", "品質未達標時暫停擴大"],
      ["自動分類只提供建議", "assets/image-2.png"],
      ["### 方案 A", "沿用人工分派", "### 方案 B", "人工確認並留稽核紀錄"],
      ["| 指標 | 現況 | 四週目標 |", "| 平均回覆時間 | 48 小時 | 24 小時 |"],
      ["正式決策以指標表為準", "assets/image-1.png"],
      ["node baseline: 第 1 週基線", "node review: 未達標則停止擴大"],
      ["2026 年第 4 季試行四週", "assets/image-3.png"],
    ];
    expectedContentBySlide.forEach((expectedParts, index) => {
      for (const expected of expectedParts) expect(marpSlides[index]).toContain(expected);
    });
    const bundle = unzipSync(bundleBytes);
    for (const id of ["image-1", "image-2", "image-3"]) {
      expect(bundle[`assets/${id}.png`]).toBeDefined();
    }
    const marpName = result.marp.fileName;
    expect(strFromU8(bundle[marpName]!)).toBe(marpText);

    const contactSheetOutput = process.env.MARPPPT_E2E_CONTACT_SHEET;
    if (contactSheetOutput) {
      const sheetRoot = await mkdtemp(join(tmpdir(), "marpppt-e2e-sheet-"));
      createdRoots.push(sheetRoot);
      const pngPaths = result.previews.map((preview) => fileURLToPath(preview.uri));
      const sheet = await createContactSheet(pngPaths, sheetRoot);
      await writeFile(contactSheetOutput, await readFile(sheet));
    }
  }, 180_000);

  it("returns a typed failure when a planned image attachment is missing", async () => {
    const { result } = await runFixture({ mutate: (input) => {
      input.imageFiles.splice(1, 1);
      input.imageAssetIds.splice(1, 1);
    } });
    expect(result).toMatchObject({ status: "failed", failure: { code: "REFERENCE_MISSING", stage: "attachments", affectedFileOrSlide: "workflow.png" } });
  });

  it("rejects a corrupt PNG before publishing artifacts", async () => {
    const { result, outputRoot } = await runFixture({ mutate: (_input, bytes) => { bytes.set("fixture:image-2", Buffer.from("not a PNG")); } });
    expect(result).toMatchObject({ status: "failed", failure: { code: "IMAGE_INVALID", stage: "attachments" } });
    await expect((await import("node:fs/promises")).readdir(outputRoot)).resolves.toEqual([]);
  });

  it("rejects 31 images and 61 slides as typed input failures", async () => {
    const tooManyImages = await runFixture({ mutate: (input) => {
      const template = input.imageFiles[0]!;
      for (let index = 3; index < 31; index++) input.imageFiles.push({ ...template, assetId: `fixture:extra-${index}` });
    } });
    expect(tooManyImages.result).toMatchObject({ status: "failed", failure: { code: "PLAN_INVALID", stage: "input" } });
    const tooManySlides = await runFixture({ mutate: (input) => {
      while (input.plan.slides.length < 61) input.plan.slides.push({ ...input.plan.slides[1]!, id: `extra-${input.plan.slides.length}` });
    } });
    expect(tooManySlides.result).toMatchObject({ status: "failed", failure: { code: "PLAN_INVALID", stage: "input" } });
  });

  it("rejects an external image URL without an authorized host adapter", async () => {
    const { result } = await runFixture({ mutate: (input) => {
      input.imageFiles[0] = {
        kind: "host-file", fileId: "external-1", fileName: "capacity.png", mimeType: "image/png",
        downloadUrl: "https://example.com/image.png",
      };
    } });
    expect(result).toMatchObject({ status: "failed", failure: { code: "ATTACHMENT_UNREADABLE", stage: "attachments" } });
  });

  it("reports draft when real preview output cannot be produced", async () => {
    const { result } = await runFixture({ override: { preview: async () => { throw new Error("preview binary unavailable"); } } });
    expect(result).toMatchObject({ status: "draft", slideCount: 8, validation: { preview: { status: "draft", pageCount: 0 }, visualQaPassed: false } });
    if (result.status === "draft") expect(result.previews).toEqual([]);
  });
});
