import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMixedDeckFixture, loadDefaultTheme } from "./layout-fixtures.js";
import { renderPptx } from "../../src/pptx/render-pptx.js";

export async function makeTwoSlidePreviewFixture(options: { includeCjk?: boolean } = {}): Promise<{
  twoSlidePptxPath: string;
  tempDirectory: string;
}> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "marp preview fixture-"));
  const plan = makeMixedDeckFixture();
  const theme = loadDefaultTheme();
  theme.footer.sourcePrefix = options.includeCjk ? "來源：" : "Source: ";
  plan.slides = plan.slides.slice(0, 2);
  if (!options.includeCjk) {
    // Keep the renderer lifecycle fixture independent from host CJK font
    // availability; glyph coverage has dedicated tests with explicit source
    // characters and fake PDF text output.
    plan.slides.forEach((slide, index) => {
      slide.title = `Slide ${index + 1}`;
      slide.sourceRefs = [`## Slide ${index + 1}`];
      if (slide.layout === "cover") slide.subtitle = undefined;
      if ("blocks" in slide && slide.blocks) slide.blocks = slide.blocks.map((block) => ({ ...block, text: `Body ${index + 1}` }));
    });
  }
  plan.imageAssetIds = [];
  plan.assetManifest = [];
  const bytes = await renderPptx(plan, [], theme);
  const twoSlidePptxPath = join(tempDirectory, "two slide fixture & preview.pptx");
  await writeFile(twoSlidePptxPath, bytes, { flag: "wx", mode: 0o600 });
  return { twoSlidePptxPath, tempDirectory };
}
