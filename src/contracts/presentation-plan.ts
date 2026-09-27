import { z } from "zod";

const MAX_SLIDES = 60;
const MAX_IMAGES = 30;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const nonEmpty = z.string().trim().min(1);
const digestSchema = z.string().regex(SHA256_PATTERN, "Expected a 64-character SHA-256 digest");
const idSchema = nonEmpty.max(120, "IDs must be at most 120 characters");
const slideTitleSchema = nonEmpty.max(160, "Slide titles must be at most 160 characters");
const textBlockSchema = z.object({
  id: idSchema,
  text: nonEmpty,
}).strict();

const DIAGRAM_PLACEHOLDER_PATTERN = /^(?:\.\.\.|…|tbd|todo|待補|placeholder)$/iu;

export function isDiagramPlaceholderLabel(value: string): boolean {
  return DIAGRAM_PLACEHOLDER_PATTERN.test(value.trim());
}

const imageIdListSchema = z.array(idSchema).max(MAX_IMAGES).superRefine((ids, ctx) => {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      ctx.addIssue({ code: "custom", path: [index], message: `Duplicate image ID: ${id}` });
    }
    seen.add(id);
  });
});

const baseSlideShape = {
  id: idSchema,
  title: slideTitleSchema,
  subtitle: nonEmpty.max(240).optional(),
  imageIds: imageIdListSchema,
  sourceRefs: z.array(nonEmpty.max(500)).max(50).optional(),
};

const optionalBlocks = z.array(textBlockSchema).max(12).optional();
const commonSlide = z.object(baseSlideShape).strict();

const tableDataSchema = z.object({
  columns: z.array(nonEmpty.max(120)).min(1).max(12),
  rows: z.array(z.array(nonEmpty.max(500)).min(1).max(12)).min(1).max(100),
}).strict().superRefine((table, ctx) => {
  table.rows.forEach((row, rowIndex) => {
    if (row.length !== table.columns.length) {
      ctx.addIssue({
        code: "custom",
        path: ["rows", rowIndex],
        message: `Row ${rowIndex + 1} has ${row.length} cells; expected ${table.columns.length}`,
      });
    }
  });
});

const chartDataSchema = z.object({
  kind: z.enum(["bar", "line", "pie"]),
  labels: z.array(nonEmpty.max(120)).min(1).max(20),
  series: z.array(z.object({
    name: nonEmpty.max(120),
    values: z.array(z.number().finite()).min(1).max(20),
  }).strict()).min(1).max(5),
}).strict().superRefine((chart, ctx) => {
  chart.series.forEach((series, seriesIndex) => {
    if (series.values.length !== chart.labels.length) {
      ctx.addIssue({
        code: "custom",
        path: ["series", seriesIndex, "values"],
        message: `Series has ${series.values.length} values; expected ${chart.labels.length}`,
      });
    }
    if (chart.kind === "pie" && series.values.some((value) => value < 0)) {
      ctx.addIssue({ code: "custom", path: ["series", seriesIndex, "values"], message: "Pie chart values cannot be negative" });
    }
  });
  if (chart.kind === "pie" && chart.series.length !== 1) {
    ctx.addIssue({ code: "custom", path: ["series"], message: "Pie charts require exactly one series" });
  }
});

const diagramDataSchema = z.object({
  nodes: z.array(z.object({ id: idSchema, label: nonEmpty.max(160) }).strict()).min(2).max(30),
  edges: z.array(z.object({ from: idSchema, to: idSchema, label: nonEmpty.max(120).optional() }).strict()).min(1).max(60),
}).strict().superRefine((diagram, ctx) => {
  const nodeIds = new Set<string>();
  diagram.nodes.forEach((node, index) => {
    if (isDiagramPlaceholderLabel(node.label)) {
      ctx.addIssue({
        code: "custom",
        path: ["nodes", index, "label"],
        message: "Diagram node labels must carry source meaning; replace the placeholder with a concise semantic label.",
      });
    }
    if (nodeIds.has(node.id)) {
      ctx.addIssue({ code: "custom", path: ["nodes", index, "id"], message: `Duplicate diagram node ID: ${node.id}` });
    }
    nodeIds.add(node.id);
  });
  diagram.edges.forEach((edge, index) => {
    if (edge.label !== undefined && isDiagramPlaceholderLabel(edge.label)) {
      ctx.addIssue({
        code: "custom",
        path: ["edges", index, "label"],
        message: "Diagram edge labels must carry source meaning; replace the placeholder with a concise semantic label.",
      });
    }
    if (!nodeIds.has(edge.from)) {
      ctx.addIssue({ code: "custom", path: ["edges", index, "from"], message: `Unknown diagram node: ${edge.from}` });
    }
    if (!nodeIds.has(edge.to)) {
      ctx.addIssue({ code: "custom", path: ["edges", index, "to"], message: `Unknown diagram node: ${edge.to}` });
    }
  });
});

