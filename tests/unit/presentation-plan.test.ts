import { describe, expect, it } from "vitest";
import {
  PresentationPlanSchema,
  validatePresentationPlan,
  type PresentationPlan,
} from "../../src/contracts/presentation-plan.js";

const validMixedDeck: PresentationPlan = {
  version: 1,
  title: "Quarterly Update",
  language: "zh-TW",
  themeId: "default",
  sourceDigest: "a".repeat(64),
  imageAssetIds: ["image-1"],
  assetManifest: [
    {
      assetId: "image-1",
      fileName: "diagram.png",
      mimeType: "image/png",
      byteLength: 8,
      sha256: "b".repeat(64),
    },
  ],
  slides: [{
    id: "s1",
    title: "重點",
    layout: "image-text",
    blocks: [
      { id: "b1", text: "第一項" },
      { id: "b2", text: "第二項" },
      { id: "b3", text: "第三項" },
    ],
    imageIds: ["image-1"],
    sourceRefs: ["## 重點"],
  }],
};

const validSlides: PresentationPlan["slides"] = [
  { id: "cover", title: "封面", layout: "cover", imageIds: [], sourceRefs: [] },
  { id: "section", title: "章節", layout: "section", imageIds: [], sourceRefs: ["## 背景"] },
  { id: "takeaway", title: "結論", layout: "takeaway", blocks: [{ id: "takeaway-text", text: "採用方案 A" }], imageIds: [], sourceRefs: ["## 結論"] },
  { id: "bullets", title: "重點", layout: "bullets", blocks: [
    { id: "point-1", text: "第一點" }, { id: "point-2", text: "第二點" }, { id: "point-3", text: "第三點" },
  ], imageIds: [], sourceRefs: ["## 重點"] },
  { id: "image-text", title: "圖文", layout: "image-text", blocks: [{ id: "caption", text: "文字說明" }], imageIds: ["image-1"], sourceRefs: ["## 圖文"] },
  { id: "comparison", title: "比較", layout: "comparison", columns: [
    { id: "option-a", title: "方案 A", blocks: [{ id: "a-point", text: "優點 A" }] },
    { id: "option-b", title: "方案 B", blocks: [{ id: "b-point", text: "優點 B" }] },
  ], imageIds: [], sourceRefs: ["## 比較"] },
  { id: "image", title: "圖片", layout: "image", imageIds: ["image-1"], sourceRefs: ["## 圖片"] },
  { id: "chart", title: "圖表", layout: "chart", chart: {
    kind: "bar", labels: ["Q1", "Q2"], series: [{ name: "營收", values: [10, 20] }],
  }, imageIds: [], sourceRefs: ["## 圖表"] },
  { id: "table", title: "表格", layout: "table", table: {
    columns: ["項目", "數值"], rows: [["A", "1"]],
  }, imageIds: [], sourceRefs: ["## 表格"] },
  { id: "diagram", title: "流程", layout: "diagram", diagram: {
    nodes: [{ id: "start", label: "開始" }, { id: "end", label: "結束" }],
    edges: [{ from: "start", to: "end", label: "完成" }],
  }, imageIds: [], sourceRefs: ["## 流程"] },
  { id: "closing", title: "結尾", layout: "closing", blocks: [{ id: "closing-text", text: "謝謝" }], imageIds: [], sourceRefs: ["## 結尾"] },
];

