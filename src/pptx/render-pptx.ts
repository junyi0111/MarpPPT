import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import pptxgen from "pptxgenjs";
import { UnsupportedMathError } from "../content/math-text.js";
import {
  PresentationPlanSchema,
  validatePresentationPlan,
  type PresentationPlan,
  type ValidationIssue,
} from "../contracts/presentation-plan.js";
import { buildSlideLayout, type LayoutObject } from "../layout/build-slide.js";
import { getCanvas, type Theme } from "../layout/geometry.js";
import { findOverflow, type LayoutIssue } from "../layout/overflow.js";
import { addLayoutObject, type LayoutObjectContext, type PptxApi, type PptxSlideApi, type ResolvedPptxAsset } from "./add-layout-object.js";
import { repairPptxGenJsCompatibility } from "./pptxgenjs-compat.js";
import { assertOfficeText } from "./office-xml.js";
import { renderMathImage } from "./render-math-image.js";
import { PptxValidationError, validatePptx } from "./validate-pptx.js";

export type { ResolvedPptxAsset } from "./add-layout-object.js";
export { PptxValidationError } from "./validate-pptx.js";

export type PptxRenderErrorCode = "PPTX_LAYOUT_INVALID" | "PLAN_INVALID" | "THEME_MISMATCH" | "PPTX_ASSET_MISSING" | "PPTX_ASSET_INVALID" | "MATH_RENDER_FAILED" | "PPTX_INVALID";

export class PptxRenderError extends Error {
  constructor(
    message: string,
    readonly code: PptxRenderErrorCode,
    options: { assetId?: string; slideId?: string; partName?: string; issues?: Array<LayoutIssue | ValidationIssue> } = {},
  ) {
    super(message);
    this.name = "PptxRenderError";
    this.assetId = options.assetId;
    this.slideId = options.slideId;
    this.partName = options.partName;
    this.issues = options.issues;
  }

  readonly assetId?: string;
  readonly slideId?: string;
  readonly partName?: string;
  readonly issues?: Array<LayoutIssue | ValidationIssue>;
}

export interface PptxInspection {
  slideCount: number;
  textShapeCount: number;
  pictureCount: number;
  tableCount: number;
  chartCount: number;
  fullSlidePictureCount: number;
  slideBoundsValid: boolean;
  shapeCount: number;
  graphicFrameCount: number;
  embeddedMediaCount: number;
  contentTypeOverrideCount: number;
  contentTypeOverridesValid: boolean;
  relationshipsValid: boolean;
}

const CANVAS_WIDTH = 13.333;
const CANVAS_HEIGHT = 7.5;
const MAX_RENDERED_IMAGE_BYTES = 50 * 1024 * 1024;

interface PptxDocument extends PptxApi {
  defineLayout(layout: { name: string; width: number; height: number }): void;
  addSlide(): PptxSlideApi;
  write(options: { outputType: "uint8array" }): Promise<string | ArrayBuffer | Uint8Array>;
  layout: string;
  title: string;
  author: string;
  theme: { headFontFace: string; bodyFontFace: string };
}

function createPptx(): PptxDocument {
  // PptxGenJS 4's ESM runtime is constructable, but its published NodeNext type is a namespace.
  // @ts-expect-error upstream ESM declaration mismatch
  const instance = new pptxgen();
  return instance as unknown as PptxDocument;
}

function fontFace(theme: Theme): string {
  const families = theme.typography.fontFace.split(",").map((family) => family.trim()).filter(Boolean);
  return families.find((family) => family.toLowerCase() === "noto sans cjk tc") ?? families[0] ?? "Noto Sans CJK TC";
}

function planIssues(plan: unknown, assetIds: string[]): ValidationIssue[] {
  return validatePresentationPlan(plan, assetIds).filter((issue) => issue.severity === "error");
}

function layoutsForPlan(plan: PresentationPlan, theme: Theme): Array<{ objects: LayoutObject[]; issues: LayoutIssue[] }> {
  const canvas = getCanvas(theme);
  return plan.slides.map((slide) => {
    let objects: LayoutObject[];
    try {
      objects = buildSlideLayout(slide, theme);
    } catch (error) {
      if (error instanceof UnsupportedMathError) {
        throw new PptxRenderError(`Slide ${slide.id}: ${error.message}`, "MATH_RENDER_FAILED", { slideId: slide.id });
      }
      throw error;
    }
    return { objects, issues: findOverflow(objects, canvas) };
  });
}