const comparisonColumnSchema = z.object({
  id: idSchema,
  title: nonEmpty.max(120),
  blocks: z.array(textBlockSchema).min(1).max(5),
}).strict();

const slideSchema = z.discriminatedUnion("layout", [
  commonSlide.extend({
    layout: z.literal("cover"),
    blocks: optionalBlocks,
  }).strict(),
  commonSlide.extend({
    layout: z.literal("section"),
    blocks: optionalBlocks,
  }).strict(),
  commonSlide.extend({
    layout: z.literal("takeaway"),
    blocks: z.array(textBlockSchema).length(1),
  }).strict(),
  commonSlide.extend({
    layout: z.literal("bullets"),
    blocks: z.array(textBlockSchema).min(3).max(5),
  }).strict(),
  commonSlide.extend({
    layout: z.literal("image-text"),
    blocks: z.array(textBlockSchema).min(1).max(8),
    imageIds: imageIdListSchema.min(1),
  }).strict(),
  commonSlide.extend({
    layout: z.literal("comparison"),
    columns: z.array(comparisonColumnSchema).length(2),
  }).strict(),
  commonSlide.extend({
    layout: z.literal("image"),
    blocks: optionalBlocks,
    imageIds: imageIdListSchema.min(1),
  }).strict(),
  commonSlide.extend({
    layout: z.literal("chart"),
    blocks: optionalBlocks,
    chart: chartDataSchema,
  }).strict(),
  commonSlide.extend({
    layout: z.literal("table"),
    blocks: optionalBlocks,
    table: tableDataSchema,
  }).strict(),
  commonSlide.extend({
    layout: z.literal("diagram"),
    blocks: optionalBlocks,
    diagram: diagramDataSchema,
  }).strict(),
  commonSlide.extend({
    layout: z.literal("closing"),
    blocks: optionalBlocks,
  }).strict(),
]).superRefine((slide, ctx) => {
  if (slide.imageIds.length > 0 && slide.layout !== "image" && slide.layout !== "image-text") {
    ctx.addIssue({
      code: "custom",
      path: ["imageIds"],
      message: "Images can only be placed on image or image-text slides.",
    });
  }
  if (slide.subtitle !== undefined && slide.layout !== "cover") {
    ctx.addIssue({
      code: "custom",
      path: ["subtitle"],
      message: "Subtitles can only be placed on cover slides.",
    });
  }
  if (slide.layout === "diagram" && slide.blocks?.length) {
    ctx.addIssue({
      code: "custom",
      path: ["blocks"],
      message: "Diagram slides do not support supplemental text blocks.",
    });
  }

  const isStructuralLayout = slide.layout === "cover" || slide.layout === "section" || slide.layout === "closing";
  const hasSourceDerivedText = Boolean(slide.subtitle)
    || ("blocks" in slide && Boolean(slide.blocks?.length));
  const requiresSourceRefs = !isStructuralLayout || hasSourceDerivedText;

  if (requiresSourceRefs && !slide.sourceRefs?.length) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceRefs"],
      message: "MISSING_SOURCE_REF: Source-derived slide content requires at least one source section or location.",
    });
  }
});

const assetSchema = z.object({
  assetId: idSchema,
  fileName: nonEmpty.max(255).refine((name) => !/[\\/\0]/.test(name) && name !== "." && name !== "..", "Asset names must be plain file names"),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  byteLength: z.number().int().positive().max(MAX_IMAGE_BYTES),
  sha256: digestSchema,
}).strict();

const uniqueList = (values: string[]): boolean => new Set(values).size === values.length;

