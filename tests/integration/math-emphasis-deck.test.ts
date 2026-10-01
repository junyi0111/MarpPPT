import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { strFromU8, unzipSync } from "fflate";
import { PresentationPlanSchema } from "../../src/contracts/presentation-plan.js";
import { buildSlideLayout } from "../../src/layout/build-slide.js";
import { serializeMarp } from "../../src/marp/serialize-marp.js";
import { inspectPptx, renderPptx } from "../../src/pptx/render-pptx.js";
import { loadDefaultTheme, makePresentationPlanFixture } from "../helpers/layout-fixtures.js";

const theme = loadDefaultTheme();
const formula = String.raw`\mathcal{L}=\frac{1}{N}\sum_{i=1}^{N}\sqrt{x_i^2+y_i^2}`;

function makeDeck(equation = formula) {
  const fixture = makePresentationPlanFixture();
  fixture.slides = [
    {
      id: "finding",
      title: "表現顯著提升",
      layout: "takeaway",
      blocks: [{
        id: "emphasis",
        text: "準確率由 32% 提升至 62%",
        runs: [
          { text: "準確率由 " },
          { text: "32%", bold: true },
          { text: " 提升至 " },
          { text: "62%", bold: true, color: "accent" },
        ],
      }],
      imageIds: [],
      sourceRefs: ["## 實驗"],
    },
    {
      id: "equation",
      title: "以平均損失衡量結果",
      layout: "takeaway",
      blocks: [{ id: "loss", text: `\\[${equation}\\]` }],
      imageIds: [],
      sourceRefs: ["## 方法"],
    },
  ];
  fixture.imageAssetIds = [];
  fixture.assetManifest = [];
  return PresentationPlanSchema.parse(fixture);
}

describe("math and emphasis in one PowerPoint deck", () => {
  it("preserves TeX in Marp and exports a separate equation picture plus editable colored text", async () => {
    const plan = makeDeck();
    const math = buildSlideLayout(plan.slides[1]!, theme).find((object) => object.kind === "math");
    expect(math).toMatchObject({ kind: "math", latex: formula });

    const marp = serializeMarp(plan, theme);
    expect(marp).toContain(`$$\n${formula}\n$$`);
    expect(marp).toContain('<span class="marpppt-strong marpppt-accent">62%</span>');

    const bytes = await renderPptx(plan, [], theme);
    await expect(inspectPptx(bytes)).resolves.toMatchObject({
      slideCount: 2,
      pictureCount: 1,
      embeddedMediaCount: 1,
      relationshipsValid: true,
      contentTypeOverridesValid: true,
      slideBoundsValid: true,
    });
    const archive = unzipSync(bytes);
    const firstSlide = strFromU8(archive["ppt/slides/slide1.xml"]!);
    const secondSlide = strFromU8(archive["ppt/slides/slide2.xml"]!);
    expect(firstSlide).toContain("<a:t>62%</a:t>");
    expect(firstSlide).toContain('val="2F6FED"');
    expect(secondSlide).toContain('descr="LaTeX:');
    expect(secondSlide).toContain('\\mathcal{L}');
    const mediaPaths = Object.keys(archive).filter((path) => /^ppt\/media\/[^/]+\.png$/u.test(path));
    expect(mediaPaths).toHaveLength(1);
    const metadata = await sharp(Buffer.from(archive[mediaPaths[0]!]!)).metadata();
    expect(metadata.width).toBeGreaterThan(400);
    expect(metadata.hasAlpha).toBe(true);
  });

  it("reports an unsupported display equation instead of exporting a broken formula", async () => {
    await expect(renderPptx(makeDeck(String.raw`\unknown{x}`), [], theme)).rejects.toMatchObject({
      code: "MATH_RENDER_FAILED",
    });
  });
});
