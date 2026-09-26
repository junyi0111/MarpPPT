import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { PresentationPlan } from "../../src/contracts/presentation-plan.js";
import { renderPptx, inspectPptx, PptxRenderError } from "../../src/pptx/render-pptx.js";
import { loadDefaultTheme, makeMixedDeckFixture, makeResolvedImagePathFixture } from "../helpers/layout-fixtures.js";

const defaultTheme = loadDefaultTheme();
let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function makePptxFixture(): Promise<{
  plan: PresentationPlan;
  assets: Array<Awaited<ReturnType<typeof makeResolvedImagePathFixture>>>;
}> {
  const root = await mkdtemp(join(tmpdir(), "marpppt-pptx-"));
  roots.push(root);
  const image = await makeResolvedImagePathFixture("image-1", "photo.png", root);
  const plan = makeMixedDeckFixture();
  plan.slides = plan.slides.filter((slide) => slide.layout !== "image"); // keep one image placement for exact object-count assertions
  const { path: _path, ...manifest } = image;
  plan.assetManifest = [manifest];
  return { plan, assets: [image] };
}

function overflowPlan(base: PresentationPlan, kind: "summary" | "split"): PresentationPlan {
  const plan = structuredClone(base);
  const slide = plan.slides.find((item) => item.layout === "bullets");
  if (!slide || slide.layout !== "bullets") throw new Error("Fixture requires a bullets slide");
  if (kind === "summary") {
    slide.title = "標題需要摘要".repeat(15);
  } else {
    slide.blocks[0]!.text = "Long source-preserving content ".repeat(18);
  }
  return plan;
}

