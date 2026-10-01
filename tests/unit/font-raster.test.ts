import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { countTofuGlyphs } from "../../src/preview/font-check.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories.length = 0;
});

describe("raster glyph check", () => {
  it("does not flag correctly rendered Noto CJK text from Linux LibreOffice", async () => {
    const path = fileURLToPath(new URL("../fixtures/glyphs/linux-noto-cjk.png", import.meta.url));
    expect(await countTofuGlyphs([path])).toBe(0);
  });

  it("detects a small hollow replacement glyph", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marpppt-glyph-"));
    directories.push(directory);
    const path = join(directory, "tofu.png");
    const outline = Buffer.alloc(80 * 60 * 4, 255);
    for (let y = 20; y < 38; y++) for (let x = 30; x < 46; x++) {
      if (x === 30 || x === 45 || y === 20 || y === 37) {
        const offset = (y * 80 + x) * 4;
        outline[offset] = 80; outline[offset + 1] = 80; outline[offset + 2] = 80;
      }
    }
    await sharp(outline, { raw: { width: 80, height: 60, channels: 4 } }).png().toFile(path);
    expect(await countTofuGlyphs([path])).toBeGreaterThan(0);
  });

  it("does not flag a rectangular glyph with disconnected inner strokes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marpppt-glyph-"));
    directories.push(directory);
    const path = join(directory, "nested.png");
    const outline = Buffer.alloc(80 * 60 * 4, 255);
    for (let y = 20; y < 38; y++) for (let x = 30; x < 48; x++) {
      const outer = x === 30 || x === 47 || y === 20 || y === 37;
      const inner = x >= 35 && x <= 42 && y >= 25 && y <= 32 && (x === 35 || x === 42 || y === 25 || y === 32);
      if (outer || inner) {
        const offset = (y * 80 + x) * 4;
        outline[offset] = 80; outline[offset + 1] = 80; outline[offset + 2] = 80;
      }
    }
    await sharp(outline, { raw: { width: 80, height: 60, channels: 4 } }).png().toFile(path);
    expect(await countTofuGlyphs([path])).toBe(0);
  });

  it("detects a hollow replacement glyph on a dark background", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marpppt-glyph-"));
    directories.push(directory);
    const path = join(directory, "dark-tofu.png");
    const outline = Buffer.alloc(80 * 60 * 4, 20);
    for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) {
      const offset = (y * 80 + x) * 4;
      outline[offset + 3] = 255;
      if (x >= 30 && x < 46 && y >= 20 && y < 38 && (x === 30 || x === 45 || y === 20 || y === 37)) {
        outline[offset] = 240; outline[offset + 1] = 240; outline[offset + 2] = 240;
      }
    }
    await sharp(outline, { raw: { width: 80, height: 60, channels: 4 } }).png().toFile(path);
    expect(await countTofuGlyphs([path])).toBe(1);
  });
});