describe("PresentationPlanSchema", () => {
  it("accepts a canonical plan with source digest and image manifest", () => {
    expect(PresentationPlanSchema.safeParse(validMixedDeck).success).toBe(true);
  });

  it("accepts each controlled layout when its required content is present", () => {
    const result = PresentationPlanSchema.safeParse({ ...validMixedDeck, slides: validSlides });
    expect(result.success).toBe(true);
  });

  it("rejects content fields that a layout cannot render into the editable PPTX", () => {
    const invalidPlacements = [
      {
        ...validMixedDeck.slides[0],
        layout: "bullets",
        blocks: [
          { id: "point-1", text: "第一點" },
          { id: "point-2", text: "第二點" },
          { id: "point-3", text: "第三點" },
        ],
      },
      {
        id: "chart-subtitle",
        title: "圖表",
        layout: "chart",
        subtitle: "不能漏掉的補充",
        chart: { kind: "bar", labels: ["A"], series: [{ name: "S", values: [1] }] },
        imageIds: [],
        sourceRefs: ["## 圖表"],
      },
      {
        id: "diagram-blocks",
        title: "流程",
        layout: "diagram",
        blocks: [{ id: "note", text: "不能漏掉的補充" }],
        diagram: {
          nodes: [{ id: "start", label: "開始" }, { id: "end", label: "結束" }],
          edges: [{ from: "start", to: "end" }],
        },
        imageIds: [],
        sourceRefs: ["## 流程"],
      },
    ];

    for (const slide of invalidPlacements) {
      expect(PresentationPlanSchema.safeParse({ ...validMixedDeck, slides: [slide] }).success).toBe(false);
    }

    expect(PresentationPlanSchema.safeParse({
      ...validMixedDeck,
      slides: [{ ...validMixedDeck.slides[0], layout: "image", blocks: undefined }],
    }).success).toBe(true);
    expect(PresentationPlanSchema.safeParse({
      ...validMixedDeck,
      slides: [{
        id: "cover-subtitle",
        title: "封面",
        layout: "cover",
        subtitle: "已保留的副標",
        imageIds: [],
        sourceRefs: ["## 摘要"],
      }],
    }).success).toBe(true);
  });

  it("requires source locations on content slides but allows structural slides without them", () => {
    const structuralSlides = [
      { id: "cover-structural", title: "封面", layout: "cover", imageIds: [] },
      { id: "section-structural", title: "章節", layout: "section", imageIds: [] },
      { id: "closing-structural", title: "結尾", layout: "closing", imageIds: [] },
    ];
    expect(PresentationPlanSchema.safeParse({ ...validMixedDeck, slides: structuralSlides }).success).toBe(true);

    const contentWithoutRefs = {
      ...validMixedDeck,
      slides: [{ ...validMixedDeck.slides[0], sourceRefs: [] }],
    };
    expect(PresentationPlanSchema.safeParse(contentWithoutRefs).success).toBe(false);

    const sourcedBlocksWithoutRefs = {
      ...validMixedDeck,
      slides: [{ id: "closing-content", title: "結尾", layout: "closing", blocks: [{ id: "summary", text: "主要結論" }], imageIds: [] }],
    };
    expect(PresentationPlanSchema.safeParse(sourcedBlocksWithoutRefs).success).toBe(false);

    const structuralCoverWithSourceText = {
      ...validMixedDeck,
      slides: [{ id: "cover-text", title: "封面", layout: "cover", subtitle: "來自來源的副標", imageIds: [] }],
    };
    expect(PresentationPlanSchema.safeParse(structuralCoverWithSourceText).success).toBe(false);
  });

  it("rejects layout-specific data when it is missing or malformed", () => {
    const invalidSlides = [
      { id: "table", title: "表格", layout: "table", imageIds: [], sourceRefs: [] },
      { id: "chart", title: "圖表", layout: "chart", chart: { kind: "bar", labels: ["A", "B"], series: [{ name: "S", values: [1] }] }, imageIds: [], sourceRefs: [] },
      { id: "diagram", title: "流程", layout: "diagram", diagram: { nodes: [{ id: "n1", label: "節點" }], edges: [{ from: "n1", to: "absent" }] }, imageIds: [], sourceRefs: [] },
      { id: "table-width", title: "欄數錯誤", layout: "table", table: { columns: ["A", "B"], rows: [["only A"]] }, imageIds: [], sourceRefs: [] },
      { id: "image", title: "圖片", layout: "image", imageIds: [], sourceRefs: [] },
      { id: "comparison", title: "比較", layout: "comparison", columns: [{ id: "only", title: "唯一", blocks: [{ id: "b", text: "內容" }] }], imageIds: [], sourceRefs: [] },
    ];

    for (const slide of invalidSlides) {
      expect(PresentationPlanSchema.safeParse({ ...validMixedDeck, slides: [slide] }).success).toBe(false);
    }
  });

  it("rejects duplicate IDs, empty object text, and titles beyond the supported limit", () => {
    expect(PresentationPlanSchema.safeParse({
      ...validMixedDeck,
      slides: [validMixedDeck.slides[0], { ...validMixedDeck.slides[0], title: "另一頁" }],
    }).success).toBe(false);
    expect(PresentationPlanSchema.safeParse({
      ...validMixedDeck,
      slides: [{ ...validMixedDeck.slides[0], blocks: [
        { id: "same", text: "A" }, { id: "same", text: "B" }, { id: "third", text: "C" },
      ] }],
    }).success).toBe(false);
    expect(PresentationPlanSchema.safeParse({
      ...validMixedDeck,
      slides: [{ ...validMixedDeck.slides[0], title: "T".repeat(161) }],
    }).success).toBe(false);
    expect(PresentationPlanSchema.safeParse({ ...validMixedDeck, title: "D".repeat(161) }).success).toBe(false);
    expect(PresentationPlanSchema.safeParse({
      ...validMixedDeck,
      slides: [{ ...validMixedDeck.slides[0], blocks: [
        { id: "b1", text: "" }, { id: "b2", text: "第二項" }, { id: "b3", text: "第三項" },
      ] }],
    }).success).toBe(false);
  });

  it("enforces the slide count and valid source and asset digests", () => {
    expect(PresentationPlanSchema.safeParse({ ...validMixedDeck, slides: [] }).success).toBe(false);
    expect(PresentationPlanSchema.safeParse({
      ...validMixedDeck,
      slides: Array.from({ length: 61 }, (_, i) => ({ ...validMixedDeck.slides[0], id: `s${i}` })),
    }).success).toBe(false);
    expect(PresentationPlanSchema.safeParse({ ...validMixedDeck, sourceDigest: "not-a-sha256" }).success).toBe(false);
    expect(PresentationPlanSchema.safeParse({
      ...validMixedDeck,
      assetManifest: [{ ...validMixedDeck.assetManifest[0], byteLength: 0 }],
    }).success).toBe(false);
  });

  it("rejects mismatched plan asset IDs and duplicate image asset IDs", () => {
    expect(PresentationPlanSchema.safeParse({ ...validMixedDeck, imageAssetIds: ["image-1", "image-1"] }).success).toBe(false);
    expect(PresentationPlanSchema.safeParse({ ...validMixedDeck, imageAssetIds: ["other-image"] }).success).toBe(false);
    expect(PresentationPlanSchema.safeParse({
      ...validMixedDeck,
      assetManifest: [{ ...validMixedDeck.assetManifest[0], mimeType: "image/gif" }],
    }).success).toBe(false);
  });
});