function hasValidSignature(bytes: Uint8Array, mimeType: ResolvedPptxAsset["mimeType"]): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function validateResolvedAssets(plan: PresentationPlan, assets: ResolvedPptxAsset[]): Promise<Map<string, ResolvedPptxAsset>> {
  if (!Array.isArray(assets) || assets.length !== plan.assetManifest.length) {
    throw new PptxRenderError("Resolved image assets do not match the presentation manifest.", "PPTX_ASSET_INVALID");
  }
  const manifestById = new Map(plan.assetManifest.map((asset) => [asset.assetId, asset]));
  const byId = new Map<string, ResolvedPptxAsset>();
  let totalBytes = 0;
  for (const asset of assets) {
    if (!asset || typeof asset !== "object" || typeof asset.assetId !== "string" || typeof asset.sha256 !== "string") {
      throw new PptxRenderError("Resolved image asset metadata is malformed.", "PPTX_ASSET_INVALID");
    }
    const manifest = manifestById.get(asset.assetId);
    if (!manifest || byId.has(asset.assetId)) {
      throw new PptxRenderError("Resolved image asset IDs are missing, extra, or duplicated.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
    }
    if (asset.fileName !== manifest.fileName || asset.mimeType !== manifest.mimeType
        || asset.byteLength !== manifest.byteLength || asset.sha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
      throw new PptxRenderError("Resolved image metadata differs from the canonical asset manifest.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
    }
    if (typeof asset.path !== "string" || !isAbsolute(asset.path) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(asset.path)) {
      throw new PptxRenderError("Only absolute local paths returned by the authorized attachment resolver can be rendered.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
    }
    let stat;
    let content: Buffer;
    try {
      stat = await lstat(asset.path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new PptxRenderError("Resolved image path is not a regular file.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
      }
      content = await readFile(asset.path);
    } catch (error) {
      if (error instanceof PptxRenderError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PptxRenderError("Resolved image file is missing.", "PPTX_ASSET_MISSING", { assetId: asset.assetId });
      }
      throw new PptxRenderError("Resolved image file cannot be read.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
    }
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== manifest.byteLength || digest !== manifest.sha256.toLowerCase()
        || !hasValidSignature(content, manifest.mimeType)) {
      throw new PptxRenderError("Resolved image bytes do not match the validated image manifest.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_RENDERED_IMAGE_BYTES) {
      throw new PptxRenderError("Resolved image assets exceed the 50 MiB package limit.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
    }
    byId.set(asset.assetId, asset);
  }
  return byId;
}

export async function renderPptx(plan: PresentationPlan, assets: ResolvedPptxAsset[], theme: Theme): Promise<Uint8Array> {
  if (!Array.isArray(assets)) {
    throw new PptxRenderError("Resolved image assets must be supplied by the attachment resolver.", "PPTX_ASSET_INVALID");
  }
  const parsed = PresentationPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new PptxRenderError("Presentation plan failed contract validation.", "PLAN_INVALID", {
      issues: planIssues(plan, assets.flatMap((asset) => asset && typeof asset.assetId === "string" ? [asset.assetId] : [])),
    });
  }
  const checkedPlan = parsed.data;
  if (checkedPlan.themeId !== theme.id) {
    throw new PptxRenderError("Presentation plan theme does not match the selected theme.", "THEME_MISMATCH");
  }
  if (assets.some((asset) => !asset || typeof asset !== "object")) {
    throw new PptxRenderError("Resolved image asset metadata is malformed.", "PPTX_ASSET_INVALID");
  }
  if (theme.canvas.width !== CANVAS_WIDTH || theme.canvas.height !== CANVAS_HEIGHT) {
    throw new PptxRenderError("PowerPoint export requires the fixed 13.333 × 7.5 in canvas.", "PPTX_LAYOUT_INVALID", {
      issues: [{
        code: "LAYOUT_OVERFLOW",
        slideId: "theme",
        objectId: "theme:canvas",
        message: "Theme canvas dimensions must be exactly 13.333 × 7.5 in.",
        actionable: true,
      }],
    });
  }
  const validationIssues = validatePresentationPlan(checkedPlan, assets.map((asset) => asset.assetId));
  const issues = validationIssues.filter((issue) => issue.severity === "error");
  if (issues.length > 0) {
    throw new PptxRenderError("Presentation plan references invalid or unavailable image assets.", "PLAN_INVALID", { issues });
  }
  const unusedImages = validationIssues.filter((issue) => issue.code === "UNUSED_IMAGE_ID");
  if (unusedImages.length > 0) {
    throw new PptxRenderError("Every received image must be placed on a planned slide or appendix before export.", "PLAN_INVALID", {
      issues: unusedImages,
    });
  }

  // Validate before UTF-8 encoding: an unpaired surrogate otherwise becomes U+FFFD.
  const checkText = (value: unknown, field: string): void => {
    if (typeof value === "string") assertOfficeText(value, field);
    else if (Array.isArray(value)) value.forEach((item, i) => checkText(item, `${field}[${i}]`));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => checkText(item, `${field}.${key}`));
  };
  try { checkText(checkedPlan, "plan"); assertOfficeText(fontFace(theme), "theme.fontFace"); }
  catch (error) {
    if (error instanceof PptxValidationError) throw new PptxRenderError(error.message, "PPTX_INVALID", { partName: error.partName });
    throw error;
  }

  const layouts = layoutsForPlan(checkedPlan, theme);
  const layoutIssues = layouts.flatMap((layout) => layout.issues);
  if (layoutIssues.length > 0) {
    throw new PptxRenderError("PowerPoint export is blocked until every layout issue is resolved.", "PPTX_LAYOUT_INVALID", { issues: layoutIssues });
  }

  const resolvedAssets = await validateResolvedAssets(checkedPlan, assets);
  const mathImages = new Map<string, Awaited<ReturnType<typeof renderMathImage>>>();
  for (const layout of layouts) {
    for (const object of layout.objects) {
      if (object.kind !== "math") continue;
      try {
        mathImages.set(object.id, await renderMathImage(object.latex, object.color));
      } catch (error) {
        throw new PptxRenderError(
          `Equation ${object.id} could not be typeset: ${error instanceof Error ? error.message : String(error)}`,
          "MATH_RENDER_FAILED",
          { slideId: object.slideId },
        );
      }
    }
  }
  const selectedFont = fontFace(theme);
  const pptx = createPptx();
  const layoutName = "MARPPPT_13_333x7_5";
  pptx.defineLayout({ name: layoutName, width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
  pptx.layout = layoutName;
  pptx.title = checkedPlan.title;
  pptx.author = "MarpPPT";
  pptx.theme = { headFontFace: selectedFont, bodyFontFace: selectedFont };

  for (const slideLayout of layouts) {
    const slide = pptx.addSlide();
    const context: LayoutObjectContext = {
      pptx,
      slide,
      assets: resolvedAssets,
      mathImages,
      theme,
    };
    slideLayout.objects.forEach((object) => addLayoutObject(object, context));
  }

  try {
    const generated = await pptx.write({ outputType: "uint8array" });
    const serialized = generated instanceof Uint8Array ? generated
      : generated instanceof ArrayBuffer ? new Uint8Array(generated)
        : undefined;
    if (!serialized) throw new Error("PptxGenJS returned a non-binary output");
    const bytes = repairPptxGenJsCompatibility(serialized);
    await validatePptx(bytes);
    return bytes;
  } catch (error) {
    if (error instanceof PptxRenderError) throw error;
    const message = error instanceof PptxValidationError ? error.message : "PPTX could not be serialized or validated.";
    throw new PptxRenderError(message, "PPTX_INVALID", { ...(error instanceof PptxValidationError && error.partName ? { partName: error.partName } : {}) });
  }
}

export async function inspectPptx(bytes: Uint8Array): Promise<PptxInspection> {
  return validatePptx(bytes);
}
