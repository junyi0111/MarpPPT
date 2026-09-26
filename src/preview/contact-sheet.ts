import { join } from "node:path";
import sharp from "sharp";

type OverlayOptions = import("sharp").OverlayOptions;

const COLUMNS = 3;
const CARD_WIDTH = 500;
const CARD_HEIGHT = 306;
const OUTER_GAP = 24;
const INNER_GAP = 20;

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]!);
}

function pageLabel(index: number): Buffer {
  const label = `Page ${index + 1}`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="36"><rect width="100%" height="100%" fill="#ffffff"/><text x="14" y="25" font-family="sans-serif" font-size="17" font-weight="600" fill="#18212f">${escapeXml(label)}</text></svg>`);
}

export async function createContactSheet(pngPaths: string[], outputDirectory: string): Promise<string> {
  if (pngPaths.length === 0) throw new Error("A contact sheet requires at least one rendered page");
  const rows = Math.ceil(pngPaths.length / COLUMNS);
  const width = OUTER_GAP * 2 + Math.min(COLUMNS, pngPaths.length) * CARD_WIDTH + (Math.min(COLUMNS, pngPaths.length) - 1) * INNER_GAP;
  const height = OUTER_GAP * 2 + rows * CARD_HEIGHT + (rows - 1) * INNER_GAP;
  const composites: OverlayOptions[] = [];

  for (const [index, pagePath] of pngPaths.entries()) {
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const left = OUTER_GAP + column * (CARD_WIDTH + INNER_GAP);
    const top = OUTER_GAP + row * (CARD_HEIGHT + INNER_GAP);
    const thumbnail = await sharp(pagePath)
      .resize(CARD_WIDTH - 20, 250, { fit: "contain", background: "#ffffff" })
      .png()
      .toBuffer();
    const card = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}"><rect x="0.5" y="0.5" width="${CARD_WIDTH - 1}" height="${CARD_HEIGHT - 1}" rx="8" fill="#ffffff" stroke="#d7dde5"/></svg>`);
    composites.push({ input: card, left, top });
    composites.push({ input: pageLabel(index), left, top: top + 4 });
    composites.push({ input: thumbnail, left: left + 10, top: top + 42 });
  }

  const outputPath = join(outputDirectory, "contact-sheet.png");
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 241, g: 244, b: 248, alpha: 1 },
    },
  }).composite(composites).png().toFile(outputPath);
  return outputPath;
}
