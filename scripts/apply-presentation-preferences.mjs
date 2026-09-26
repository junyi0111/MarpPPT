import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const designOverrides = [
  "layout/build-slide.js",
  "layout/overflow.js",
  "pptx/render-pptx.js",
  "pptx/add-layout-object.js",
];
for (const relativePath of designOverrides) {
  const sourcePath = resolve(root, "scripts/presentation-overrides", relativePath);
  const destinationPath = resolve(root, "dist", relativePath);
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

const rendererPath = resolve(root, "dist/pptx/add-layout-object.js");
const renderer = await readFile(rendererPath, "utf8");
const topAligned = renderer.split('valign: "top"').length - 1;

if (topAligned === 1) {
  await writeFile(rendererPath, renderer.replace('valign: "top"', 'valign: "mid"'));
} else if (topAligned !== 0 || !renderer.includes('valign: "mid"')) {
  throw new Error("Unable to apply vertical-centering preference: expected one top-aligned text option or an already centered renderer.");
}

const themePath = resolve(root, "assets/themes/default.json");
const theme = JSON.parse(await readFile(themePath, "utf8"));
if (!theme.typography || typeof theme.typography !== "object") {
  throw new Error("Default theme is missing its typography settings.");
}
theme.typography.fontFace = "Noto Sans CJK TC";
theme.imageFit = "contain";
theme.spacing = {
  comfortable: { cmMin: 0.4, cmMax: 0.6, inches: 0.20 },
  compact: { cmMin: 0.2, cmMax: 0.3, inches: 0.10 },
  spaciousMinCm: 0.8,
  spaciousMinInches: 0.315,
  table: {
    headerVerticalTotalCm: 0.4,
    headerVerticalEachInches: 0.079,
    bodyVerticalTotalCm: 0.5,
    bodyVerticalEachInches: 0.098,
    horizontalEachInches: 0.197,
  },
};
Object.assign(theme.colors, {
  background: "#F3F6FA",
  title: "#10243E",
  body: "#26384D",
  muted: "#738299",
  accent: "#2F6FED",
  accentSoft: "#E8F0FE",
  accentCyan: "#32BFC1",
  cyanSoft: "#E4F6F5",
  warmSoft: "#FFF2DF",
  violetSoft: "#F0EDFF",
  darkBackground: "#10243E",
  darkBody: "#DCE7F3",
  darkMuted: "#A8B8CC",
  surface: "#FFFFFF",
  border: "#DFE6EF",
  white: "#FFFFFF",
  chartSeries: ["#2F6FED", "#32BFC1", "#E5A34B", "#8C7CF6", "#10243E", "#738299"],
});
await writeFile(themePath, JSON.stringify(theme, null, 2) + "\n", "utf8");

process.stdout.write("Applied MarpPPT editorial design, text alignment, font, and image-fit preferences.\n");
