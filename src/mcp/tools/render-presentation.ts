import { createHash, randomUUID } from "node:crypto";
import { UnsupportedMathError } from "../../content/math-text.js";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import sharp from "sharp";
import { zipSync } from "fflate";
import { z } from "zod";
import {
  PresentationPlanSchema,
  validatePresentationPlan,
  type PresentationPlan,
} from "../../contracts/presentation-plan.js";
import { EditorialBriefSchema, checkEditorial } from "../../contracts/editorial-brief.js";
import {
  AttachmentResolverError,
  resolveAttachments,
  type AttachmentResolverDeps,
  type AttachmentReference,
  type ResolvedAttachments,
} from "../../attachments/attachment-resolver.js";
import { AttachmentValidationError } from "../../attachments/file-validation.js";
import { buildSlideLayout } from "../../layout/build-slide.js";
import { getCanvas, type Theme } from "../../layout/geometry.js";
import { findOverflow, type LayoutIssue } from "../../layout/overflow.js";
import type { ResolvedPptxAsset } from "../../pptx/add-layout-object.js";
import { inspectPptx, PptxRenderError, PptxValidationError, renderPptx, type PptxInspection } from "../../pptx/render-pptx.js";
import { serializeMarp } from "../../marp/serialize-marp.js";
import { renderPreview, type PreviewIssue, type PreviewReport } from "../../preview/render-preview.js";
import { ArtifactStoreError, MARP_BUNDLE_MIME, MARP_MIME, PPTX_MIME, PREVIEW_MIME, type ArtifactRef, type ArtifactStore } from "../../artifacts/artifact-store.js";

const MAX_SLIDES = 60;
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;
const SAFE_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u;

const probeFileRefSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  assetId: z.string().max(512).optional(),
}).strict();

const authorizedFileParamSchema = z.object({
  kind: z.literal("host-file"),
  fileId: z.string().min(1).max(512),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  downloadUrl: z.string().min(1).max(4096),
}).strict();

const attachmentReferenceSchema = z.union([probeFileRefSchema, authorizedFileParamSchema]);

export const RenderPresentationInputSchema = z.object({
  plan: PresentationPlanSchema,
  sourceFile: attachmentReferenceSchema,
  imageFiles: z.array(attachmentReferenceSchema).max(30),
  imageAssetIds: z.array(z.string().min(1).max(120)).max(30)
    .describe("Canonical safe presentation asset IDs in the same order as imageFiles. Keep staged ProbeFileRef.assetId values as resolver tokens; map staged images to the plan's asset IDs here."),
  themeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u).optional(),
  editorialBrief: EditorialBriefSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.imageAssetIds.length !== input.imageFiles.length) {
    ctx.addIssue({ code: "custom", path: ["imageAssetIds"], message: "One image asset ID is required per image attachment." });
  }
  const allIds = [...input.imageAssetIds, ...input.plan.imageAssetIds, ...input.plan.assetManifest.map((asset) => asset.assetId)];
  allIds.forEach((assetId, index) => {
    if (!SAFE_ASSET_ID.test(assetId)) {
      ctx.addIssue({ code: "custom", path: index < input.imageAssetIds.length ? ["imageAssetIds", index] : ["plan", "imageAssetIds"], message: "Image asset IDs must be safe filename tokens." });
    }
  });
  if (input.themeId && input.themeId !== input.plan.themeId) {
    ctx.addIssue({ code: "custom", path: ["themeId"], message: "Selected theme ID must match the validated presentation plan." });
  }
});

const artifactRefSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  uri: z.string().min(1),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict();

const layoutIssueSchema = z.object({
  code: z.enum(["LAYOUT_OVERFLOW", "SPLIT_REQUIRED", "SUMMARY_REQUIRED"]),
  slideId: z.string(),
  objectId: z.string(),
  message: z.string(),
  actionable: z.literal(true),
  overlapsWith: z.array(z.string()).optional(),
  relatedObjectId: z.string().optional(),
  lineCount: z.number().optional(),
  availableLines: z.number().optional(),
}).strict();

const previewIssueSchema = z.object({
  code: z.string(),
  stage: z.string(),
  message: z.string(),
}).strict();

