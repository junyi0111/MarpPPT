import { strFromU8, unzipSync } from "fflate";
import sharp from "sharp";

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/u;
const CJK_GLOBAL_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/gu;

export interface GlyphCoverage {
  requiredCharacters: string[];
  missingCharacters: string[];
  coverage: number;
  replacementCharacterFound: boolean;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'");
}

export function extractSlideText(bytes: Uint8Array): string {
  let text = "";
  try {
    const archive = unzipSync(bytes);
    for (const [name, content] of Object.entries(archive)) {
      if (!/^ppt\/slides\/slide\d+\.xml$/u.test(name)) continue;
      const xml = strFromU8(content);
      for (const match of xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)) {
        text += `${decodeXml(match[1] ?? "")}\n`;
      }
    }
  } catch {
    return "";
  }
  return text;
}

export function assessGlyphCoverage(sourcePptxBytes: Uint8Array, extractedPdfText: string): GlyphCoverage {
  const sourceText = extractSlideText(sourcePptxBytes);
  const required = new Set(sourceText.match(CJK_GLOBAL_PATTERN) ?? []);
  const missingCharacters = [...required].filter((character) => !extractedPdfText.includes(character));
  const coverage = required.size === 0 ? 1 : (required.size - missingCharacters.length) / required.size;
  return {
    requiredCharacters: [...required],
    missingCharacters,
    coverage,
    replacementCharacterFound: extractedPdfText.includes("\uFFFD") || CJK_PATTERN.test(extractedPdfText) === false && extractedPdfText.includes("□"),
  };
}

/**
 * LibreOffice can preserve the PDF text map while drawing missing CJK glyphs
 * as hollow tofu squares.  This small raster check catches the characteristic
 * repeated, small rectangular outlines without mistaking the large card
 * borders for glyphs.
 */
export async function countTofuGlyphs(pngPaths: string[]): Promise<number> {
  let count = 0;
  for (const path of pngPaths) {
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;
    const pixelValue = (x: number, y: number): number => {
      const offset = (y * width + x) * info.channels;
      return ((data[offset] ?? 255) + (data[offset + 1] ?? 255) + (data[offset + 2] ?? 255)) / 3;
    };
    const cornerValues = [
      pixelValue(Math.floor(width * 0.1), Math.floor(height * 0.1)),
      pixelValue(Math.floor(width * 0.9), Math.floor(height * 0.1)),
      pixelValue(Math.floor(width * 0.1), Math.floor(height * 0.9)),
      pixelValue(Math.floor(width * 0.9), Math.floor(height * 0.9)),
    ];
    const backgroundIsDark = cornerValues.reduce((sum, value) => sum + value, 0) / cornerValues.length < 150;
    const darkPixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * info.channels;
      const red = data[offset] ?? 255;
      const green = data[offset + 1] ?? 255;
      const blue = data[offset + 2] ?? 255;
      const alpha = data[offset + 3] ?? 255;
      const value = (red + green + blue) / 3;
      const foreground = backgroundIsDark ? value > 190 : value < 190;
      darkPixels[y * width + x] = alpha > 20 && foreground ? 1 : 0;
    }
    const dark = (x: number, y: number): boolean => darkPixels[y * width + x] === 1;
    const visited = new Uint8Array(width * height);
    const stack: number[] = [];
    for (let start = 0; start < darkPixels.length; start++) {
      if (!darkPixels[start] || visited[start]) continue;
      visited[start] = 1;
      stack.push(start);
      let pixels = 0;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      while (stack.length > 0) {
        const current = stack.pop()!;
        const x = current % width;
        const y = Math.floor(current / width);
        pixels += 1;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        for (const [nextX, nextY] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (darkPixels[next] && !visited[next]) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }
      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      const density = pixels / (boxW * boxH);
      const aspect = boxW / boxH;
      // A tofu square is a small, sparse, nearly rectangular connected ring.
      if (boxW >= 8 && boxW <= 24 && boxH >= 10 && boxH <= 26 && aspect >= 0.45 && aspect <= 1.6 && density >= 0.08 && density <= 0.42) {
        count += 1;
      }
    }
  }
  return count;
}