export const PresentationPlanSchema = z.object({
  version: z.literal(1),
  title: nonEmpty.max(160),
  language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "Expected a language tag such as zh-TW"),
  themeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  sourceDigest: digestSchema,
  slides: z.array(slideSchema).min(1).max(MAX_SLIDES),
  imageAssetIds: z.array(idSchema).max(MAX_IMAGES),
  assetManifest: z.array(assetSchema).max(MAX_IMAGES),
}).strict().superRefine((plan, ctx) => {
  const slideIds = plan.slides.map((slide) => slide.id);
  if (!uniqueList(slideIds)) {
    const seen = new Set<string>();
    plan.slides.forEach((slide, index) => {
      if (seen.has(slide.id)) {
        ctx.addIssue({ code: "custom", path: ["slides", index, "id"], message: `Duplicate slide ID: ${slide.id}` });
      }
      seen.add(slide.id);
    });
  }

  const assetIds = plan.assetManifest.map((asset) => asset.assetId);
  if (!uniqueList(assetIds)) {
    ctx.addIssue({ code: "custom", path: ["assetManifest"], message: "Asset IDs must be unique" });
  }
  if (!uniqueList(plan.imageAssetIds)) {
    ctx.addIssue({ code: "custom", path: ["imageAssetIds"], message: "Image asset IDs must be unique" });
  }
  if (assetIds.length !== plan.imageAssetIds.length || assetIds.some((id) => !plan.imageAssetIds.includes(id))) {
    ctx.addIssue({ code: "custom", path: ["assetManifest"], message: "Asset manifest IDs must match imageAssetIds" });
  }

  const declaredAssets = new Set(plan.imageAssetIds);
  plan.slides.forEach((slide, slideIndex) => {
    slide.imageIds.forEach((imageId, imageIndex) => {
      if (!declaredAssets.has(imageId)) {
        ctx.addIssue({
          code: "custom",
          path: ["slides", slideIndex, "imageIds", imageIndex],
          message: `Image ID is not declared in imageAssetIds: ${imageId}`,
        });
      }
    });

    const objectIds = collectSlideObjectIds(slide);
    const seen = new Set<string>();
    objectIds.forEach(({ id, path }) => {
      if (seen.has(id)) {
        ctx.addIssue({ code: "custom", path: ["slides", slideIndex, ...path], message: `Duplicate object ID in slide: ${id}` });
      }
      seen.add(id);
    });
  });
});

export type PresentationPlan = z.infer<typeof PresentationPlanSchema>;
export type SlidePlan = PresentationPlan["slides"][number];
export type LayoutId = SlidePlan["layout"];
export type TextBlock = z.infer<typeof textBlockSchema>;
export type TableData = z.infer<typeof tableDataSchema>;
export type ChartData = z.infer<typeof chartDataSchema>;
export type DiagramData = z.infer<typeof diagramDataSchema>;
export type ComparisonColumn = z.infer<typeof comparisonColumnSchema>;
export type AssetManifestEntry = z.infer<typeof assetSchema>;

export type ValidationIssueCode =
  | "MISSING_IMAGE_ID"
  | "MISSING_SOURCE_REF"
  | "UNUSED_IMAGE_ID"
  | "DUPLICATE_OBJECT_ID"
  | "EMPTY_SLIDE"
  | "TABLE_COLUMN_MISMATCH"
  | "INVALID_PLAN";

export interface ValidationIssue {
  code: ValidationIssueCode;
  severity: "error" | "warning";
  message: string;
  slideId?: string;
  objectId?: string;
  imageId?: string;
  path?: string;
}

interface ObjectIdRef {
  id: string;
  path: (string | number)[];
}

