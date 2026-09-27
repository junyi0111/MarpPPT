import { describe, expect, it } from "vitest";
import { addLayoutObject, type LayoutObjectContext } from "../../src/pptx/add-layout-object.js";
import { buildSlideLayout, type LayoutObject } from "../../src/layout/build-slide.js";
import { loadDefaultTheme } from "../helpers/layout-fixtures.js";

function context() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const value: LayoutObjectContext = {
    pptx: {
      ShapeType: { rect: "rect", roundRect: "roundRect", ellipse: "ellipse", diamond: "diamond", line: "line" },
      ChartType: { bar: "bar", line: "line", pie: "pie" },
    },
    slide: {
      addText: (...args) => { calls.push({ method: "addText", args }); return undefined; },
      addShape: (...args) => { calls.push({ method: "addShape", args }); return undefined; },
      addImage: (...args) => { calls.push({ method: "addImage", args }); return undefined; },
      addTable: (...args) => { calls.push({ method: "addTable", args }); return undefined; },
      addChart: (...args) => { calls.push({ method: "addChart", args }); return undefined; },
    },
    assets: new Map(),
    theme: loadDefaultTheme(),
  };
  return { value, calls };
}

describe("published renderer design preferences", () => {
  it("centers editable text vertically in the generated PowerPoint object", () => {
    const { value, calls } = context();
    const object: LayoutObject = {
      kind: "text", id: "slide:text", slideId: "slide", role: "body", text: "內容",
      x: 1, y: 1, w: 4, h: 1, fontFace: "Noto Sans CJK TC", fontSize: 22,
      minFontSize: 18, lineHeight: 1.2, color: "#10243E",
    };
    addLayoutObject(object, value);
    expect(calls[0]).toMatchObject({ method: "addText", args: ["內容", expect.objectContaining({ valign: "mid", margin: 0 })] });
  });

  it("keeps table alignment and spacing semantic in the generated object", () => {
    const { value, calls } = context();
    const object: LayoutObject = {
      kind: "table", id: "slide:table", slideId: "slide", x: 1, y: 1, w: 8, h: 3,
      columns: ["規範", "數值"], rows: [["平均時間", "24 小時"]], fontFace: "Noto Sans CJK TC",
      fontSize: 22, minFontSize: 18, color: "#26384D", headerFill: "#10243E",
      numericColumns: [1], columnWidths: [5.2, 2.8], rowHeights: [0.8, 1.1],
      headerCellMargin: [0.079, 0.197, 0.079, 0.197], bodyCellMargin: [0.098, 0.197, 0.098, 0.197],
      headerColor: "#FFFFFF", numericColor: "#10243E", lineHeight: 1.2,
    };
    addLayoutObject(object, value);
    const rows = calls.find((call) => call.method === "addTable")?.args[0] as Array<Array<{ options: Record<string, unknown> }>>;
    expect(rows[0]![0]!.options).toMatchObject({ align: "center", valign: "mid", margin: [0.079, 0.197, 0.079, 0.197] });
    expect(rows[1]![0]!.options).toMatchObject({ align: "left", bold: true, margin: [0.098, 0.197, 0.098, 0.197] });
    expect(rows[1]![1]!.options).toMatchObject({ align: "right", bold: true });
  });

  it("uses the theme chart palette instead of a slide-local fallback", () => {
    const { value, calls } = context();
    const object: LayoutObject = {
      kind: "chart", id: "slide:chart", slideId: "slide", x: 1, y: 1, w: 8, h: 3,
      chartKind: "bar", labels: ["A"], series: [{ name: "值", values: [1] }],
    };
    addLayoutObject(object, value);
    const options = calls.find((call) => call.method === "addChart")?.args[2] as Record<string, unknown>;
    expect(options.chartColors).toEqual(["2F6FED", "32BFC1", "E5A34B", "8C7CF6", "10243E", "738299"]);
    expect(options.catAxisLabelFontSize).toBeGreaterThanOrEqual(18);
  });

  it("exercises the compiled package entrypoint instead of a build-time override", async () => {
    const built = await import("../../dist/pptx/add-layout-object.js");
    const { value, calls } = context();
    built.addLayoutObject({
      kind: "text", id: "dist:text", slideId: "slide", role: "body", text: "dist",
      x: 1, y: 1, w: 4, h: 1, fontFace: "Noto Sans CJK TC", fontSize: 22,
      minFontSize: 18, lineHeight: 1.2, color: "#10243E",
    }, value);
    expect(calls[0]).toMatchObject({ method: "addText", args: ["dist", expect.objectContaining({ valign: "mid" })] });
  });

  it("builds a table with a wide label column and semantic numeric columns", () => {
    const slide = {
      id: "metrics", title: "試行指標", layout: "table" as const,
      table: { columns: ["規範項目", "現況", "目標"], rows: [["平均回覆時間（含人工複核、異常處理、跨部門確認與最終交付）", "48 小時", "24 小時"]] },
      imageIds: [], sourceRefs: ["## 指標"],
    };
    const table = buildSlideLayout(slide, loadDefaultTheme()).find((object) => object.kind === "table");
    expect(table).toMatchObject({ numericColumns: [1, 2], headerCellMargin: [0.079, 0.197, 0.079, 0.197], bodyCellMargin: [0.098, 0.197, 0.098, 0.197], lineHeight: 1.2 });
    if (table?.kind !== "table") return;
    expect(table.columnWidths?.[0]).toBeGreaterThan(table.columnWidths?.[1] ?? 0);
    expect(table.rowHeights?.[0]).toBeGreaterThan(0);
    expect(table.rowHeights?.every((height) => height > 0)).toBe(true);
  });
});
