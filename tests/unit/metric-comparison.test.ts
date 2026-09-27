import { describe, expect, it } from "vitest";
import { parseMetricComparison } from "../../src/content/metric-comparison.js";
import { buildSlideLayout } from "../../src/layout/build-slide.js";
import { loadDefaultTheme } from "../helpers/layout-fixtures.js";

describe("metric comparison parsing", () => {
  it("parses a Chinese improvement phrase and carries the unit to both values", () => {
    expect(parseMetricComparison("顯著從32分提升到62分")).toEqual({
      before: "32分",
      after: "62分",
      beforeValue: 32,
      afterValue: 62,
      context: "顯著提升",
      direction: "increase",
      scale: 1.5,
    });
  });

  it("supports percentages, decimals, and decreases", () => {
    expect(parseMetricComparison("錯誤率由12.5%下降至4%")).toMatchObject({
      before: "12.5%",
      after: "4%",
      beforeValue: 12.5,
      afterValue: 4,
      context: "錯誤率下降",
      direction: "decrease",
      scale: 1.5,
    });
  });

  it("does not transform dates, unrelated numbers, or long trailing prose", () => {
    expect(parseMetricComparison("2024年從32到62")).toBeUndefined();
    expect(parseMetricComparison("共32頁，包含62個案例")).toBeUndefined();
    expect(parseMetricComparison("準確度從32分提升到62分，但仍需複核原始資料")).toBeUndefined();
  });

  it("renders before and after values as separate editable text objects", () => {
    const objects = buildSlideLayout({
      id: "metric",
      title: "準確度變化",
      layout: "takeaway",
      blocks: [{ id: "score", text: "顯著從32分提升到62分" }],
      imageIds: [],
      sourceRefs: ["## 結果"],
    }, loadDefaultTheme());
    const before = objects.find((object) => object.kind === "text" && object.role === "metric-before");
    const after = objects.find((object) => object.kind === "text" && object.role === "metric-after");
    const arrow = objects.find((object) => object.kind === "text" && object.role === "metric-arrow");
    const context = objects.find((object) => object.kind === "text" && object.role === "metric-label");
    expect(before?.kind).toBe("text");
    expect(after?.kind).toBe("text");
    expect(arrow?.kind).toBe("text");
    expect(context?.kind).toBe("text");
    if (before?.kind !== "text" || after?.kind !== "text") throw new Error("expected metric text objects");
    expect(before.text).toBe("32分");
    expect(after.text).toBe("62分");
    expect(after.fontSize).toBe(before.fontSize * 1.5);
    expect(after.fontFace).toBe(before.fontFace);
    expect(arrow && arrow.text).toBe("→");
    expect(context && context.text).toBe("顯著提升");
  });
});
