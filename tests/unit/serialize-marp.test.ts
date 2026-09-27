import { describe, expect, it } from "vitest";
import { makePresentationPlanFixture, loadDefaultTheme } from "../helpers/layout-fixtures.js";
import { serializeMarp } from "../../src/marp/serialize-marp.js";

const defaultTheme = loadDefaultTheme();

describe("serializeMarp", () => {
  it("writes valid 16:9 Marp front matter and one slide boundary per planned slide", () => {
    const plan = makePresentationPlanFixture();
    const source = serializeMarp(plan, defaultTheme);
    expect(source).toMatch(/^---\nmarp: true\nsize: 16:9\ntheme: default\ntitle: /);
    expect(source.match(/^---\s*$/gm)).toHaveLength(plan.slides.length + 1);
    expect(source).toContain('title: "KV Cache 壓縮"');
  });

  it("preserves every planned slide title, image reference, and source location", () => {
    const plan = makePresentationPlanFixture();
    const source = serializeMarp(plan, defaultTheme);
    for (const slide of plan.slides) {
      expect(source).toContain(`# ${slide.title}`);
      for (const ref of slide.sourceRefs ?? []) {
        const escapedRef = ref.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, "\\$&");
        expect(source).toContain(escapedRef);
      }
      for (const imageId of slide.imageIds) expect(source).toContain(`assets/${encodeURIComponent(imageId)}.png`);
    }
  });

  it("preserves URL source references as escaped visible text without fetching them", () => {
    const plan = makePresentationPlanFixture();
    plan.slides[0]!.sourceRefs = ["https://example.org/research/report"];

    const source = serializeMarp(plan, defaultTheme);

    expect(source).toContain("https\\://example\\.org/research/report");
  });

  it("serializes structured tables, charts, and diagrams without external images", () => {
    const source = serializeMarp(makePresentationPlanFixture(), defaultTheme);
    expect(source).toContain("| 模式 | 用量 |");
    expect(source).toContain("| 基準 | 12 |");
    expect(source).toContain("記憶體");
    expect(source).toContain("edge diagram:edge:1: from input (輸入) → to encode (壓縮)");
    expect(source).toContain("edge diagram:edge:2: from encode (壓縮) → to output (推論)");
    expect(source).not.toMatch(/!\[[^\]]*\]\((?:https?:)?\/\//i);
  });

  it("serializes every diagram node and edge label, including disconnected nodes", () => {
    const plan = makePresentationPlanFixture();
    const diagramSlide = plan.slides.find((slide) => slide.layout === "diagram");
    expect(diagramSlide?.layout).toBe("diagram");
    if (diagramSlide?.layout !== "diagram") throw new Error("expected diagram fixture");
    diagramSlide.diagram.nodes.push({ id: "isolated", label: "獨立節點" });
    diagramSlide.diagram.edges[0]!.label = "輸入轉換";

    const source = serializeMarp(plan, defaultTheme);
    for (const node of diagramSlide.diagram.nodes) expect(source).toContain(node.label);
    for (const edge of diagramSlide.diagram.edges) {
      expect(source).toContain(diagramSlide.diagram.nodes.find((node) => node.id === edge.from)!.label);
      expect(source).toContain(diagramSlide.diagram.nodes.find((node) => node.id === edge.to)!.label);
      if (edge.label) expect(source).toContain(edge.label);
    }
  });

  it("maps duplicate node labels to stable node IDs and edge IDs", () => {
    const plan = makePresentationPlanFixture();
    const diagramSlide = plan.slides.find((slide) => slide.layout === "diagram");
    expect(diagramSlide?.layout).toBe("diagram");
    if (diagramSlide?.layout !== "diagram") throw new Error("expected diagram fixture");
    diagramSlide.diagram.nodes[0]!.label = "重複名稱";
    diagramSlide.diagram.nodes[1]!.label = "重複名稱";
    diagramSlide.diagram.nodes[0]!.id = "input<node>";
    diagramSlide.diagram.edges = [
      { from: "input<node>", to: "encode", label: "轉換" },
      { from: "encode", to: "output", label: "傳遞" },
    ];

    const source = serializeMarp(plan, defaultTheme);
    expect(source).toContain("- node input\\<node\\>: 重複名稱");
    expect(source).toContain("- node encode: 重複名稱");
    expect(source).toContain("- edge diagram:edge:1: from input\\<node\\> (重複名稱) → to encode (重複名稱)（轉換）");
    expect(source).toContain("- edge diagram:edge:2: from encode (重複名稱) → to output (推論)（傳遞）");
    expect(source).not.toContain("input<node>");
  });

  it("escapes Markdown syntax so plan text stays text", () => {
    const plan = makePresentationPlanFixture();
    plan.slides = [{
      id: "escaped",
      title: "安全輸出",
      layout: "takeaway",
      blocks: [{ id: "literal", text: "literal *emphasis* and [link](https://example.test)" }],
      imageIds: [],
      sourceRefs: ["## 安全輸出"],
    }];
    plan.imageAssetIds = [];
    plan.assetManifest = [];
    expect(() => serializeMarp(plan, defaultTheme)).toThrow(/external URL/i);

    plan.slides[0] = {
      ...plan.slides[0],
      blocks: [{ id: "literal", text: "literal *emphasis* and [brackets]" }],
    };
    const source = serializeMarp(plan, defaultTheme);
    expect(source).toContain("literal \\*emphasis\\* and \\[brackets\\]");
  });

  it("downgrades LaTeX formulas before serializing Marp text", () => {
    const plan = makePresentationPlanFixture();
    plan.slides = [{
      id: "formula", title: "注意力公式", layout: "takeaway",
      blocks: [{ id: "formula-text", text: String.raw`\[\mathrm{Attention}(Q,K,V)=\mathrm{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V\]` }],
      imageIds: [], sourceRefs: ["## 公式"],
    }];
    plan.imageAssetIds = [];
    plan.assetManifest = [];
    const source = serializeMarp(plan, defaultTheme);
    expect(source).toContain("Attention\\(Q,K,V");
    expect(source).toContain("QKᵀ");
    expect(source).not.toMatch(/\\\[|\\\]|\\(?:mathrm|frac|sqrt|top)/u);
  });

  it("serializes metric comparisons with a larger after-value emphasis", () => {
    const plan = makePresentationPlanFixture();
    plan.slides = [{
      id: "metric", title: "準確度變化", layout: "takeaway",
      blocks: [{ id: "score", text: "顯著從32分提升到62分" }],
      imageIds: [], sourceRefs: ["## 結果"],
    }];
    plan.imageAssetIds = [];
    plan.assetManifest = [];
    const source = serializeMarp(plan, defaultTheme);
    expect(source).toContain("顯著提升");
    expect(source).toContain("font-size:1.5em");
    expect(source).toContain("32分");
    expect(source).toContain("62分");
  });

  it("escapes table pipes without creating extra Markdown columns", () => {
    const plan = makePresentationPlanFixture();
    const tableSlide = plan.slides.find((slide) => slide.layout === "table");
    expect(tableSlide?.layout).toBe("table");
    if (tableSlide?.layout !== "table") throw new Error("expected table fixture");
    tableSlide.table.rows[0][0] = "P50 | P90";
    expect(serializeMarp(plan, defaultTheme)).toContain("| P50 \\| P90 | 12 |");
  });

  it.each([
    ["HTML-like filename", "cover<script>.png", /raw HTML/i],
    ["URL-like filename", "www.example.test.png", /external URL/i],
  ])("rejects an unsafe %s before writing it into an image alt", (_label, fileName, error) => {
    const plan = makePresentationPlanFixture();
    plan.assetManifest[0].fileName = fileName;
    expect(() => serializeMarp(plan, defaultTheme)).toThrow(error);
  });

  it("keeps ordinary less-than and greater-than comparisons visible as escaped text", () => {
    const plan = makePresentationPlanFixture();
    plan.slides = [{
      id: "comparison-text",
      title: "快取比較",
      layout: "takeaway",
      blocks: [{ id: "comparison", text: "Memory < cache > value" }],
      imageIds: [],
      sourceRefs: ["## 比較"],
    }];
    plan.imageAssetIds = [];
    plan.assetManifest = [];
    const source = serializeMarp(plan, defaultTheme);
    expect(source).toContain("Memory \\< cache \\> value");
  });

  it.each([
    ["raw HTML", "<script>alert(1)</script>"],
    ["Marp directive", "<!-- _class: lead -->"],
    ["external image", "![photo](https://example.test/photo.png)"],
  ])("rejects %s embedded in plan text", (_label, text) => {
    const plan = makePresentationPlanFixture();
    plan.slides[0] = {
      id: "unsafe",
      title: "輸入內容",
      layout: "takeaway",
      blocks: [{ id: "unsafe-text", text }],
      imageIds: [],
      sourceRefs: ["## 輸入"],
    };
    plan.slides = [plan.slides[0]];
    plan.imageAssetIds = [];
    plan.assetManifest = [];
    expect(() => serializeMarp(plan, defaultTheme)).toThrow();
  });
});
