import { z } from "zod";

const fileNameSchema = z.string().trim().min(1).max(255)
  .refine((value) => !/[\\/\0\x00-\x1f\x7f]/u.test(value) && value !== "." && value !== "..", "Use a plain filename without path components.");
const mimeTypeSchema = z.string().trim().min(1).max(128);
const assetIdSchema = z.string().trim().min(1).max(512);
const languageSchema = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u, "Expected a language tag such as zh-TW.");

const authorizedDownloadUrlSchema = z.string().trim().min(1).max(4_096).url()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
    } catch {
      return false;
    }
  }, "Authorized file URLs must use HTTPS without credentials or fragments.");

const stagedFileReferenceSchema = z.object({
  fileName: fileNameSchema,
  mimeType: mimeTypeSchema,
  assetId: assetIdSchema,
}).strict();

const authorizedFileReferenceSchema = z.object({
  kind: z.literal("host-file"),
  fileId: z.string().trim().min(1).max(512),
  fileName: fileNameSchema,
  mimeType: mimeTypeSchema,
  downloadUrl: authorizedDownloadUrlSchema,
}).strict();

export const SourceFileReferenceSchema = z.union([stagedFileReferenceSchema, authorizedFileReferenceSchema]);

const pageSelectorSchema = z.union([
  z.object({ page: z.number().int().min(1).max(10_000) }).strict(),
  z.object({ from: z.number().int().min(1).max(10_000), to: z.number().int().min(1).max(10_000) })
    .strict()
    .superRefine((range, ctx) => {
      if (range.from > range.to) ctx.addIssue({ code: "custom", path: ["to"], message: "The end page must not precede the start page." });
    }),
]);

export const MarkdownDraftOptionsSchema = z.object({
  complexity: z.enum(["brief", "standard", "detailed"]).default("standard"),
  style: z.enum(["tech-editorial", "academic", "executive", "tutorial"]).default("tech-editorial"),
  summary: z.enum(["light", "moderate", "deep"]).default("moderate"),
  language: z.union([z.literal("auto"), languageSchema]).default("auto"),
  audience: z.string().trim().min(1).max(160).optional(),
  requestedSlideCount: z.number().int().min(1).max(60).optional(),
}).strict();

const urlSourceSchema = z.object({
  kind: z.literal("url"),
  url: z.string().trim().min(1).max(2_048).url()
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
      } catch {
        return false;
      }
    }, "Source URLs must use HTTPS without credentials or fragments."),
  label: z.string().trim().min(1).max(160).optional(),
}).strict();

const pdfSourceSchema = z.object({
  kind: z.literal("pdf"),
  file: SourceFileReferenceSchema,
  pages: pageSelectorSchema.optional(),
}).strict().superRefine((source, ctx) => {
  if (source.file.mimeType.split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf") {
    ctx.addIssue({ code: "custom", path: ["file", "mimeType"], message: "PDF sources must be declared as application/pdf." });
  }
  if (!source.file.fileName.toLowerCase().endsWith(".pdf")) {
    ctx.addIssue({ code: "custom", path: ["file", "fileName"], message: "PDF sources must use a .pdf filename." });
  }
});

export const SourceMaterialInputSchema = z.object({
  sources: z.array(z.discriminatedUnion("kind", [urlSourceSchema, pdfSourceSchema])).min(1).max(8),
  options: MarkdownDraftOptionsSchema.default({
    complexity: "standard",
    style: "tech-editorial",
    summary: "moderate",
    language: "auto",
  }),
}).strict();

export const SourceFailureSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
  stage: z.enum(["input", "fetch", "extract", "draft", "publish"]),
  sourceId: z.string().max(120).optional(),
  message: z.string().trim().min(1).max(500),
  userAction: z.string().trim().min(1).max(500).optional(),
  retryable: z.boolean(),
}).strict();

export type MarkdownDraftOptions = z.infer<typeof MarkdownDraftOptionsSchema>;
export type SourceFileReference = z.infer<typeof SourceFileReferenceSchema>;
export type SourceMaterialInput = z.infer<typeof SourceMaterialInputSchema>;
export type SourceFailure = z.infer<typeof SourceFailureSchema>;
export type PageSelector = z.infer<typeof pageSelectorSchema>;
