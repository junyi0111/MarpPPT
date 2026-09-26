import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMixedDeckFixture, loadDefaultTheme } from "./layout-fixtures.js";
import { renderPptx } from "../../src/pptx/render-pptx.js";

export async function makeTwoSlidePreviewFixture(): Promise<{
  twoSlidePptxPath: string;
  tempDirectory: string;
}> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "marp preview fixture-"));
  const plan = makeMixedDeckFixture();
  plan.slides = plan.slides.slice(0, 2);
  plan.imageAssetIds = [];
  plan.assetManifest = [];
  const bytes = await renderPptx(plan, [], loadDefaultTheme());
  const twoSlidePptxPath = join(tempDirectory, "two slide fixture & preview.pptx");
  await writeFile(twoSlidePptxPath, bytes, { flag: "wx", mode: 0o600 });
  return { twoSlidePptxPath, tempDirectory };
}