function collectSlideObjectIds(slide: SlidePlan): ObjectIdRef[] {
  const ids: ObjectIdRef[] = [];
  if ("blocks" in slide && slide.blocks) {
    slide.blocks.forEach((block, index) => ids.push({ id: block.id, path: ["blocks", index, "id"] }));
  }
  if (slide.layout === "comparison") {
    slide.columns.forEach((column, columnIndex) => {
      ids.push({ id: column.id, path: ["columns", columnIndex, "id"] });
      column.blocks.forEach((block, blockIndex) => ids.push({ id: block.id, path: ["columns", columnIndex, "blocks", blockIndex, "id"] }));
    });
  }
  if (slide.layout === "diagram") {
    slide.diagram.nodes.forEach((node, nodeIndex) => ids.push({ id: node.id, path: ["diagram", "nodes", nodeIndex, "id"] }));
  }
  return ids;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function rawSlideHasReadableBody(slide: Record<string, unknown>): boolean {
  const layout = slide.layout;
  if (layout === "cover" || layout === "section" || layout === "closing") return true;
  const blocks = Array.isArray(slide.blocks) ? slide.blocks : [];
  const imageIds = stringArray(slide.imageIds);
  if (layout === "takeaway" || layout === "bullets") return blocks.length > 0;
  if (layout === "image-text") return blocks.length > 0 || imageIds.length > 0;
  if (layout === "comparison") return Array.isArray(slide.columns) && slide.columns.length > 0;
  if (layout === "image") return imageIds.length > 0;
  if (layout === "chart") {
    const chart = asRecord(slide.chart);
    return Boolean(chart && (stringArray(chart.labels).length > 0 || (Array.isArray(chart.series) && chart.series.length > 0)));
  }
  if (layout === "table") {
    const table = asRecord(slide.table);
    return Boolean(table && (Array.isArray(table.columns) && table.columns.length > 0 || Array.isArray(table.rows) && table.rows.length > 0));
  }
  if (layout === "diagram") {
    const diagram = asRecord(slide.diagram);
    return Boolean(diagram && (Array.isArray(diagram.nodes) && diagram.nodes.length > 0 || Array.isArray(diagram.edges) && diagram.edges.length > 0));
  }
  return false;
}

function pathString(path: PropertyKey[]): string {
  return path.map((segment) => typeof segment === "symbol" ? segment.description ?? String(segment) : String(segment)).join(".");
}

function isRequiredBodyField(layout: unknown, field: unknown): boolean {
  const fields: Record<string, string[]> = {
    takeaway: ["blocks"],
    bullets: ["blocks"],
    "image-text": ["blocks", "imageIds"],
    comparison: ["columns"],
    image: ["imageIds"],
    chart: ["chart"],
    table: ["table"],
    diagram: ["diagram"],
  };
  return typeof layout === "string" && typeof field === "string" && (fields[layout]?.includes(field) ?? false);
}

function rawSlideHasRequiredBodyFieldValue(slide: Record<string, unknown>, field: string): boolean {
  const value = slide[field];
  if (Array.isArray(value)) return value.length > 0;
  if (field === "chart") {
    const chart = asRecord(value);
    return Boolean(chart && (stringArray(chart.labels).length > 0 || (Array.isArray(chart.series) && chart.series.length > 0)));
  }
  if (field === "table") {
    const table = asRecord(value);
    return Boolean(table && (Array.isArray(table.columns) && table.columns.length > 0 || Array.isArray(table.rows) && table.rows.length > 0));
  }
  if (field === "diagram") {
    const diagram = asRecord(value);
    return Boolean(diagram && (Array.isArray(diagram.nodes) && diagram.nodes.length > 0 || Array.isArray(diagram.edges) && diagram.edges.length > 0));
  }
  return value !== undefined && value !== null;
}

function mapSchemaIssue(issue: z.ZodIssue, input: unknown): ValidationIssue {
  const isSlidePath = issue.path[0] === "slides" && typeof issue.path[1] === "number";
  const slideIndex = isSlidePath ? issue.path[1] as number : undefined;
  const rawRoot = asRecord(input);
  const rawSlides = rawRoot && Array.isArray(rawRoot.slides) ? rawRoot.slides : [];
  const rawSlide = slideIndex === undefined ? undefined : asRecord(rawSlides[slideIndex]);
  const slideId = rawSlide ? stringValue(rawSlide.id) : undefined;
  const path = pathString(issue.path);
  const duplicateId = /^(?:Duplicate object ID in slide|Duplicate diagram node ID):\s*(.+)$/.exec(issue.message);

  if (duplicateId) {
    return {
      code: "DUPLICATE_OBJECT_ID",
      severity: "error",
      message: issue.message,
      ...(slideId ? { slideId } : {}),
      objectId: duplicateId[1],
      path,
    };
  }
  if (issue.path.includes("table") && /cells; expected\s+\d+/.test(issue.message)) {
    return {
      code: "TABLE_COLUMN_MISMATCH",
      severity: "error",
      message: issue.message,
      ...(slideId ? { slideId } : {}),
      path,
    };
  }
  if (issue.message.startsWith("MISSING_SOURCE_REF:")) {
    return {
      code: "MISSING_SOURCE_REF",
      severity: "error",
      message: issue.message.replace(/^MISSING_SOURCE_REF:\s*/, ""),
      ...(slideId ? { slideId } : {}),
      path,
    };
  }
  if (rawSlide && issue.path.includes("sourceRefs")) {
    const refs = Array.isArray(rawSlide.sourceRefs) ? rawSlide.sourceRefs : [];
    const hasUsableRef = refs.some((ref) => typeof ref === "string" && ref.trim().length > 0);
    if (!hasUsableRef) {
      return {
        code: "MISSING_SOURCE_REF",
        severity: "error",
        message: "Source-derived slide content requires at least one non-empty source section or location.",
        ...(slideId ? { slideId } : {}),
        path,
      };
    }
  }
  if (
    rawSlide
    && !rawSlideHasReadableBody(rawSlide)
    && isRequiredBodyField(rawSlide.layout, issue.path[2])
    && !rawSlideHasRequiredBodyFieldValue(rawSlide, issue.path[2] as string)
  ) {
    return {
      code: "EMPTY_SLIDE",
      severity: "error",
      message: `Slide${slideId ? ` "${slideId}"` : ""} has no readable body content.`,
      ...(slideId ? { slideId } : {}),
      path,
    };
  }
  return {
    code: "INVALID_PLAN",
    severity: "error",
    message: issue.message,
    ...(slideId ? { slideId } : {}),
    path,
  };
}

function collectImageIssues(input: unknown, availableImageAssetIds: string[]): ValidationIssue[] {
  const root = asRecord(input);
  const rawSlides = root && Array.isArray(root.slides) ? root.slides : [];
  const slides = rawSlides.flatMap((value) => {
    const slide = asRecord(value);
    return slide ? [{ slideId: stringValue(slide.id), imageIds: stringArray(slide.imageIds) }] : [];
  });
  const declaredImageIds = stringArray(root?.imageAssetIds);
  const available = new Set(availableImageAssetIds);
  const referenced = new Set<string>();
  const missing = new Set<string>();
  const issues: ValidationIssue[] = [];

  for (const slide of slides) {
    for (const imageId of slide.imageIds) {
      referenced.add(imageId);
      if (!available.has(imageId)) {
        missing.add(imageId);
        issues.push({
          code: "MISSING_IMAGE_ID",
          severity: "error",
          ...(slide.slideId ? { slideId: slide.slideId } : {}),
          imageId,
          message: `Slide${slide.slideId ? ` "${slide.slideId}"` : ""} refers to image "${imageId}", which is not available.`,
        });
      }
    }
  }

  for (const imageId of declaredImageIds) {
    if (!available.has(imageId) && !missing.has(imageId)) {
      issues.push({ code: "MISSING_IMAGE_ID", severity: "error", imageId, message: `Declared image "${imageId}" was not received.` });
    }
  }
  for (const imageId of new Set(availableImageAssetIds)) {
    if (!referenced.has(imageId)) {
      issues.push({ code: "UNUSED_IMAGE_ID", severity: "warning", imageId, message: `Received image "${imageId}" is not placed in a slide and should be added to an appendix.` });
    }
  }

  return issues;
}

function collectEmptySlideIssues(input: unknown): ValidationIssue[] {
  const root = asRecord(input);
  const rawSlides = root && Array.isArray(root.slides) ? root.slides : [];
  const issues: ValidationIssue[] = [];
  rawSlides.forEach((value) => {
    const slide = asRecord(value);
    if (!slide || rawSlideHasReadableBody(slide)) return;
    const slideId = stringValue(slide.id);
    issues.push({
      code: "EMPTY_SLIDE",
      severity: "error",
      ...(slideId ? { slideId } : {}),
      message: `Slide${slideId ? ` "${slideId}"` : ""} has no readable body content.`,
    });
  });
  return issues;
}

function deduplicateIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issue.code === "EMPTY_SLIDE"
      ? [issue.code, issue.slideId ?? ""].join("|")
      : [issue.code, issue.slideId ?? "", issue.objectId ?? "", issue.imageId ?? "", issue.path ?? "", issue.message].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validatePresentationPlan(
  input: unknown,
  availableImageAssetIds: string[],
): ValidationIssue[] {
  const parsed = PresentationPlanSchema.safeParse(input);
  const issues = parsed.success ? [] : parsed.error.issues.map((issue) => mapSchemaIssue(issue, input));
  if (!parsed.success) issues.push(...collectEmptySlideIssues(input));
  issues.push(...collectImageIssues(input, availableImageAssetIds));
  return deduplicateIssues(issues);
}
