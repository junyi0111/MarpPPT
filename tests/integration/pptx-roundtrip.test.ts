import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pptxgen from "pptxgenjs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { PresentationPlan } from "../../src/contracts/presentation-plan.js";
import { inspectPptx, renderPptx } from "../../src/pptx/render-pptx.js";
import { loadDefaultTheme, makeMixedDeckFixture, makeResolvedImagePathFixture } from "../helpers/layout-fixtures.js";

const defaultTheme = loadDefaultTheme();
let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function makeTwoSlideDeck(): Promise<Uint8Array> {
  const plan = makeMixedDeckFixture();
  plan.slides = plan.slides.slice(0, 2);
  plan.imageAssetIds = [];
  plan.assetManifest = [];
  return renderPptx(plan, [], defaultTheme);
}

async function makeDeckWithImage(): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), "marpppt-media-validation-"));
  roots.push(root);
  const image = await makeResolvedImagePathFixture("image-1", "photo.png", root);
  const plan = makeMixedDeckFixture();
  plan.slides = plan.slides.filter((slide) => slide.layout !== "image");
  const { path: _path, ...manifest } = image;
  plan.assetManifest = [manifest];
  return renderPptx(plan, [image], defaultTheme);
}

describe("PPTX OOXML round trip", () => {
  it("reopens a mixed deck with native text, picture, table, chart, diagram shapes, and media", async () => {
    const root = await mkdtemp(join(tmpdir(), "marpppt-roundtrip-"));
    roots.push(root);
    const image = await makeResolvedImagePathFixture("image-1", "photo.png", root);
    const plan: PresentationPlan = makeMixedDeckFixture();
    plan.slides = plan.slides.filter((slide) => slide.layout !== "image");
    const { path: _path, ...manifest } = image;
    plan.assetManifest = [manifest];
    const bytes = await renderPptx(plan, [image], defaultTheme);
    const inspection = await inspectPptx(bytes);

    expect(inspection).toMatchObject({
      slideCount: plan.slides.length,
      pictureCount: 1,
      tableCount: 1,
      chartCount: 1,
      fullSlidePictureCount: 0,
      slideBoundsValid: true,
      embeddedMediaCount: 1,
      relationshipsValid: true,
    });
    expect(inspection.shapeCount).toBeGreaterThan(inspection.textShapeCount);
  });

  it("rejects malformed ZIP data and a package without slide relationships", async () => {
    await expect(inspectPptx(new TextEncoder().encode("not a PowerPoint"))).rejects.toMatchObject({ code: "PPTX_INVALID" });
    await expect(inspectPptx(new Uint8Array())).rejects.toMatchObject({ code: "PPTX_INVALID" });

    const packageWithoutPresentationRels = zipSync({
      "[Content_Types].xml": strToU8("<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/></Types>"),
      "ppt/presentation.xml": strToU8("<?xml version=\"1.0\"?><p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId1\"/></p:sldIdLst></p:presentation>"),
    });
    await expect(inspectPptx(packageWithoutPresentationRels)).rejects.toMatchObject({ code: "PPTX_INVALID" });
  });

  it("rejects malformed XML even when the ZIP container is valid", async () => {
    const malformedXmlPackage = zipSync({
      "[Content_Types].xml": strToU8("<Types>"),
      "ppt/presentation.xml": strToU8("<p:presentation><p:sldIdLst/></p:presentation>"),
      "ppt/_rels/presentation.xml.rels": strToU8("<Relationships/>")
    });
    await expect(inspectPptx(malformedXmlPackage)).rejects.toMatchObject({ code: "PPTX_INVALID" });
  });

  it.each([
    ["a second root element", "<Extra/>"],
    ["non-whitespace text after the root", "stray text"],
  ])("rejects XML with %s", async (_description, trailingContent) => {
    const archive = unzipSync(await makeTwoSlideDeck());
    const contentTypes = strFromU8(archive["[Content_Types].xml"]!);
    archive["[Content_Types].xml"] = strToU8(`${contentTypes}${trailingContent}`);
    await expect(inspectPptx(zipSync(archive))).rejects.toMatchObject({ code: "PPTX_INVALID" });
  });

  it("rejects duplicate slide relationship targets that leave a slide part orphaned", async () => {
    const archive = unzipSync(await makeTwoSlideDeck());
    const relationshipPath = "ppt/_rels/presentation.xml.rels";
    const relationships = strFromU8(archive[relationshipPath]!);
    if (!relationships.includes('Target="slides/slide2.xml"')) {
      throw new Error("Fixture should contain a relationship to slide2.xml");
    }
    archive[relationshipPath] = strToU8(relationships.replace('Target="slides/slide2.xml"', 'Target="slides/slide1.xml"'));
    await expect(inspectPptx(zipSync(archive))).rejects.toMatchObject({ code: "PPTX_INVALID" });
  });

  it("rejects a slide that has no slide-layout relationship", async () => {
    const root = await mkdtemp(join(tmpdir(), "marpppt-layout-rel-"));
    roots.push(root);
    const image = await makeResolvedImagePathFixture("image-1", "photo.png", root);
    const plan: PresentationPlan = makeMixedDeckFixture();
    plan.slides = plan.slides.filter((slide) => slide.layout !== "image");
    const { path: _path, ...manifest } = image;
    plan.assetManifest = [manifest];
    const bytes = await renderPptx(plan, [image], defaultTheme);
    const archive = unzipSync(bytes);
    delete archive["ppt/slides/_rels/slide1.xml.rels"];
    await expect(inspectPptx(zipSync(archive))).rejects.toMatchObject({ code: "PPTX_INVALID" });
  });

  it("rejects missing embedded media relationship targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "marpppt-inspector-"));
    roots.push(root);
    const image = await makeResolvedImagePathFixture("image-1", "photo.png", root);
    const plan: PresentationPlan = makeMixedDeckFixture();
    plan.slides = plan.slides.filter((slide) => slide.layout !== "image");
    const { path: _path, ...manifest } = image;
    plan.assetManifest = [manifest];
    const validBytes = await renderPptx(plan, [image], defaultTheme);
    const archive = unzipSync(validBytes);
    const mediaParts = Object.keys(archive).filter((name) => name.startsWith("ppt/media/") && !name.endsWith("/"));
    if (mediaParts.length === 0) throw new Error("Fixture should embed one image");
    mediaParts.forEach((mediaPart) => delete archive[mediaPart]);
    await expect(inspectPptx(zipSync(archive))).rejects.toMatchObject({ code: "PPTX_INVALID" });
  });

  it.each([
    ["zero-byte media", new Uint8Array()],
    ["invalid PNG signature", Uint8Array.of(1, 2, 3, 4)],
  ])("rejects %s in a picture relationship", async (_description, replacement) => {
    const archive = unzipSync(await makeDeckWithImage());
    const mediaParts = Object.keys(archive).filter((name) => /^ppt\/media\/[^/]+$/u.test(name));
    if (mediaParts.length !== 1) throw new Error(`Fixture should contain one media part; found ${mediaParts.length}`);
    archive[mediaParts[0]!] = replacement;
    await expect(inspectPptx(zipSync(archive))).rejects.toMatchObject({ code: "PPTX_INVALID" });
  });

  it("rejects media whose declared MIME type disagrees with its extension", async () => {
    const archive = unzipSync(await makeDeckWithImage());
    const contentTypes = strFromU8(archive["[Content_Types].xml"]!);
    if (!contentTypes.includes('ContentType="image/png"')) {
      throw new Error("Fixture should declare the PNG content type");
    }
    archive["[Content_Types].xml"] = strToU8(contentTypes.replace('ContentType="image/png"', 'ContentType="image/jpeg"'));
    await expect(inspectPptx(zipSync(archive))).rejects.toMatchObject({ code: "PPTX_INVALID" });
  });

  it("rejects a full-slide picture background", async () => {
    const root = await mkdtemp(join(tmpdir(), "marpppt-full-slide-"));
    roots.push(root);
    const image = await makeResolvedImagePathFixture("image-1", "photo.png", root);
    // @ts-expect-error PptxGenJS 4's ESM runtime is constructable; its published NodeNext type is not.
    const pptx = new pptxgen();
    pptx.defineLayout({ name: "marp-full-slide", width: 13.333, height: 7.5 });
    pptx.layout = "marp-full-slide";
    pptx.addSlide().addImage({ path: image.path, x: 0, y: 0, w: 13.333, h: 7.5 });
    const fullSlideImageDeck = await pptx.write({ outputType: "uint8array" });
    await expect(inspectPptx(fullSlideImageDeck as Uint8Array)).rejects.toMatchObject({ code: "PPTX_INVALID" });
  });

  it("rejects a chart object whose chart part is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "marpppt-chart-rel-"));
    roots.push(root);
    const image = await makeResolvedImagePathFixture("image-1", "photo.png", root);
    const plan: PresentationPlan = makeMixedDeckFixture();
    plan.slides = plan.slides.filter((slide) => slide.layout !== "image");
    const { path: _path, ...manifest } = image;
    plan.assetManifest = [manifest];
    const bytes = await renderPptx(plan, [image], defaultTheme);
    const archive = unzipSync(bytes);
    const chartPart = Object.keys(archive).find((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name));
    if (!chartPart) throw new Error("Fixture should contain one chart part");
    delete archive[chartPart];
    await expect(inspectPptx(zipSync(archive))).rejects.toMatchObject({ code: "PPTX_INVALID" });
  });
});
