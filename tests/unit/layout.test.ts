import { describe, expect, it } from "vitest";
import { fixturesForAllLayouts, loadDefaultTheme, makePresentationPlanFixture } from "../helpers/layout-fixtures.js";
import { buildSlideLayout } from "../../src/layout/build-slide.js";
import { findOverflow, measureTextBlock } from "../../src/layout/overflow.js";
import { getCanvas, getTextBox } from "../../src/layout/geometry.js";
import type { SlidePlan } from "../../src/contracts/presentation-plan.js";

const allLayoutFixtures = fixturesForAllLayouts();
const defaultTheme = loadDefaultTheme();

describe("controlled slide layouts", () => {
  it("keeps every object inside the 16:9 safe area for all 11 templates", () => {
    for (const slide of allLayoutFixtures) {
      const objects = buildSlideLayout(slide, defaultTheme);
      expect(findOverflow(objects, getCanvas(defaultTheme)).filter((issue) => issue.code === "LAYOUT_OVERFLOW"), slide.layout).toEqual([]);
      expect(objects.length, slide.layout).toBeGreaterThan(0);
      for (const object of objects) {
        expect(object.x, `${slide.layout}/${object.id} left`).toBeGreaterThanOrEqual(0.45);
        expect(object.y, `${slide.layout}/${object.id} top`).toBeGreaterThanOrEqual(0.35);
        expect(object.x + object.w, `${slide.layout}/${object.id} right`).toBeLessThanOrEqual(12.883);
        expect(object.y + object.h, `${slide.layout}/${object.id} bottom`).toBeLessThanOrEqual(7.15);
      }
    }
  });

  it("uses the fixed widescreen canvas, safe margins, and shared text boxes", () => {
    expect(getCanvas(defaultTheme)).toMatchObject({ width: 13.333, height: 7.5, safe: { left: 0.45, right: 0.45, top: 0.35, bottom: 0.35 } });
    const titleBox = getTextBox("title", "bullets", defaultTheme);
    expect(titleBox.x).toBeGreaterThanOrEqual(0.45);
    expect(titleBox.y).toBeGreaterThanOrEqual(0.35);
    expect(titleBox.x + titleBox.w).toBeLessThanOrEqual(12.883);
    expect(titleBox.y + titleBox.h).toBeLessThanOrEqual(7.15);
  });

  it("keeps text, images, chart data, tables, diagram shapes, and connectors as separate objects", () => {
    const slide = makePresentationPlanFixture().slides.find((item) => item.layout === "diagram");
    expect(slide).toBeDefined();
    const objects = buildSlideLayout(slide!, defaultTheme);
    expect(objects.filter((object) => object.kind === "shape")).toHaveLength(3);
    expect(objects.filter((object) => object.kind === "line")).toHaveLength(2);
    expect(objects.filter((object) => object.kind === "text" && object.role === "diagram-node")).toHaveLength(3);

    const imageSlide = allLayoutFixtures.find((item) => item.layout === "image");
    expect(buildSlideLayout(imageSlide!, defaultTheme).some((object) => object.kind === "image" && object.assetId === "image-1")).toBe(true);
    const chartSlide = allLayoutFixtures.find((item) => item.layout === "chart");
    expect(buildSlideLayout(chartSlide!, defaultTheme).some((object) => object.kind === "chart")).toBe(true);
    const tableSlide = allLayoutFixtures.find((item) => item.layout === "table");
    expect(buildSlideLayout(tableSlide!, defaultTheme).some((object) => object.kind === "table")).toBe(true);
  });

  it("reserves caption space so chart and table data boxes do not overlap captions", () => {
    const chartSlide: Extract<SlidePlan, { layout: "chart" }> = {
      id: "chart-caption",
      title: "圖表標題",
      layout: "chart",
      chart: { kind: "bar", labels: ["A"], series: [{ name: "S", values: [1] }] },
      blocks: [{ id: "caption", text: "附註文字" }],
      imageIds: [],
      sourceRefs: ["## 圖表"],
    };
    const tableSlide: Extract<SlidePlan, { layout: "table" }> = {
      id: "table-caption",
      title: "表格標題",
      layout: "table",
      table: { columns: ["A"], rows: [["1"]] },
      blocks: [{ id: "caption", text: "附註文字" }],
      imageIds: [],
      sourceRefs: ["## 表格"],
    };

    for (const slide of [chartSlide, tableSlide]) {
      const objects = buildSlideLayout(slide, defaultTheme);
      const data = objects.find((object) => object.kind === (slide.layout === "chart" ? "chart" : "table"));
      const caption = objects.find((object) => object.kind === "text" && object.role === "body");
      expect(data, `${slide.layout} data`).toBeDefined();
      expect(caption, `${slide.layout} caption`).toBeDefined();
      if (!data || !caption) throw new Error("expected data and caption objects");
      const overlaps = data.x < caption.x + caption.w
        && data.x + data.w > caption.x
        && data.y < caption.y + caption.h
        && data.y + data.h > caption.y;
      expect(overlaps, `${slide.layout} data and caption intersection`).toBe(false);
    }
  });

  it("preserves editable edge labels and keeps schema-maximum data objects inside the safe area", () => {
    const columns = Array.from({ length: 12 }, (_, index) => `欄${index + 1}`);
    const maxTable: Extract<SlidePlan, { layout: "table" }> = {
      id: "max-table", title: "最大表格", layout: "table",
      table: { columns, rows: Array.from({ length: 100 }, (_, row) => columns.map((_, column) => `${row + 1}/${column + 1}`)) },
      imageIds: [], sourceRefs: ["## 表格"],
    };
    const maxChart: Extract<SlidePlan, { layout: "chart" }> = {
      id: "max-chart", title: "最大圖表", layout: "chart",
      chart: {
        kind: "bar",
        labels: Array.from({ length: 20 }, (_, index) => `標籤${index + 1}`),
        series: Array.from({ length: 5 }, (_, series) => ({ name: `系列${series + 1}`, values: Array.from({ length: 20 }, (_, index) => series + index) })),
      },
      imageIds: [], sourceRefs: ["## 圖表"],
    };
    const nodes = Array.from({ length: 30 }, (_, index) => ({ id: `n${index + 1}`, label: `節點${index + 1}` }));
    const maxDiagram: Extract<SlidePlan, { layout: "diagram" }> = {
      id: "max-diagram", title: "最大流程圖", layout: "diagram",
      diagram: {
        nodes,
        edges: Array.from({ length: 60 }, (_, index) => ({
          from: nodes[index % nodes.length]!.id,
          to: nodes[(index + 1) % nodes.length]!.id,
          label: `關係${index + 1}`,
        })),
      },
      imageIds: [], sourceRefs: ["## 流程圖"],
    };

    const maxTableObjects = buildSlideLayout(maxTable, defaultTheme);
    const maxChartObjects = buildSlideLayout(maxChart, defaultTheme);
    const maxDiagramObjects = buildSlideLayout(maxDiagram, defaultTheme);
    expect(maxTableObjects.find((object) => object.kind === "table")?.rows).toHaveLength(100);
    expect(maxChartObjects.find((object) => object.kind === "chart" && object.labels.length === 20)?.series).toHaveLength(5);
    expect(maxDiagramObjects.filter((object) => object.kind === "text" && object.role === "diagram-node")).toHaveLength(30);
    expect(maxDiagramObjects.filter((object) => object.kind === "text" && object.role === "diagram-edge-label")).toHaveLength(60);

    const edgeLabels = maxDiagramObjects.filter((object) => object.kind === "text" && object.role === "diagram-edge-label");
    const nodeShapes = maxDiagramObjects.filter((object) => object.kind === "shape" && object.id.includes(":node:"));
    const collisions: Array<[typeof edgeLabels[number], typeof edgeLabels[number] | typeof nodeShapes[number]]> = [];
    const intersects = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (let index = 0; index < edgeLabels.length; index += 1) {
      const current = edgeLabels[index]!;
      for (const other of edgeLabels.slice(index + 1)) if (intersects(current, other)) collisions.push([current, other]);
      for (const node of nodeShapes) if (intersects(current, node)) collisions.push([current, node]);
    }
    const diagramIssues = findOverflow(maxDiagramObjects, getCanvas(defaultTheme));
    for (const [first, second] of collisions) {
      const isReported = diagramIssues.some((issue) =>
        (issue.code === "SUMMARY_REQUIRED" || issue.code === "SPLIT_REQUIRED")
        && issue.actionable
        && ((issue.objectId === first.id && issue.overlapsWith?.includes(second.id))
          || (issue.objectId === second.id && issue.overlapsWith?.includes(first.id))));
      expect(isReported, `${first.id} / ${second.id} overlap must be removed or reported`).toBe(true);
    }
    const diagramLines = maxDiagramObjects.filter((object) => object.kind === "line");
    for (let index = 0; index < edgeLabels.length; index += 1) {
      const label = edgeLabels[index]!;
      const line = diagramLines.find((candidate) => candidate.id === `${maxDiagram.id}:edge:${index + 1}`)!;
      const distance = Math.hypot(
        label.x + label.w / 2 - (line.x1 + line.x2) / 2,
        label.y + label.h / 2 - (line.y1 + line.y2) / 2,
      );
      const associationIsReported = diagramIssues.some((issue) =>
        issue.code === "SUMMARY_REQUIRED" && issue.actionable && issue.objectId === label.id && issue.relatedObjectId === line.id);
      expect(distance <= 2.3 || associationIsReported, `${label.id} connector association`).toBe(true);
    }

    for (const [layout, objects] of [["table", maxTableObjects], ["chart", maxChartObjects], ["diagram", maxDiagramObjects]] as const) {
      for (const object of objects) {
        expect(object.x, `${layout}/${object.id} left`).toBeGreaterThanOrEqual(0.45);
        expect(object.y, `${layout}/${object.id} top`).toBeGreaterThanOrEqual(0.35);
        expect(object.x + object.w, `${layout}/${object.id} right`).toBeLessThanOrEqual(12.883);
        expect(object.y + object.h, `${layout}/${object.id} bottom`).toBeLessThanOrEqual(7.15);
      }
      expect(findOverflow(objects, getCanvas(defaultTheme)).filter((issue) => issue.code === "LAYOUT_OVERFLOW"), layout).toEqual([]);
    }
  });

  it("keeps the schema maximum of twelve optional blocks inside each template text box", () => {
    const blocks = Array.from({ length: 12 }, (_, index) => ({ id: `long-${index + 1}`, text: "保留重要資料並維持版面安全。".repeat(20) }));
    const maxBlockSlides = [
      { id: "many-cover", title: "封面", layout: "cover", blocks, imageIds: [], sourceRefs: ["## 封面"] },
      { id: "many-section", title: "章節", layout: "section", blocks, imageIds: [], sourceRefs: ["## 章節"] },
      { id: "many-closing", title: "結尾", layout: "closing", blocks, imageIds: [], sourceRefs: ["## 結尾"] },
      { id: "many-image", title: "圖片", layout: "image", blocks, imageIds: ["image-1"], sourceRefs: ["## 圖片"] },
      { id: "many-chart", title: "圖表", layout: "chart", blocks, chart: { kind: "bar", labels: ["A"], series: [{ name: "S", values: [1] }] }, imageIds: [], sourceRefs: ["## 圖表"] },
      { id: "many-table", title: "表格", layout: "table", blocks, table: { columns: ["A"], rows: [["1"]] }, imageIds: [], sourceRefs: ["## 表格"] },
    ] as const;
    const blockBoxes: Record<string, { x: number; y: number; w: number; h: number }> = {
      cover: { x: 1.0, y: 4.35, w: 11.33, h: 1.3 },
      section: { x: 1.1, y: 3.75, w: 11.13, h: 1.4 },
      closing: { x: 1.1, y: 3.75, w: 11.13, h: 1.4 },
      image: { x: 0.55, y: 6.29, w: 12.233, h: 0.44 },
      chart: { x: 0.65, y: 6.1, w: 12.0, h: 0.55 },
      table: { x: 0.65, y: 6.1, w: 12.0, h: 0.55 },
    };

    for (const slide of maxBlockSlides) {
      const objects = buildSlideLayout(slide, defaultTheme);
      const bodyObjects = objects.filter((object) => object.kind === "text" && object.role === "body");
      const parentBox = blockBoxes[slide.layout];
      expect(bodyObjects, slide.layout).toHaveLength(12);
      for (const object of bodyObjects) {
        expect(object.x).toBeGreaterThanOrEqual(parentBox.x);
        expect(object.y).toBeGreaterThanOrEqual(parentBox.y);
        expect(object.x + object.w).toBeLessThanOrEqual(parentBox.x + parentBox.w + 1e-6);
        expect(object.y + object.h).toBeLessThanOrEqual(parentBox.y + parentBox.h + 1e-6);
      }
      for (const object of objects) {
        expect(object.x, `${slide.layout}/${object.id} left`).toBeGreaterThanOrEqual(0.45);
        expect(object.y, `${slide.layout}/${object.id} top`).toBeGreaterThanOrEqual(0.35);
        expect(object.x + object.w, `${slide.layout}/${object.id} right`).toBeLessThanOrEqual(12.883);
        expect(object.y + object.h, `${slide.layout}/${object.id} bottom`).toBeLessThanOrEqual(7.15);
      }
      expect(findOverflow(objects, getCanvas(defaultTheme)).some((issue) => issue.code === "SPLIT_REQUIRED" || issue.code === "SUMMARY_REQUIRED")).toBe(true);
      expect(findOverflow(objects, getCanvas(defaultTheme)).some((issue) => issue.code === "LAYOUT_OVERFLOW")).toBe(false);
    }
  });

  it("accepts 2x2 diagram connectors with zero width or height only when their endpoints stay safe", () => {
    const diagram = {
      id: "grid-diagram",
      title: "節點關係",
      layout: "diagram",
      blocks: [],
      imageIds: [],
      sourceRefs: ["## 流程"],
      diagram: {
        nodes: [
          { id: "n1", label: "左上" }, { id: "n2", label: "右上" },
          { id: "n3", label: "左下" }, { id: "n4", label: "右下" },
        ],
        edges: [
          { from: "n1", to: "n2" },
          { from: "n1", to: "n3" },
        ],
      },
    } as const;
    const objects = buildSlideLayout(diagram, defaultTheme);
    const lines = objects.filter((object) => object.kind === "line");
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.h === 0)).toBe(true);
    expect(lines.some((line) => line.w === 0)).toBe(true);
    for (const line of lines) {
      for (const [x, y] of [[line.x1, line.y1], [line.x2, line.y2]]) {
        expect(x).toBeGreaterThanOrEqual(0.45);
        expect(y).toBeGreaterThanOrEqual(0.35);
        expect(x).toBeLessThanOrEqual(12.883);
        expect(y).toBeLessThanOrEqual(7.15);
      }
      expect(line.x).toBeGreaterThanOrEqual(0.45);
      expect(line.y).toBeGreaterThanOrEqual(0.35);
      expect(line.x + line.w).toBeLessThanOrEqual(12.883);
      expect(line.y + line.h).toBeLessThanOrEqual(7.15);
    }
    expect(findOverflow(objects, getCanvas(defaultTheme)).filter((issue) => issue.code === "LAYOUT_OVERFLOW")).toEqual([]);
  });

  it("keeps parallel edge labels near their mapped connectors or reports when placement cannot stay local", () => {
    const diagram: Extract<SlidePlan, { layout: "diagram" }> = {
      id: "parallel-edges", title: "平行關係", layout: "diagram",
      diagram: {
        nodes: [{ id: "left", label: "起點" }, { id: "right", label: "終點" }],
        edges: Array.from({ length: 12 }, (_, index) => ({ from: "left", to: "right", label: `關係${index + 1}` })),
      },
      imageIds: [], sourceRefs: ["## 關係"],
    };
    const objects = buildSlideLayout(diagram, defaultTheme);
    const labels = objects.filter((object) => object.kind === "text" && object.role === "diagram-edge-label");
    const lines = objects.filter((object) => object.kind === "line");
    const issues = findOverflow(objects, getCanvas(defaultTheme));
    expect(labels).toHaveLength(12);
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index]!;
      const line = lines.find((candidate) => candidate.id === `${diagram.id}:edge:${index + 1}`)!;
      const distance = Math.hypot(
        label.x + label.w / 2 - (line.x1 + line.x2) / 2,
        label.y + label.h / 2 - (line.y1 + line.y2) / 2,
      );
      expect(distance <= 2.3 || issues.some((issue) => issue.objectId === label.id && issue.code === "SUMMARY_REQUIRED" && issue.actionable), `${label.id} connector association`).toBe(true);
    }
  });

  it("reports duplicate connector geometry for every edge and its mapped label", () => {
    const diagram: Extract<SlidePlan, { layout: "diagram" }> = {
      id: "duplicate-edges", title: "重複連線", layout: "diagram",
      diagram: {
        nodes: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }],
        edges: [
          { from: "a", to: "b", label: "關係一" },
          { from: "a", to: "b", label: "關係二" },
        ],
      },
      imageIds: [], sourceRefs: ["## 關係"],
    };
    const objects = buildSlideLayout(diagram, defaultTheme);
    const lines = objects.filter((object) => object.kind === "line");
    const labels = objects.filter((object) => object.kind === "text" && object.role === "diagram-edge-label");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ x1: lines[1]!.x1, y1: lines[1]!.y1, x2: lines[1]!.x2, y2: lines[1]!.y2 });

    const issues = findOverflow(objects, getCanvas(defaultTheme));
    for (let index = 0; index < 2; index += 1) {
      const line = lines[index]!;
      const peer = lines[1 - index]!;
      const connectorIssue = issues.find((issue) => issue.objectId === line.id && issue.code === "SUMMARY_REQUIRED");
      expect(connectorIssue?.actionable).toBe(true);
      expect(connectorIssue?.overlapsWith).toContain(peer.id);

      const label = labels.find((candidate) => candidate.id === `${diagram.id}:edge-label:${index + 1}`)!;
      const labelIssue = issues.find((issue) => issue.objectId === label.id && issue.relatedObjectId === line.id && issue.code === "SUMMARY_REQUIRED");
      expect(labelIssue?.actionable).toBe(true);
      expect(labelIssue?.overlapsWith).toContain(peer.id);
    }
  });

  it("trims diagram connectors outside source and destination nodes in every direction", () => {
    const diagram: Extract<SlidePlan, { layout: "diagram" }> = {
      id: "trimmed-connectors", title: "連線方向", layout: "diagram",
      diagram: {
        nodes: [
          { id: "top-left", label: "左上" }, { id: "top-right", label: "右上" },
          { id: "bottom-left", label: "左下" }, { id: "bottom-right", label: "右下" },
        ],
        edges: [
          { from: "top-left", to: "top-right" },
          { from: "top-left", to: "bottom-right" },
          { from: "top-right", to: "bottom-left" },
          { from: "bottom-left", to: "top-right" },
          { from: "bottom-right", to: "top-left" },
        ],
      },
      imageIds: [], sourceRefs: ["## 連線"],
    };
    const objects = buildSlideLayout(diagram, defaultTheme);
    const connectors = objects.filter((object) => object.kind === "line");
    const nodeShapes = objects.filter((object) => object.kind === "shape" && object.id.includes(`${diagram.id}:node:`));
    const rayExitDistance = (box: { w: number; h: number }, directionX: number, directionY: number) => Math.min(
      directionX === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(directionX),
      directionY === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(directionY),
    );
    expect(connectors).toHaveLength(5);
    for (const connector of connectors) {
      const source = nodeShapes.find((node) => node.id === `${diagram.id}:node:${connector.from}`)!;
      const target = nodeShapes.find((node) => node.id === `${diagram.id}:node:${connector.to}`)!;
      const directionLength = Math.hypot(connector.x2 - connector.x1, connector.y2 - connector.y1);
      const directionX = (connector.x2 - connector.x1) / directionLength;
      const directionY = (connector.y2 - connector.y1) / directionLength;
      const sourceCenterX = source.x + source.w / 2;
      const sourceCenterY = source.y + source.h / 2;
      const targetCenterX = target.x + target.w / 2;
      const targetCenterY = target.y + target.h / 2;
      const sourceGap = Math.hypot(connector.x1 - sourceCenterX, connector.y1 - sourceCenterY)
        - rayExitDistance(source, directionX, directionY);
      const targetGap = Math.hypot(connector.x2 - targetCenterX, connector.y2 - targetCenterY)
        - rayExitDistance(target, -directionX, -directionY);
      expect(sourceGap, `${connector.id} source`).toBeCloseTo(0.04, 2);
      expect(targetGap, `${connector.id} target arrow`).toBeCloseTo(0.04, 2);
    }
  });

  it("reports a connector crossing an unrelated diagram node with both object IDs", () => {
    const diagram: Extract<SlidePlan, { layout: "diagram" }> = {
      id: "crossed-node", title: "穿越節點", layout: "diagram",
      diagram: {
        nodes: [
          { id: "source", label: "來源" },
          { id: "middle", label: "中間" },
          { id: "target", label: "目標" },
          { id: "lower-left", label: "左下" },
          { id: "lower-right", label: "右下" },
        ],
        edges: [{ from: "source", to: "target" }, { from: "source", to: "middle" }],
      },
      imageIds: [], sourceRefs: [],
    };
    const issues = findOverflow(buildSlideLayout(diagram, defaultTheme), getCanvas(defaultTheme));
    expect(issues).toContainEqual(expect.objectContaining({
      code: "SUMMARY_REQUIRED",
      slideId: "crossed-node",
      objectId: "crossed-node:edge:1",
      overlapsWith: ["crossed-node:node:middle"],
      actionable: true,
    }));
    expect(issues.some((issue) => issue.objectId === "crossed-node:edge:2" && issue.overlapsWith?.includes("crossed-node:node:middle"))).toBe(false);
  });

  it("reports self-edges for simplification without emitting non-finite connector geometry", () => {
    const diagram: Extract<SlidePlan, { layout: "diagram" }> = {
      id: "self-edge", title: "自我連線", layout: "diagram",
      diagram: {
        nodes: [{ id: "loop", label: "循環節點" }, { id: "other", label: "其他節點" }],
        edges: [{ from: "loop", to: "loop", label: "重新嘗試" }],
      },
      imageIds: [], sourceRefs: [],
    };
    const objects = buildSlideLayout(diagram, defaultTheme);
    const connector = objects.find((object) => object.kind === "line");
    expect(connector).toBeDefined();
    if (!connector || connector.kind !== "line") throw new Error("expected connector");
    expect([connector.x, connector.y, connector.w, connector.h, connector.x1, connector.y1, connector.x2, connector.y2].every(Number.isFinite)).toBe(true);

    const issue = findOverflow(objects, getCanvas(defaultTheme)).find((candidate) => candidate.objectId === connector.id);
    expect(issue?.code).toBe("SUMMARY_REQUIRED");
    expect(issue?.actionable).toBe(true);
    expect(issue?.message).toMatch(/自我連線|簡化|拆分/u);
  });
});