const inspectionSchema = z.object({
  slideCount: z.number().int().nonnegative(),
  textShapeCount: z.number().int().nonnegative(),
  pictureCount: z.number().int().nonnegative(),
  tableCount: z.number().int().nonnegative(),
  chartCount: z.number().int().nonnegative(),
  fullSlidePictureCount: z.number().int().nonnegative(),
  slideBoundsValid: z.boolean(),
  shapeCount: z.number().int().nonnegative(),
  graphicFrameCount: z.number().int().nonnegative(),
  embeddedMediaCount: z.number().int().nonnegative(),
  contentTypeOverrideCount: z.number().int().nonnegative(),
  contentTypeOverridesValid: z.boolean(),
  relationshipsValid: z.boolean(),
}).strict();

const powerPointValidationSchema = z.object({
  status: z.literal("not_run"),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const completedOrDraftSchema = z.object({
  status: z.enum(["completed", "draft"]),
  deliveryStatus: z.literal("unverified"),
  jobId: z.string().uuid(),
  pptx: artifactRefSchema,
  marp: artifactRefSchema,
  marpBundle: artifactRefSchema.optional(),
  previews: z.array(artifactRefSchema),
  slideCount: z.number().int().min(1).max(MAX_SLIDES),
  imageUsage: z.array(z.object({
    assetId: z.string(),
    fileName: z.string(),
    slideIds: z.array(z.string()),
  }).strict()),
  warnings: z.array(z.string()),
  validation: z.object({
    pptx: inspectionSchema,
    powerPoint: powerPointValidationSchema,
    preview: z.object({
      status: z.enum(["ready", "draft"]),
      pageCount: z.number().int().nonnegative(),
      fontRequested: z.string(),
      fontSelected: z.string().nullable(),
      fontSubstituted: z.boolean(),
      issues: z.array(previewIssueSchema),
    }).strict(),
    visualQaPassed: z.literal(false),
  }).strict(),
}).strict().superRefine((output, ctx) => {
  if (output.imageUsage.length > 0 && !output.marpBundle) {
    ctx.addIssue({ code: "custom", path: ["marpBundle"], message: "A Marp bundle is required whenever image attachments are present." });
  }
  if (output.status === "completed") {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Completed delivery requires native PowerPoint save/close/reopen verification; a preview cannot attest this." });
  }
  if (output.validation.preview.status === "draft" && output.previews.length > 0) {
    ctx.addIssue({ code: "custom", path: ["previews"], message: "Failed preview validation cannot publish preview references." });
  }
  if (output.validation.preview.status === "ready" && output.previews.length !== output.slideCount) {
    ctx.addIssue({ code: "custom", path: ["previews"], message: "Ready preview requires one page per slide." });
  }
});

const failedSchema = z.object({
  status: z.literal("failed"),
  jobId: z.string().uuid(),
  failure: z.object({
    code: z.string(),
    stage: z.enum(["input", "attachments", "plan", "render", "verify", "publish"]),
    affectedFileOrSlide: z.string().optional(),
    message: z.string(),
    userAction: z.string().optional(),
    retryable: z.boolean(),
  }).strict(),
  warnings: z.array(z.string()),
  validation: z.object({ issues: z.array(layoutIssueSchema) }).strict().optional(),
}).strict();

const successValidationSchema = z.object({
  pptx: inspectionSchema,
  powerPoint: powerPointValidationSchema,
  preview: z.object({
    status: z.enum(["ready", "draft"]),
    pageCount: z.number().int().nonnegative(),
    fontRequested: z.string(),
    fontSelected: z.string().nullable(),
    fontSubstituted: z.boolean(),
    issues: z.array(previewIssueSchema),
  }).strict(),
  visualQaPassed: z.literal(false),
}).strict();

const failureValidationSchema = z.object({ issues: z.array(layoutIssueSchema) }).strict();

/**
 * MCP's high-level SDK serializes output schemas only when the root is an
 * object. This flattened object schema retains the exact public fields and
 * validates the status-dependent shape with the refinement below.
 */
export const RenderPresentationOutputSchema = z.object({
  status: z.enum(["completed", "draft", "failed"]),
  deliveryStatus: z.literal("unverified").optional(),
  jobId: z.string().uuid(),
  pptx: artifactRefSchema.optional(),
  marp: artifactRefSchema.optional(),
  marpBundle: artifactRefSchema.optional(),
  previews: z.array(artifactRefSchema).optional(),
  slideCount: z.number().int().min(1).max(MAX_SLIDES).optional(),
  imageUsage: z.array(z.object({ assetId: z.string(), fileName: z.string(), slideIds: z.array(z.string()) }).strict()).optional(),
  warnings: z.array(z.string()),
  validation: z.union([successValidationSchema, failureValidationSchema]).optional(),
  failure: failedSchema.shape.failure.optional(),
}).strict().superRefine((output, ctx) => {
  if (output.status === "failed") {
    if (!output.failure) ctx.addIssue({ code: "custom", path: ["failure"], message: "Failed output requires a typed failure." });
    if (output.deliveryStatus || output.pptx || output.marp || output.marpBundle || output.previews?.length || output.slideCount !== undefined || output.imageUsage) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "Failed output cannot include successful artifact references." });
    }
    return;
  }
  if (output.deliveryStatus !== "unverified" || output.failure || !output.pptx || !output.marp || !output.previews || output.slideCount === undefined || !output.imageUsage || !output.validation || !("pptx" in output.validation)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Completed or draft output requires verified artifact and validation fields." });
    return;
  }
  if (output.imageUsage.length > 0 && !output.marpBundle) {
    ctx.addIssue({ code: "custom", path: ["marpBundle"], message: "A Marp bundle is required whenever image attachments are present." });
  }
  if (output.status === "completed") {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Completed delivery requires native PowerPoint save/close/reopen verification; a preview cannot attest this." });
  }
  if (output.validation.preview.status === "draft" && output.previews.length > 0) {
    ctx.addIssue({ code: "custom", path: ["previews"], message: "Failed preview validation cannot publish preview references." });
  }
  if (output.validation.preview.status === "ready" && output.previews.length !== output.slideCount) {
    ctx.addIssue({ code: "custom", path: ["previews"], message: "Ready preview requires one page per slide." });
  }
});

