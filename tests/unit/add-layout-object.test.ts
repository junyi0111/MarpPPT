import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pptxgen from "pptxgenjs";
import { strFromU8, unzipSync } from "fflate";
import { addLayoutObject, type LayoutObjectContext } from "../../src/pptx/add-layout-object.js";
import { inspectPptx } from "../../src/pptx/render-pptx.js";
import { loadDefaultTheme, makeResolvedImagePathFixture } from "../helpers/layout-fixtures.js";

const theme = loadDefaultTheme();
let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("native layout object mapping", () => {
  it("centers diagram labels while keeping ordinary body text left aligned", () => {
    const calls: Array<{ text: string; options: Record<string, unknown> }> = [];
    const context: LayoutObjectContext = {
      pptx: { ShapeType: { rect: "rect", roundRect: "roundRect", ellipse: "ellipse", diamond: "diamond", line: "line" }, ChartType: { bar: "bar", line: "line", pie: "pie" } },
      slide: {
        addText: (text, options) => { calls.push({ text, options }); },
        addShape: () => undefined,
        addImage: () => undefined,
        addTable: () => undefined,
        addChart: () => undefined,
      },
      assets: new Map(),
      theme,
    };
    addLayoutObject({
      kind: "text", id: "node-label", slideId: "s1", x: 1, y: 1, w: 3, h: 1,
      role: "diagram-node", text: "節點", fontFace: theme.typography.fontFace, fontSize: 20,
      minFontSize: 18, lineHeight: 1.2, color: "#172554",
    }, context);
    addLayoutObject({
      kind: "text", id: "body-label", slideId: "s1", x: 1, y: 2, w: 3, h: 1,
      role: "body", text: "內文", fontFace: theme.typography.fontFace, fontSize: 20,
      minFontSize: 18, lineHeight: 1.2, color: "#172554",
    }, context);
    expect(calls[0]!.options.align).toBe("center");
    expect(calls[1]!.options.align).toBe("left");
  });

  it.each([
    ["horizontal", [1, 1, 4, 1], false, false],
    ["positive slope", [1, 1, 4, 3], false, false],
    ["negative slope", [1, 3, 4, 1], false, true],
    ["reverse node order on a negative slope", [4, 1, 1, 3], true, false],
    ["reverse node order on a positive slope", [4, 3, 1, 1], true, true],
  ] as const)("maps %s connectors with the destination at the arrow end", (_label, points, expectedFlipH, expectedFlipV) => {
    const calls: Array<{ shapeName: string; options: Record<string, unknown> }> = [];
    const context: LayoutObjectContext = {
      pptx: { ShapeType: { rect: "rect", roundRect: "roundRect", ellipse: "ellipse", diamond: "diamond", line: "line" }, ChartType: { bar: "bar", line: "line", pie: "pie" } },
      slide: {
        addText: () => undefined,
        addShape: (shapeName, options) => { calls.push({ shapeName, options }); },
        addImage: () => undefined,
        addTable: () => undefined,
        addChart: () => undefined,
      },
      assets: new Map(),
      theme,
    };
    const [x1, y1, x2, y2] = points;
    addLayoutObject({
      kind: "line", id: "edge-1", slideId: "s1",
      x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
      x1, y1, x2, y2, from: "a", to: "b", stroke: "#2563EB", strokeWidth: 1.4, endArrow: true,
    }, context);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.shapeName).toBe("line");
    expect(calls[0]!.options).toMatchObject({ flipH: expectedFlipH, flipV: expectedFlipV });
    expect(calls[0]!.options.line).toMatchObject({ endArrowType: "triangle" });
  });

  it("maps text, shape, connector, and resolved image to separate editable objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "marpppt-object-map-"));
    roots.push(root);
    const image = await makeResolvedImagePathFixture("image-1", "photo.png", root);
    // @ts-expect-error PptxGenJS 4's ESM runtime is constructable; its published NodeNext type is not.
    const pptx = new pptxgen();
    pptx.defineLayout({ name: "marp-test", width: theme.canvas.width, height: theme.canvas.height });
    pptx.layout = "marp-test";
    const slide = pptx.addSlide();
    const assets = new Map([[image.assetId, image]]);
    const context = { pptx, slide, assets, theme };

    addLayoutObject({
      kind: "text", id: "text-1", slideId: "s1", x: 1, y: 1, w: 3, h: 1,
      role: "body", text: "獨立文字", fontFace: "Noto Sans CJK TC", fontSize: 20,
      minFontSize: 18, lineHeight: 1.2, color: "#172554",
    }, context);
    addLayoutObject({
      kind: "shape", id: "shape-1", slideId: "s1", x: 1, y: 2.5, w: 1.2, h: 0.7,
      shape: "roundRect", fill: "#DBEAFE", stroke: "#00000000", strokeWidth: 1,
    }, context);
    addLayoutObject({
      kind: "line", id: "edge-1", slideId: "s1", x: 2.5, y: 2.5, w: 2, h: 1,
      x1: 2.5, y1: 2.5, x2: 4.5, y2: 3.5, from: "a", to: "b",
      stroke: "#2563EB", strokeWidth: 1.4, endArrow: true,
    }, context);
    addLayoutObject({
      kind: "image", id: "image-1", slideId: "s1", x: 6, y: 1, w: 3, h: 2,
      assetId: "image-1", alt: "測試圖片", fit: "contain",
    }, context);

    const bytes = await pptx.write({ outputType: "uint8array" });
    const inspection = await inspectPptx(bytes as Uint8Array);
    expect(inspection.textShapeCount).toBe(1);
    expect(inspection.pictureCount).toBe(1);
    expect(inspection.shapeCount).toBeGreaterThanOrEqual(2);
    expect(inspection.embeddedMediaCount).toBe(1);
    const slideXml = strFromU8(unzipSync(bytes as Uint8Array)["ppt/slides/slide1.xml"]!);
    expect(slideXml).not.toMatch(/<a:srgbClr[^>]*\bval="00000000"/u);
    expect(slideXml).toMatch(/<a:alpha\b[^>]*\bval="0"/u);
    expect(slideXml).toContain("Noto Sans CJK TC");
    expect(slideXml).not.toMatch(/<(?:a:spAutoFit|a:normAutofit)\b/u);
  });
});
