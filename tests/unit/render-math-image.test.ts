import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderMathImage } from "../../src/pptx/render-math-image.js";

describe("local LaTeX equation image", () => {
  it("typesets a fraction, radical, and exponent as a transparent PNG", async () => {
    const result = await renderMathImage(String.raw`\mathrm{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)`, "#172554");
    expect(result.data).toMatch(/^image\/png;base64,/u);
    expect(result.aspectRatio).toBeGreaterThan(1);
    const bytes = Buffer.from(result.data.split(",")[1]!, "base64");
    const metadata = await sharp(bytes).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.hasAlpha).toBe(true);
    expect(metadata.width).toBeGreaterThan(400);
  });

  it.each([
    String.raw`\href{https://example.test}{x}`,
    String.raw`\require{ams}`,
    String.raw`\includegraphics{https://example.test/a.png}`,
    String.raw`\def\foo{bar}\foo`,
    String.raw`\newcommand{\foo}{bar}\foo`,
    String.raw`\color{white}{x+y}`,
    String.raw`\unknown{value}`,
  ])("rejects unsafe or unsupported TeX: %s", async (latex) => {
    await expect(renderMathImage(latex, "#172554")).rejects.toThrow(/UNSUPPORTED_MATH/u);
  });
});
