import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rendererPath = resolve(root, "dist/pptx/add-layout-object.js");
const renderer = await readFile(rendererPath, "utf8");
if (renderer.includes('valign: "top"') || !renderer.includes('valign: "mid"')) {
  throw new Error("Built renderer is not using the TypeScript source-of-truth vertical alignment.");
}
const theme = JSON.parse(await readFile(resolve(root, "assets/themes/default.json"), "utf8"));
if (theme.typography?.fontFace !== "Noto Sans CJK TC" || theme.imageFit !== "contain" || !theme.spacing?.table || !Array.isArray(theme.colors?.chartSeries)) {
  throw new Error("Default theme is missing the committed editorial design contract.");
}

process.stdout.write("Validated TypeScript renderer and committed editorial theme; no build-time overrides applied.\n");
