import { createHash } from "node:crypto";
import { z } from "zod";
import type { PresentationPlan, SlidePlan } from "./presentation-plan.js";
import type { QualityIssue } from "../quality/types.js";

const id = z.string().trim().min(1).max(120);
const span = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
}).strict().refine((value) => value.endLine >= value.startLine, "endLine must be greater than or equal to startLine");

const form = z.enum(["metric", "comparison", "sequence", "architecture", "trend", "definition", "image-evidence", "table", "summary"]);
const variant = z.enum(["default", "compact", "metric", "text-left", "text-right", "image-above", "flow-horizontal", "flow-branch"]);
const focus = z.object({
  kind: z.enum(["block", "image", "chart", "table", "diagram"]),
  id: id.optional(),
}).strict();

export const SourceSpanSchema = span;
export const EditorialBriefSchema = z.object({
  version: z.literal(1),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/iu),
  audience: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(1).max(120),
  useCase: z.enum(["presenting", "reading"]),
  requestedSlideCount: z.number().int().min(1).max(60).optional(),
  mustKeepFacts: z.array(z.object({
    id,
    sourceSpan: span,
    verbatim: z.string().trim().min(1).max(1000),
    placement: z.enum(["slide", "notes"]).default("slide"),
  }).strict()).max(120).default([]),
  assets: z.array(z.object({
    assetId: id,
    role: z.enum(["brand", "evidence", "illustration"]),
    altText: z.string().trim().min(1).max(300),
  }).strict()).max(30).default([]),
  slides: z.array(z.object({
    slideId: id,
    purpose: z.string().trim().min(1).max(120),
    evidence: z.array(span).max(20).default([]),
    factIds: z.array(id).max(120).default([]),
    form,
    variant,
    focus,
    limitations: z.array(z.string().trim().min(1).max(240)).max(12).default([]),
    speakerNotes: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
    chartContext: z.object({
      xLabel: z.string().trim().min(1).max(120),
      yLabel: z.string().trim().min(1).max(120),
      unit: z.string().trim().min(1).max(60),
      referencePeriod: z.string().trim().min(1).max(120).optional(),
    }).strict().optional(),
  }).strict()).min(1).max(60),
}).strict().superRefine((brief, ctx) => {
  const factIds = new Set<string>();
  brief.mustKeepFacts.forEach((fact, index) => {
    if (factIds.has(fact.id)) ctx.addIssue({ code: "custom", path: ["mustKeepFacts", index, "id"], message: `Duplicate fact ID: ${fact.id}` });
    factIds.add(fact.id);
  });
  const slideIds = new Set<string>();
  brief.slides.forEach((slide, index) => {
    if (slideIds.has(slide.slideId)) ctx.addIssue({ code: "custom", path: ["slides", index, "slideId"], message: `Duplicate editorial slide ID: ${slide.slideId}` });
    slideIds.add(slide.slideId);
  });
});

export type SourceSpan = z.infer<typeof SourceSpanSchema>;
export type EditorialBrief = z.infer<typeof EditorialBriefSchema>;
export type EditorialSlide = EditorialBrief["slides"][number];

function digest(markdown: string): string {
  return createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex");
}

function sourceLines(markdown: string): string[] {
  return markdown.split(/\r?\n/u);
}

function spanText(lines: string[], sourceSpan: SourceSpan): string {
  return lines.slice(sourceSpan.startLine - 1, sourceSpan.endLine).join("\n");
}

function spanValid(sourceSpan: SourceSpan, lineCount: number): boolean {
  return sourceSpan.startLine >= 1 && sourceSpan.endLine >= sourceSpan.startLine && sourceSpan.endLine <= lineCount;
}

function slideObjectIds(slide: SlidePlan): Set<string> {
  const ids = new Set<string>();
  if ("blocks" in slide && slide.blocks) slide.blocks.forEach((block) => ids.add(block.id));
  if (slide.layout === "comparison") {
    slide.columns.forEach((column) => {
      ids.add(column.id);
      column.blocks.forEach((block) => ids.add(block.id));
    });
  }
  if (slide.layout === "diagram") slide.diagram.nodes.forEach((node) => ids.add(node.id));
  return ids;
}

function issue(code: string, message: string, suggestedAction: string, slideId?: string): QualityIssue {
  return { code, severity: "error", message, suggestedAction, ...(slideId ? { slideId } : {}) };
}

function focusMatches(slide: SlidePlan, selected: EditorialSlide["focus"]): boolean {
  if (selected.kind === "image") return slide.imageIds.length > 0 && (!selected.id || slide.imageIds.includes(selected.id));
  if (selected.kind === "chart") return slide.layout === "chart";
  if (selected.kind === "table") return slide.layout === "table";
  if (selected.kind === "diagram") return slide.layout === "diagram";
  return selected.kind === "block" && slideObjectIds(slide).has(selected.id ?? "");
}