export type RenderPresentationInput = z.infer<typeof RenderPresentationInputSchema>;
export type RenderPresentationOutput = z.infer<typeof completedOrDraftSchema> | z.infer<typeof failedSchema>;
export type PresentationFailure = z.infer<typeof failedSchema>;

export interface RenderFinalizedEvent {
  jobId: string;
  status: RenderPresentationOutput["status"];
  errorCode?: string;
  durationMs: number;
  cleanupOutcome: "succeeded" | "failed" | "not-needed";
}

export interface RenderPresentationDependencies {
  attachmentResolver: AttachmentResolverDeps;
  artifactStore: ArtifactStore;
  theme: Theme;
  themes?: ReadonlyMap<string, Theme>;
  preview?: typeof renderPreview;
  renderPptx?: typeof renderPptx;
  inspectPptx?: typeof inspectPptx;
  serializeMarp?: typeof serializeMarp;
  signal?: AbortSignal;
  previewProcessGroupId?: number;
  /** Internal structured telemetry. This callback never receives source content, refs, or paths. */
  onRenderFinalized?: (event: RenderFinalizedEvent) => void;
}

function failure(
  jobId: string,
  code: string,
  stage: PresentationFailure["failure"]["stage"],
  message: string,
  options: { affectedFileOrSlide?: string; userAction?: string; retryable?: boolean; issues?: LayoutIssue[] } = {},
): PresentationFailure {
  return {
    status: "failed",
    jobId,
    failure: {
      code,
      stage,
      ...(options.affectedFileOrSlide ? { affectedFileOrSlide: options.affectedFileOrSlide } : {}),
      message,
      ...(options.userAction ? { userAction: options.userAction } : {}),
      retryable: options.retryable ?? false,
    },
    warnings: [],
    ...(options.issues ? { validation: { issues: options.issues } } : {}),
  };
}

function safeSlug(title: string): string {
  const slug = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 72);
  return slug || "presentation";
}

function appendixTitle(fileName: string): string {
  const prefix = "附圖：";
  // Keep headroom for full-width CJK glyphs in the one-line title box.
  const maxTitleCodePoints = 22;
  const name = Array.from(fileName);
  const availableNamePoints = maxTitleCodePoints - Array.from(prefix).length;
  if (name.length <= availableNamePoints) return `${prefix}${fileName}`;
  return `${prefix}${name.slice(0, availableNamePoints - 1).join("")}…`;
}