describe("text measurement and overflow", () => {
  it("wraps Traditional Chinese and mixed Latin text deterministically", () => {
    const box = { x: 0.45, y: 0.35, w: 4, h: 0.6 };
    const typography = { fontFace: "Noto Sans CJK TC", fontSize: 20, minFontSize: 18, lineHeight: 1.2 };
    const chinese = measureTextBlock("保留來源中的重要數字與限定條件，避免過度摘要改變原意。".repeat(2), box, typography);
    const mixed = measureTextBlock("KV Cache 890 B/token enables efficient inference with bounded quality loss.".repeat(2), box, typography);
    expect(chinese.lineCount).toBeGreaterThan(1);
    expect(mixed.lineCount).toBeGreaterThan(1);
    expect(chinese.fits).toBe(false);
    expect(mixed.fits).toBe(false);
    expect(chinese.fontSize).toBe(20);
  });

  it("reports safe-area and text overflow with a concrete split or summary action", () => {
    const slide = allLayoutFixtures.find((item) => item.layout === "bullets")!;
    const objects = buildSlideLayout(slide, defaultTheme);
    const title = objects.find((object) => object.kind === "text" && object.role === "title")!;
    const overflowingText = {
      ...title,
      id: "too-long",
      x: 0.45,
      y: 0.35,
      w: 4,
      h: 0.45,
      text: "繁體中文內容需要拆分並保留重要數據。".repeat(30),
      fontSize: 20,
      minFontSize: 18,
    };
    const outside = { ...title, id: "outside", x: 12.9 };
    const issues = findOverflow([overflowingText, outside], getCanvas(defaultTheme));
    expect(issues.some((issue) => issue.objectId === "too-long" && issue.code === "SUMMARY_REQUIRED" && issue.actionable)).toBe(true);
    expect(issues.some((issue) => issue.objectId === "outside" && issue.code === "LAYOUT_OVERFLOW")).toBe(true);

    const splittable = {
      ...overflowingText,
      id: "split-me",
      role: "body" as const,
      text: "繁體中文段落需要適度拆分以確保每一頁都保留清楚可讀的內容。",
      h: 0.72,
      maxLines: undefined,
    };
    expect(findOverflow([splittable], getCanvas(defaultTheme)).some((issue) => issue.code === "SPLIT_REQUIRED")).toBe(true);
  });

  it("never requests fonts below the body and note floors", () => {
    const objects = buildSlideLayout(allLayoutFixtures.find((item) => item.layout === "bullets")!, defaultTheme);
    for (const object of objects) {
      if (object.kind === "text") {
        expect(object.fontSize).toBeGreaterThanOrEqual(object.role === "source" ? 12 : 18);
        expect(object.minFontSize).toBeGreaterThanOrEqual(object.role === "source" ? 12 : 18);
      }
    }
  });
});