describe("editable PPTX renderer", () => {
  it("writes separate text and picture objects plus native editable tables and charts", async () => {
    const { plan, assets } = await makePptxFixture();
    const bytes = await renderPptx(plan, assets, defaultTheme);
    const inspection = await inspectPptx(bytes);
    expect(inspection.slideCount).toBe(plan.slides.length);
    expect(inspection.textShapeCount).toBeGreaterThanOrEqual(6);
    expect(inspection.pictureCount).toBe(1);
    expect(inspection.tableCount).toBe(1);
    expect(inspection.chartCount).toBe(1);
    expect(inspection.fullSlidePictureCount).toBe(0);
    expect(inspection.slideBoundsValid).toBe(true);
    expect(inspection.embeddedMediaCount).toBe(1);
  });

  it("rejects a plan whose theme ID differs from the selected theme before serialization", async () => {
    const { plan, assets } = await makePptxFixture();
    const mismatchedTheme = { ...defaultTheme, id: "another-theme" };
    await expect(renderPptx(plan, assets, mismatchedTheme)).rejects.toMatchObject({
      code: "THEME_MISMATCH",
    });
  });

  it("blocks export when a resolved image has no planned appendix slide", async () => {
    const { plan, assets } = await makePptxFixture();
    const unusedAsset = { ...plan.assetManifest[0]!, assetId: "image-2", fileName: "unused.png" };
    plan.imageAssetIds.push(unusedAsset.assetId);
    plan.assetManifest.push(unusedAsset);
    const unusedPath = { ...assets[0]!, assetId: unusedAsset.assetId, fileName: unusedAsset.fileName };
    await expect(renderPptx(plan, [...assets, unusedPath], defaultTheme)).rejects.toMatchObject({
      code: "PLAN_INVALID",
      issues: expect.arrayContaining([expect.objectContaining({ code: "UNUSED_IMAGE_ID", imageId: "image-2", severity: "warning" })]),
    });
  });

  it.each(["bar", "line", "pie"] as const)("writes %s charts as native PowerPoint charts", async (chartKind) => {
    const { plan, assets } = await makePptxFixture();
    const chartSlide = plan.slides.find((slide) => slide.layout === "chart");
    if (!chartSlide || chartSlide.layout !== "chart") throw new Error("Fixture requires a chart slide");
    chartSlide.chart.kind = chartKind;
    const bytes = await renderPptx(plan, assets, defaultTheme);
    expect((await inspectPptx(bytes)).chartCount).toBe(1);
    const chartXml = Object.entries(unzipSync(bytes))
      .filter(([name]) => /^ppt\/charts\/chart\d+\.xml$/u.test(name))
      .map(([, content]) => strFromU8(content))
      .join("\n");
    expect(chartXml).toContain('sz="1200"');
  });

  it("keeps editable chart axis labels at the theme note font floor", async () => {
    const { plan, assets } = await makePptxFixture();
    const chartSlide = plan.slides.find((slide) => slide.layout === "chart");
    if (!chartSlide || chartSlide.layout !== "chart") throw new Error("Fixture requires a chart slide");
    chartSlide.chart.kind = "bar";
    const bytes = await renderPptx(plan, assets, defaultTheme);
    const chartXml = Object.entries(unzipSync(bytes))
      .filter(([name]) => /^ppt\/charts\/chart\d+\.xml$/u.test(name))
      .map(([, content]) => strFromU8(content))
      .join("\n");
    const axisFonts = [...chartXml.matchAll(/<c:(?:catAx|valAx)>[\s\S]*?<c:txPr>[\s\S]*?<a:defRPr[^>]*?sz="(\d+)"/gu)]
      .map((match) => Number(match[1]));
    expect(axisFonts.length).toBe(2);
    expect(axisFonts.every((fontSize) => fontSize >= defaultTheme.typography.minNote * 100)).toBe(true);
  });

  it.each([
    ["summary", "SUMMARY_REQUIRED", "bullets:title"],
    ["split", "SPLIT_REQUIRED", "bullets:text:b1"],
  ] as const)("blocks export when layout analysis returns %s", async (kind, code, objectId) => {
    const { plan, assets } = await makePptxFixture();
    await expect(renderPptx(overflowPlan(plan, kind), assets, defaultTheme)).rejects.toMatchObject({
      code: "PPTX_LAYOUT_INVALID",
      issues: expect.arrayContaining([expect.objectContaining({ code, objectId })]),
    });
  });

  it("blocks out-of-bounds objects before export and keeps affected object IDs", async () => {
    const { plan, assets } = await makePptxFixture();
    const narrowTheme = { ...defaultTheme, canvas: { width: 1, height: 7.5 } };
    try {
      await renderPptx(plan, assets, narrowTheme);
      throw new Error("Expected the layout gate to reject an out-of-bounds object");
    } catch (error) {
      expect(error).toBeInstanceOf(PptxRenderError);
      expect(error).toMatchObject({
        code: "PPTX_LAYOUT_INVALID",
        issues: expect.arrayContaining([expect.objectContaining({ code: "LAYOUT_OVERFLOW", slideId: expect.any(String), objectId: expect.any(String) })]),
      });
    }
  });

  it("rejects absent image paths instead of generating a partial deck", async () => {
    const { plan, assets } = await makePptxFixture();
    await expect(renderPptx(plan, [{ ...assets[0]!, path: join(tmpdir(), "missing-marp-ppt.png") }], defaultTheme))
      .rejects.toMatchObject({ code: "PPTX_ASSET_MISSING", assetId: "image-1" });
  });

  it.each(["https://example.invalid/photo.png", "file:///etc/passwd", "../photo.png"])("rejects non-resolved image path %s", async (path) => {
    const { plan, assets } = await makePptxFixture();
    await expect(renderPptx(plan, [{ ...assets[0]!, path }], defaultTheme))
      .rejects.toMatchObject({ code: "PPTX_ASSET_INVALID", assetId: "image-1" });
  });

  it.each([
    ["blank deck title", (plan: PresentationPlan) => { plan.title = " "; }],
    ["missing source refs", (plan: PresentationPlan) => {
      const slide = plan.slides.find((item) => item.layout === "bullets");
      if (!slide) throw new Error("Fixture requires a bullets slide");
      slide.sourceRefs = [];
    }],
    ["mismatched chart labels", (plan: PresentationPlan) => {
      const slide = plan.slides.find((item) => item.layout === "chart");
      if (!slide || slide.layout !== "chart") throw new Error("Fixture requires a chart slide");
      slide.chart.series[0]!.values = [1];
    }],
  ] as const)("rejects malformed plan input: %s", async (_description, change) => {
    const { plan, assets } = await makePptxFixture();
    change(plan);
    await expect(renderPptx(plan, assets, defaultTheme)).rejects.toMatchObject({ code: "PLAN_INVALID" });
  });

  it("rejects image bytes whose digest differs from the canonical manifest", async () => {
    const { plan, assets } = await makePptxFixture();
    await expect(renderPptx(plan, [{ ...assets[0]!, sha256: "c".repeat(64) }], defaultTheme))
      .rejects.toMatchObject({ code: "PPTX_ASSET_INVALID", assetId: "image-1" });
  });

  it("rejects image bytes that no longer contain the validated PNG", async () => {
    const { plan, assets } = await makePptxFixture();
    await writeFile(assets[0]!.path, Buffer.from("not a PNG"));
    await expect(renderPptx(plan, assets, defaultTheme))
      .rejects.toMatchObject({ code: "PPTX_ASSET_INVALID", assetId: "image-1" });
  });

  it("blocks duplicate diagram connectors reported by layout analysis", async () => {
    const { plan, assets } = await makePptxFixture();
    const diagram = plan.slides.find((slide) => slide.layout === "diagram");
    if (!diagram || diagram.layout !== "diagram") throw new Error("Fixture requires a diagram slide");
    diagram.diagram.edges.push({ ...diagram.diagram.edges[0]! });
    await expect(renderPptx(plan, assets, defaultTheme)).rejects.toMatchObject({
      code: "PPTX_LAYOUT_INVALID",
      issues: expect.arrayContaining([expect.objectContaining({ code: "SUMMARY_REQUIRED", objectId: "diagram:edge:1" })]),
    });
  });
});