describe("validatePresentationPlan", () => {
  it("warns when a received image is unused and errors when a slide image is unavailable", () => {
    const unused = validatePresentationPlan({ ...validMixedDeck, imageAssetIds: [], assetManifest: [], slides: [{ ...validMixedDeck.slides[0], imageIds: [] }] }, ["image-1"]);
    expect(unused).toContainEqual(expect.objectContaining({ code: "UNUSED_IMAGE_ID", severity: "warning", imageId: "image-1" }));

    const missing = validatePresentationPlan({ ...validMixedDeck, imageAssetIds: ["image-2"], assetManifest: [{ ...validMixedDeck.assetManifest[0], assetId: "image-2" }], slides: [{ ...validMixedDeck.slides[0], imageIds: ["image-2"] }] }, ["image-1"]);
    expect(missing).toContainEqual(expect.objectContaining({ code: "MISSING_IMAGE_ID", severity: "error", slideId: "s1", imageId: "image-2" }));
  });

  it("errors when an image declared in the manifest was not actually received", () => {
    const issues = validatePresentationPlan({
      ...validMixedDeck,
      slides: [{ ...validMixedDeck.slides[0], imageIds: [] }],
    }, []);
    expect(issues).toContainEqual(expect.objectContaining({ code: "MISSING_IMAGE_ID", severity: "error", imageId: "image-1" }));
  });

  it("reports duplicate object IDs, empty slides, and table width mismatches with slide locations", () => {
    const malformed = {
      ...validMixedDeck,
      slides: [
        { ...validMixedDeck.slides[0], layout: "bullets", blocks: [
          { id: "repeat", text: "一" }, { id: "repeat", text: "二" }, { id: "third", text: "三" },
        ] },
        { id: "empty", title: "空白", layout: "takeaway", blocks: [], imageIds: [], sourceRefs: [] },
        { id: "bad-table", title: "表格", layout: "table", table: { columns: ["A", "B"], rows: [["only A"]] }, imageIds: [], sourceRefs: [] },
      ],
    };

    const issues = validatePresentationPlan(malformed, []);
    expect(issues).toContainEqual(expect.objectContaining({ code: "DUPLICATE_OBJECT_ID", severity: "error", slideId: "s1", objectId: "repeat" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "EMPTY_SLIDE", severity: "error", slideId: "empty" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "TABLE_COLUMN_MISMATCH", severity: "error", slideId: "bad-table" }));
  });

  it("is the single public path for ordinary untyped input and maps source-location errors", () => {
    const input = {
      ...validMixedDeck,
      slides: [
        { ...validMixedDeck.slides[0], sourceRefs: [], blocks: [
          { id: "duplicate", text: "第一項" }, { id: "duplicate", text: "第二項" }, { id: "third", text: "第三項" },
        ] },
        { id: "empty", title: "空白", layout: "takeaway", blocks: [], imageIds: [], sourceRefs: [] },
        { id: "bad-table", title: "表格", layout: "table", table: { columns: ["A", "B"], rows: [["only A"]] }, imageIds: [], sourceRefs: ["## 表格"] },
      ],
    };

    const issues = validatePresentationPlan(input, []);
    expect(issues).toContainEqual(expect.objectContaining({ code: "MISSING_SOURCE_REF", severity: "error", slideId: "s1" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "DUPLICATE_OBJECT_ID", severity: "error", slideId: "s1", objectId: "duplicate" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "EMPTY_SLIDE", severity: "error", slideId: "empty" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "TABLE_COLUMN_MISMATCH", severity: "error", slideId: "bad-table" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "MISSING_IMAGE_ID", severity: "error", slideId: "s1", imageId: "image-1" }));

    const invalidTitle = validatePresentationPlan({ ...validMixedDeck, title: "" }, ["image-1"]);
    expect(invalidTitle).toContainEqual(expect.objectContaining({ code: "INVALID_PLAN", severity: "error" }));

    const blankSourceRef = validatePresentationPlan({
      ...validMixedDeck,
      slides: [{ ...validMixedDeck.slides[0], sourceRefs: ["   "] }],
    }, ["image-1"]);
    expect(blankSourceRef).toContainEqual(expect.objectContaining({ code: "MISSING_SOURCE_REF", severity: "error", slideId: "s1" }));
  });
});