function canonicalPlanWithAppendix(plan: PresentationPlan, images: ResolvedAttachments["images"], maxSlides = MAX_SLIDES): PresentationPlan {
  const referenced = new Set(plan.slides.flatMap((slide) => slide.imageIds));
  const unused = images.filter((image) => !referenced.has(image.assetId));
  if (plan.slides.length + unused.length > maxSlides) {
    throw new Error("PRESENTATION_LIMIT_EXCEEDED");
  }
  const slides = [...plan.slides];
  const usedSlideIds = new Set(slides.map((slide) => slide.id));
  unused.forEach((image, index) => {
    let id = `appendix-image-${index + 1}`;
    let suffix = 2;
    while (usedSlideIds.has(id)) id = `appendix-image-${index + 1}-${suffix++}`;
    usedSlideIds.add(id);
    const title = appendixTitle(image.fileName);
    slides.push({
      id,
      title,
      layout: "image",
      imageIds: [image.assetId],
      sourceRefs: ["對話附件"],
    });
  });
  return { ...plan, slides };
}

function layoutIssues(plan: PresentationPlan, theme: Theme): LayoutIssue[] {
  return plan.slides.flatMap((slide) => {
    try {
      return findOverflow(buildSlideLayout(slide, theme), getCanvas(theme));
    } catch (error) {
      if (error instanceof UnsupportedMathError) {
        throw new PptxRenderError(`Slide ${slide.id}: ${error.message}`, "MATH_RENDER_FAILED", { slideId: slide.id });
      }
      throw error;
    }
  });
}

function safeAttachmentError(error: unknown): { code: string; message: string; userAction: string; affected?: string } {
  if (error instanceof AttachmentValidationError) {
    if (error.code === "FILE_TOO_LARGE" || error.code === "TOTAL_TOO_LARGE" || error.code === "TOO_MANY_IMAGES") {
      return { code: "INPUT_LIMIT_EXCEEDED", message: "The attachment set exceeds a supported size or count limit.", userAction: error.recoveryMessage, ...(error.fileName ? { affected: error.fileName } : {}) };
    }
    return { code: "IMAGE_INVALID", message: "An attachment did not pass file validation.", userAction: error.recoveryMessage, ...(error.fileName ? { affected: error.fileName } : {}) };
  }
  if (error instanceof AttachmentResolverError) {
    if (error.code === "MISSING_IMAGE_ID") {
      return { code: "REFERENCE_MISSING", message: "A planned image attachment was not received.", userAction: error.recoveryMessage, ...(error.fileName ? { affected: error.fileName } : {}) };
    }
    const imageError = error.code.includes("IMAGE") || error.code === "ASSET_MANIFEST_MISMATCH";
    const limitError = error.code.includes("TOO_LARGE") || error.code === "DOWNLOAD_TOO_LARGE";
    return {
      code: limitError ? "INPUT_LIMIT_EXCEEDED" : imageError ? "IMAGE_INVALID" : "ATTACHMENT_UNREADABLE",
      message: error.code === "SOURCE_DIGEST_MISMATCH" ? "The presentation plan does not match the attached Markdown source." : "An attachment could not be safely read or verified.",
      userAction: error.recoveryMessage,
      ...(error.fileName ? { affected: error.fileName } : {}),
    };
  }
  return { code: "ATTACHMENT_UNREADABLE", message: "Attachments could not be resolved by the configured host adapter.", userAction: "Attach the source and images through an authorized host adapter, then retry." };
}

function layoutFailure(issue: LayoutIssue): string {
  return issue.code;
}

function summarizePreviewIssues(issues: PreviewIssue[]): Array<{ code: string; stage: string; message: string }> {
  return issues.map((issue) => ({ code: issue.code, stage: issue.stage, message: issue.message }));
}

function pathIsWithin(directory: string, target: string): boolean {
  const fromDirectory = relative(directory, target);
  return fromDirectory === "" || (!fromDirectory.startsWith(`..${sep}`) && fromDirectory !== ".." && !isAbsolute(fromDirectory));
}

