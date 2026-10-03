import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const theme = JSON.parse(await readFile(resolve(root, "assets/themes/default.json"), "utf8"));
if (theme.typography?.fontFace !== "Noto Sans CJK TC" || theme.imageFit !== "contain" || !theme.spacing?.table || !Array.isArray(theme.colors?.chartSeries)) {
  throw new Error("Default theme is missing the committed editorial design contract.");
}

const { renderPptx, inspectPptx } = await import(resolve(root, "dist/pptx/render-pptx.js"));
const plan = {
  version: 1, title: "Build validation", language: "zh-TW", themeId: theme.id,
  sourceDigest: "a".repeat(64), imageAssetIds: [], assetManifest: [],
  slides: [{ id: "table-gate", title: "表格置中檢查", layout: "table", imageIds: [], sourceRefs: ["Build fixture"],
    table: { columns: ["項目", "數值"], rows: [["中文 English", "62"]] } }],
};
const report = await inspectPptx(await renderPptx(plan, [], theme));
if (report.tableCount !== 1 || report.slideCount !== 1) throw new Error("Built renderer did not preserve its editable table.");
process.stdout.write("Validated actual compiled table XML and committed editorial theme; no build-time overrides applied.\n");
