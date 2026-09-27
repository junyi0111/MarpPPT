import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { countTofuGlyphs } from "../../src/preview/font-check.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories.length = 0;
});

describe("raster glyph check", () => {
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
});