async function writePptxInWorkspace(workspacePath: string, jobId: string, bytes: Uint8Array): Promise<string> {
  const path = join(workspacePath, `render-${jobId}.pptx`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

async function readPreviewPages(report: PreviewReport, workspacePath: string): Promise<Buffer[]> {
  if (report.status !== "ready" || report.pngPaths.length !== report.pageCount || report.pageCount !== report.slideCount) {
    throw new Error("PREVIEW_PAGE_COUNT_MISMATCH");
  }
  const realWorkspace = await realpath(workspacePath);
  const pageBytes: Buffer[] = [];
  let total = 0;
  for (const pagePath of report.pngPaths) {
    if (!isAbsolute(pagePath)) throw new Error("PREVIEW_PATH_INVALID");
    const stat = await lstat(pagePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PREVIEW_PATH_INVALID");
    const realPath = await realpath(pagePath);
    if (!pathIsWithin(realWorkspace, realPath)) throw new Error("PREVIEW_PATH_INVALID");
    const bytes = await readFile(realPath);
    if (bytes.byteLength < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71
        || bytes[4] !== 13 || bytes[5] !== 10 || bytes[6] !== 26 || bytes[7] !== 10) {
      throw new Error("PREVIEW_PNG_INVALID");
    }
    total += bytes.byteLength;
    if (total > MAX_PREVIEW_BYTES) throw new Error("PREVIEW_SIZE_LIMIT");
    pageBytes.push(bytes);
  }
  return pageBytes;
}

function imageUsageForPlan(plan: PresentationPlan): Array<{ assetId: string; fileName: string; slideIds: string[] }> {
  return plan.assetManifest.map((asset) => ({
    assetId: asset.assetId,
    fileName: asset.fileName,
    slideIds: plan.slides.filter((slide) => slide.imageIds.includes(asset.assetId)).map((slide) => slide.id),
  }));
}

async function createMarpBundle(marp: string, plan: PresentationPlan, images: ResolvedAttachments["images"], markdownName: string): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  entries[markdownName] = new TextEncoder().encode(marp);
  const imagesById = new Map(images.map((asset) => [asset.assetId, asset]));
  for (const manifest of plan.assetManifest) {
    const image = imagesById.get(manifest.assetId);
    if (!image) throw new Error("BUNDLE_IMAGE_MISSING");
    const extension = manifest.mimeType === "image/png" ? "png" : "jpg";
    entries[`assets/${manifest.assetId}.${extension}`] = await readFile(image.path);
  }
  return zipSync(entries, { level: 6 });
}

function previewWarning(preview: PreviewReport | undefined, caught?: unknown): string {
  const issue = preview?.errors[0];
  if (issue) return `${issue.code}: ${issue.message}`;
  if (caught instanceof Error && caught.message === "PREVIEW_PAGE_COUNT_MISMATCH") return "PAGE_COUNT_MISMATCH: Preview page count did not match the final slide count.";
  if (caught instanceof Error && caught.message === "PREVIEW_SIZE_LIMIT") return "PREVIEW_SIZE_LIMIT: Preview images exceeded the supported output limit.";
  if (caught instanceof Error && caught.message === "PREVIEW_PNG_INVALID") return "PREVIEW_RENDER_FAILED: A preview page was not a valid PNG image.";
  return "PREVIEW_FAILED: The preview could not be rendered; visual QA is incomplete.";
}

async function renderPresentationCore(
  input: unknown,
  dependencies: RenderPresentationDependencies,
  jobId: string,
  setCleanupOutcome: (outcome: RenderFinalizedEvent["cleanupOutcome"]) => void,
): Promise<RenderPresentationOutput> {
  const parsedInput = RenderPresentationInputSchema.safeParse(input);
  if (!parsedInput.success) {
    const raw = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    const code = raw.sourceFile === undefined ? "SOURCE_MISSING" : "PLAN_INVALID";
    return failure(jobId, code, "input", "The request does not match the strict presentation rendering input contract.", {
      userAction: code === "SOURCE_MISSING" ? "Attach a Markdown source file and retry." : "Remove unsupported fields and provide a valid structured slide plan.",
    });
  }

  const request = parsedInput.data as RenderPresentationInput & { sourceFile: AttachmentReference; imageFiles: AttachmentReference[] };
  const theme = dependencies.themes?.get(request.plan.themeId)
    ?? (request.plan.themeId === dependencies.theme.id ? dependencies.theme : undefined);
  if (!theme || (request.themeId && request.themeId !== theme.id)) {
    return failure(jobId, "PLAN_INVALID", "plan", "The selected theme is not the configured theme for this renderer.", {
      userAction: "Select one of the configured theme IDs and regenerate the structured plan.",
    });
  }

  let attachments: ResolvedAttachments | undefined;
  let published = false;
  let currentStage: PresentationFailure["failure"]["stage"] = "attachments";
  try {
    attachments = await resolveAttachments({
      jobId,
      sourceFile: request.sourceFile,
      imageFiles: request.imageFiles,
      imageAssetIds: request.imageAssetIds,
      plan: request.plan,
    }, dependencies.attachmentResolver);
    currentStage = "plan";

    if (request.editorialBrief) {
      const editorialIssues = checkEditorial(request.editorialBrief, request.plan, new TextDecoder().decode(attachments.markdown));
      const editorialError = editorialIssues.find((entry) => entry.severity === "error");
      if (editorialError) {
        return failure(jobId, editorialError.code, "plan", editorialError.message, {
          userAction: editorialError.suggestedAction,
          retryable: false,
        });
      }
    }

    let finalPlan: PresentationPlan;
    try {
      finalPlan = canonicalPlanWithAppendix(request.plan, attachments.images, request.editorialBrief?.requestedSlideCount ?? MAX_SLIDES);
    } catch (error) {
      if (error instanceof Error && error.message === "PRESENTATION_LIMIT_EXCEEDED") {
        const requestedSlideCount = request.editorialBrief?.requestedSlideCount;
        return failure(jobId, requestedSlideCount ? "EDITORIAL_PAGE_CAPACITY" : "PRESENTATION_LIMIT_EXCEEDED", "plan", requestedSlideCount
          ? `The requested ${requestedSlideCount} pages cannot contain every received image without an appendix page.`
          : "There is no room to append every received image within the 60-slide limit.", {
          userAction: requestedSlideCount
            ? "Reduce the number of source slides or explicitly reserve a page for every required image."
            : "Summarize or remove slides so one appendix slide per unmapped image fits within 60 slides.",
        });
      }
      throw error;
    }

    const planIssues = validatePresentationPlan(finalPlan, attachments.images.map((image) => image.assetId));
    const planErrors = planIssues.filter((issue) => issue.severity === "error");
    if (planErrors.length) {
      const issue = planErrors[0]!;
      const code = issue.code === "MISSING_IMAGE_ID" ? "REFERENCE_MISSING" : "PLAN_INVALID";
      return failure(jobId, code, "plan", "The structured presentation plan is invalid or refers to an unavailable asset.", {
        affectedFileOrSlide: issue.slideId ?? issue.imageId,
        userAction: "Regenerate the plan using the received attachment manifest and valid slide references.",
      });
    }

    const overflow = layoutIssues(finalPlan, theme);
    if (overflow.length) {
      const first = overflow[0]!;
      return failure(jobId, layoutFailure(first), "plan", first.message, {
        affectedFileOrSlide: first.slideId,
        userAction: "Revise only the affected slide/object and retry; preserve the image IDs and source references.",
        issues: overflow,
      });
    }

    const marpName = `${safeSlug(finalPlan.title)}.marp.md`;
    const pptxName = `${safeSlug(finalPlan.title)}.pptx`;
    const bundleName = `${safeSlug(finalPlan.title)}.marp.zip`;
    const imageAssets: ResolvedPptxAsset[] = attachments.images.map((image) => {
      const manifest = finalPlan.assetManifest.find((entry) => entry.assetId === image.assetId)!;
      return { ...manifest, path: image.path };
    });

    let pptxBytes: Uint8Array | undefined;
    let inspection: PptxInspection | undefined;
    let lastPptxError: unknown;
    currentStage = "verify";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        pptxBytes = await (dependencies.renderPptx ?? renderPptx)(finalPlan, imageAssets, theme);
        inspection = await (dependencies.inspectPptx ?? inspectPptx)(pptxBytes);
        if (inspection.slideCount !== finalPlan.slides.length || !inspection.relationshipsValid || !inspection.contentTypeOverridesValid || !inspection.slideBoundsValid) {
          throw new PptxValidationError("PPTX structural inspection did not match the final presentation plan.");
        }
        lastPptxError = undefined;
        break;
      } catch (error) {
        lastPptxError = error;
        if (error instanceof PptxValidationError || (error instanceof PptxRenderError && error.code === "PPTX_INVALID")) {
          return failure(jobId, "PPTX_INVALID", "verify", error.message, {
            ...(error.partName ? { affectedFileOrSlide: error.partName } : {}),
            userAction: "Do not deliver this file. Correct the reported package part or update the renderer; repeating the same export will not fix invalid XML.",
            retryable: false,
          });
        }
        if (error instanceof PptxRenderError && error.code === "MATH_RENDER_FAILED") {
          return failure(jobId, "RENDER_FAILED", "verify", error.message, {
            ...(error.slideId ? { affectedFileOrSlide: error.slideId } : {}),
            userAction: "Correct the indicated LaTeX equation or split it into a shorter standalone formula block, then retry.",
            retryable: false,
          });
        }
        if (error instanceof PptxRenderError && error.code === "PPTX_LAYOUT_INVALID" && error.issues?.length) {
          const issues = error.issues.filter((issue): issue is LayoutIssue => "actionable" in issue && issue.actionable);
          if (issues.length) {
            const first = issues[0]!;
            return failure(jobId, first.code, "plan", first.message, {
              affectedFileOrSlide: first.slideId,
              userAction: "Revise only the affected slide/object and retry.",
              issues,
            });
          }
        }
      }
    }
    if (lastPptxError || !pptxBytes || !inspection) {
      const code = lastPptxError instanceof PptxRenderError && lastPptxError.code === "PPTX_ASSET_MISSING"
        ? "ATTACHMENT_UNREADABLE"
        : "RENDER_FAILED";
      return failure(jobId, code, "verify", "The PPTX could not be rendered and structurally verified after one retry.", {
        userAction: "Retry once; if this persists, simplify the plan or check the received attachments.",
        retryable: true,
      });
    }

    currentStage = "render";
    let marp: string;
    let bundle: Uint8Array | undefined;
    try {
      marp = (dependencies.serializeMarp ?? serializeMarp)(finalPlan, theme);
      if (attachments.images.length > 0) bundle = await createMarpBundle(marp, finalPlan, attachments.images, marpName);
    } catch {
      return failure(jobId, "PLAN_INVALID", "plan", "The final plan could not be serialized to a safe Marp document.", {
        userAction: "Remove unsupported markup or URL text and regenerate the plan.",
      });
    }

    const pptxPath = await writePptxInWorkspace(attachments.workspacePath, jobId, pptxBytes);
    let preview: PreviewReport | undefined;
    let previewCaught: unknown;
    let previewPages: Buffer[] = [];
    try {
      preview = await (dependencies.preview ?? renderPreview)(pptxPath, attachments.workspacePath, {
        signal: dependencies.signal,
        ...(dependencies.previewProcessGroupId ? { processGroupId: dependencies.previewProcessGroupId } : {}),
      });
      if (preview.status === "ready") previewPages = await readPreviewPages(preview, attachments.workspacePath);
      if (preview.status === "ready" && previewPages.length !== finalPlan.slides.length) throw new Error("PREVIEW_PAGE_COUNT_MISMATCH");
    } catch (error) {
      previewCaught = error;
      preview = undefined;
      previewPages = [];
    }

    const warnings = preview?.warnings.map((issue) => `${issue.code}: ${issue.message}`) ?? [];
    if (!preview || preview.status !== "ready" || previewCaught) warnings.push(previewWarning(preview, previewCaught));

    try {
      currentStage = "publish";
      const pptxRef = await dependencies.artifactStore.put(jobId, pptxName, PPTX_MIME, pptxBytes);
      const marpRef = await dependencies.artifactStore.put(jobId, marpName, MARP_MIME, new TextEncoder().encode(marp));
      const bundleRef = bundle ? await dependencies.artifactStore.put(jobId, bundleName, MARP_BUNDLE_MIME, bundle) : undefined;
      const previewRefs: ArtifactRef[] = [];
      for (let index = 0; index < previewPages.length; index++) {
        previewRefs.push(await dependencies.artifactStore.put(jobId, `preview-${index + 1}.png`, PREVIEW_MIME, previewPages[index]!));
      }
      const previewReady = preview?.status === "ready" && !previewCaught;
      warnings.push("POWERPOINT_VERIFICATION_REQUIRED: This is an unverified draft. Open the original in Microsoft PowerPoint, save a new file, close and reopen it without a repair prompt before final delivery.");
      const output = {
        status: "draft" as const,
        deliveryStatus: "unverified" as const,
        jobId,
        pptx: pptxRef,
        marp: marpRef,
        ...(bundleRef ? { marpBundle: bundleRef } : {}),
        previews: previewReady ? previewRefs : [],
        slideCount: finalPlan.slides.length,
        imageUsage: imageUsageForPlan(finalPlan),
        warnings,
        validation: {
          pptx: inspection,
          powerPoint: { status: "not_run" as const, artifactSha256: createHash("sha256").update(pptxBytes).digest("hex") },
          preview: {
            status: previewReady ? "ready" as const : "draft" as const,
            pageCount: previewReady ? preview!.pageCount : 0,
            fontRequested: preview?.font.requested ?? theme.typography.fontFace,
            fontSelected: preview?.font.selected ?? null,
            fontSubstituted: preview?.font.substituted ?? false,
            issues: summarizePreviewIssues([...(preview?.warnings ?? []), ...(preview?.errors ?? [])]),
          },
          visualQaPassed: false as const,
        },
      };
      const validatedOutput = completedOrDraftSchema.parse(output);
      published = true;
      return validatedOutput;
    } catch (error) {
      return failure(jobId, "ARTIFACT_UNOPENABLE", "publish", "The structurally checked draft could not be saved to the configured artifact store.", {
        userAction: "Check that the configured output directory is available and writable, then retry.",
        retryable: true,
      });
    }
  } catch (error) {
    if (error instanceof PptxRenderError && error.code === "MATH_RENDER_FAILED") {
      return failure(jobId, "RENDER_FAILED", currentStage === "plan" ? "plan" : "verify", error.message, {
        ...(error.slideId ? { affectedFileOrSlide: error.slideId } : {}),
        userAction: "Correct the indicated LaTeX expression and retry.",
        retryable: false,
      });
    }
    if (currentStage === "attachments") {
      const mapped = safeAttachmentError(error);
      return failure(jobId, mapped.code, "attachments", mapped.message, {
        ...(mapped.affected ? { affectedFileOrSlide: mapped.affected } : {}),
        userAction: mapped.userAction,
        retryable: error instanceof AttachmentResolverError ? error.retryable : false,
      });
    }
    const stage = currentStage === "verify" ? "verify" : currentStage === "plan" ? "plan" : "render";
    return failure(jobId, stage === "plan" ? "PLAN_INVALID" : "RENDER_FAILED", stage, "The presentation could not be completed at this processing stage.", {
      userAction: stage === "plan" ? "Correct the structured slide plan and retry." : "Retry once; if this persists, simplify the plan or verify the attachment service.",
      retryable: stage !== "plan",
    });
  } finally {
    let cleanupAttempted = false;
    let cleanupFailed = false;
    if (!published && dependencies.artifactStore.deleteJob) {
      cleanupAttempted = true;
      try { await dependencies.artifactStore.deleteJob(jobId); }
      catch { cleanupFailed = true; }
    }
    if (attachments) {
      cleanupAttempted = true;
      try { await attachments.cleanup(); }
      catch { cleanupFailed = true; }
    }
    setCleanupOutcome(!cleanupAttempted ? "not-needed" : cleanupFailed ? "failed" : "succeeded");
  }
}

export async function renderPresentation(
  input: unknown,
  dependencies: RenderPresentationDependencies,
  options: { jobId?: string } = {},
): Promise<RenderPresentationOutput> {
  const jobId = options.jobId ?? randomUUID();
  const startedAt = performance.now();
  let cleanupOutcome: RenderFinalizedEvent["cleanupOutcome"] = "not-needed";
  let output: RenderPresentationOutput | undefined;
  try {
    output = await renderPresentationCore(input, dependencies, jobId, (outcome) => { cleanupOutcome = outcome; });
    return output;
  } finally {
    if (output) {
      const event: RenderFinalizedEvent = {
        jobId,
        status: output.status,
        ...(output.status === "failed" ? { errorCode: output.failure.code } : {}),
        durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
        cleanupOutcome,
      };
      try { dependencies.onRenderFinalized?.(event); }
      catch { /* Telemetry failures must never alter the rendering result. */ }
    }
  }
}