export function checkEditorial(brief: EditorialBrief, plan: PresentationPlan, markdown: string): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const lines = sourceLines(markdown);
  if (brief.sourceDigest.toLowerCase() !== digest(markdown)) {
    issues.push(issue("EDITORIAL_SOURCE_DIGEST_MISMATCH", "編輯提要的 sourceDigest 與實際 Markdown 不一致。", "請使用本次要渲染的 Markdown 原始位元組重新產生編輯提要。"));
  }
  if (brief.sourceDigest.toLowerCase() !== plan.sourceDigest.toLowerCase()) {
    issues.push(issue("EDITORIAL_PLAN_DIGEST_MISMATCH", "編輯提要與 PresentationPlan 指向不同來源。", "請從同一份 Markdown 重新建立 brief 與 plan。"));
  }
  if (brief.requestedSlideCount !== undefined && plan.slides.length !== brief.requestedSlideCount) {
    issues.push(issue("EDITORIAL_SLIDE_COUNT_MISMATCH", `要求 ${brief.requestedSlideCount} 頁，但計畫有 ${plan.slides.length} 頁。`, "先調整整份計畫的頁數，再開始渲染；不能靠附圖頁偷偷增加頁數。"));
  }

  const planSlideIds = new Set(plan.slides.map((slide) => slide.id));
  const facts = new Map(brief.mustKeepFacts.map((fact) => [fact.id, fact]));
  const usedFacts = new Set<string>();
  const planAssetIds = new Set(plan.imageAssetIds);
  const usedAssets = new Set(plan.slides.flatMap((slide) => slide.imageIds));
  for (const asset of brief.assets) {
    if (!planAssetIds.has(asset.assetId)) issues.push(issue("EDITORIAL_ASSET_UNKNOWN", `編輯提要引用了不存在的圖片 ${asset.assetId}。`, "讓 assetId 與 imageAssetIds／assetManifest 完全一致。"));
    else if (!usedAssets.has(asset.assetId)) issues.push(issue("EDITORIAL_ASSET_UNPLACED", `圖片 ${asset.assetId} 沒有被任何投影片使用。`, "在指定頁面放入圖片，或在頁數規劃中明確安排附圖頁。"));
  }

  for (const fact of brief.mustKeepFacts) {
    if (!spanValid(fact.sourceSpan, lines.length)) {
      issues.push(issue("EDITORIAL_SOURCE_SPAN_OUT_OF_RANGE", `必留事實 ${fact.id} 的來源行範圍超出 Markdown。`, "修正 startLine/endLine，使其落在本次 Markdown 內。"));
    } else if (!spanText(lines, fact.sourceSpan).includes(fact.verbatim)) {
      issues.push(issue("EDITORIAL_VERBATIM_NOT_FOUND", `必留事實 ${fact.id} 的 verbatim 不在指定來源範圍內。`, "保留來源中的原數字、單位與限定條件，重新指定摘錄範圍。"));
    }
  }

  for (const editorialSlide of brief.slides) {
    const slide = plan.slides.find((candidate) => candidate.id === editorialSlide.slideId);
    if (!slide) {
      issues.push(issue("EDITORIAL_SLIDE_UNKNOWN", `編輯提要引用了不存在的 slideId：${editorialSlide.slideId}。`, "讓 brief.slides 與 PresentationPlan.slides 使用相同的穩定 ID。"));
      continue;
    }
    for (const sourceSpan of editorialSlide.evidence) {
      if (!spanValid(sourceSpan, lines.length)) issues.push(issue("EDITORIAL_EVIDENCE_OUT_OF_RANGE", `投影片 ${slide.id} 的證據行範圍超出 Markdown。`, "修正證據範圍或刪除不存在的引用。", slide.id));
    }
    for (const factId of editorialSlide.factIds) {
      if (!facts.has(factId)) issues.push(issue("EDITORIAL_FACT_UNKNOWN", `投影片 ${slide.id} 引用了不存在的必留事實 ${factId}。`, "先在 mustKeepFacts 宣告事實，再建立頁面映射。", slide.id));
      else usedFacts.add(factId);
    }
    if (!focusMatches(slide, editorialSlide.focus)) issues.push(issue("EDITORIAL_FOCUS_MISMATCH", `投影片 ${slide.id} 的 focus 與實際版型或物件不相容。`, "只引用這一頁已存在的文字區塊、圖片、圖表、表格或流程圖。", slide.id));
    if (editorialSlide.chartContext && slide.layout !== "chart") issues.push(issue("EDITORIAL_CHART_CONTEXT_MISMATCH", `投影片 ${slide.id} 提供了 chartContext，但不是圖表頁。`, "移除 chartContext 或把頁面改成 chart 版型。", slide.id));
  }
  for (const fact of brief.mustKeepFacts) {
    if (fact.placement === "slide" && !usedFacts.has(fact.id)) issues.push(issue("EDITORIAL_FACT_UNPLACED", `必須出現在畫面的事實 ${fact.id} 沒有映射到任何投影片。`, "把 factId 放進對應投影片，不能只放在 speaker notes。"));
  }
  return issues;
}
