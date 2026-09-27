import { describe, expect, it } from "vitest";
import { assessGlyphCoverage, extractSlideText } from "../../src/preview/font-check.js";
import { makeMixedDeckFixture, loadDefaultTheme } from "../helpers/layout-fixtures.js";
import { renderPptx } from "../../src/pptx/render-pptx.js";

describe("preview font glyph checks", () => {
  it("collects CJK characters from slide text and reports missing coverage", async () => {
    const plan = makeMixedDeckFixture();
    plan.imageAssetIds = [];
    plan.assetManifest = [];
    plan.slides = plan.slides.filter((slide) => slide.layout !== "image" && slide.layout !== "image-text");
    plan.slides.forEach((slide) => { slide.imageIds = []; });
    const bytes = await renderPptx(plan, [], loadDefaultTheme());
    const source = extractSlideText(bytes);
    expect(source).toContain("KV Cache");
    const required = [...new Set(source.match(/[\u4e00-\u9fff]/gu) ?? [])];
    expect(required.length).toBeGreaterThan(0);

    const coverage = assessGlyphCoverage(bytes, required.slice(0, -1).join(""));
    expect(coverage.requiredCharacters.length).toBeGreaterThan(0);
    expect(coverage.coverage).toBeLessThan(1);
    expect(coverage.missingCharacters.length).toBeGreaterThan(0);
  });

  it("passes when the extracted PDF text contains every source character", async () => {
    const plan = makeMixedDeckFixture();
    plan.imageAssetIds = [];
    plan.assetManifest = [];
    plan.slides = plan.slides.filter((slide) => slide.layout !== "image" && slide.layout !== "image-text");
    plan.slides.forEach((slide) => { slide.imageIds = []; });
    const bytes = await renderPptx(plan, [], loadDefaultTheme());
    const source = extractSlideText(bytes);
    const coverage = assessGlyphCoverage(bytes, source);
    expect(coverage.coverage).toBe(1);
    expect(coverage.missingCharacters).toEqual([]);
    expect(coverage.replacementCharacterFound).toBe(false);
  });
});
