import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { MARP_MIME, type ArtifactRef, type ArtifactStore } from "../../artifacts/artifact-store.js";
import { MarkdownDraftOptionsSchema, type MarkdownDraftOptions } from "../../source/source-contracts.js";
import { getPreparedSourceContext } from "../../source/source-material.js";

export const MAX_MARKDOWN_DRAFT_BYTES = 2 * 1024 * 1024;

const sourceJobIdSchema = z.string().uuid();
const sourceIdSchema = z.string().regex(/^source-[0-9a-f-]{36}-[1-8]$/u);

export const SaveMarkdownDraftInputSchema = z.object({
  sourceJobId: sourceJobIdSchema,
  sourceIds: z.array(sourceIdSchema).min(1).max(32).superRefine((sourceIds, ctx) => {
    if (new Set(sourceIds).size !== sourceIds.length) ctx.addIssue({ code: "custom", message: "Source IDs must be unique." });
  }),
  title: z.string().trim().min(1).max(160),
  markdown: z.string().min(1),
  fileName: z.string().trim().min(1).max(120).optional(),
  options: MarkdownDraftOptionsSchema.default({
    complexity: "standard",
    style: "tech-editorial",
    summary: "moderate",
    language: "auto",
  }),
}).strict();

const artifactSchema = z.object({
  fileName: z.string(),
  mimeType: z.literal(MARP_MIME),
  uri: z.string().min(1),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict();

export const SaveMarkdownDraftOutputSchema = z.object({
  status: z.enum(["completed", "failed"]),
  jobId: z.string().uuid(),
  markdown: artifactSchema.optional(),
  sourceJobId: z.string().uuid(),
  sourceIds: z.array(sourceIdSchema),
  options: MarkdownDraftOptionsSchema,
  byteLength: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  failure: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
    stage: z.enum(["input", "fetch", "extract", "draft", "publish"]),
    message: z.string().min(1).max(500),
    userAction: z.string().min(1).max(500).optional(),
    retryable: z.boolean(),
  }).strict().optional(),
  warnings: z.array(z.string().max(500)),
}).strict().superRefine((output, ctx) => {
  if (output.status === "completed" && (!output.markdown || output.byteLength === undefined || !output.sha256 || output.failure)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Completed drafts require an artifact, byte count, and digest." });
  }
  if (output.status === "failed" && (!output.failure || output.markdown || output.byteLength !== undefined || output.sha256)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Failed drafts cannot claim a published artifact." });
  }
});

export type SaveMarkdownDraftInput = z.infer<typeof SaveMarkdownDraftInputSchema>;
export type SaveMarkdownDraftOutput = z.infer<typeof SaveMarkdownDraftOutputSchema>;

function slug(title: string): string {
  const value = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 90);
  return value || "markdown-draft";
}

function failure(input: SaveMarkdownDraftInput, jobId: string, code: string, message: string, userAction: string, retryable = false): SaveMarkdownDraftOutput {
  return SaveMarkdownDraftOutputSchema.parse({
    status: "failed",
    jobId,
    sourceJobId: input.sourceJobId,
    sourceIds: input.sourceIds,
    options: input.options,
    failure: { code, stage: code === "DRAFT_STORE_FAILED" ? "publish" : "draft", message, userAction, retryable },
    warnings: [],
  });
}

function validFileName(fileName: string | undefined): string {
  const selected = fileName ?? "markdown-draft.md";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md$/u.test(selected) || selected === ".md" || selected.includes("..")) {
    throw new Error("Markdown output filename must be a plain .md filename without path components.");
  }
  return selected;
}

function sameOptions(left: MarkdownDraftOptions, right: MarkdownDraftOptions): boolean {
  return left.complexity === right.complexity
    && left.style === right.style
    && left.summary === right.summary
    && left.language === right.language
    && left.audience === right.audience
    && left.requestedSlideCount === right.requestedSlideCount;
}

export async function saveMarkdownDraft(input: SaveMarkdownDraftInput, artifactStore: ArtifactStore): Promise<SaveMarkdownDraftOutput> {
  const jobId = randomUUID();
  const preparedContext = getPreparedSourceContext(input.sourceJobId);
  if (!preparedContext || input.sourceIds.some((sourceId) => !preparedContext.sourceIds.has(sourceId)) || !sameOptions(input.options, preparedContext.options)) {
    return failure(input, jobId, "SOURCE_CONTEXT_NOT_FOUND", "The source IDs do not belong to the selected preparation job.", "Prepare the sources again and use the returned source IDs.");
  }
  let fileName: string;
  try {
    fileName = validFileName(input.fileName ?? `${slug(input.title)}.md`);
  } catch (error) {
    return failure(input, jobId, "DRAFT_INVALID", error instanceof Error ? error.message : "The Markdown filename is invalid.", "Use a plain filename ending in .md.");
  }
  const bytes = Buffer.from(input.markdown, "utf8");
  if (bytes.byteLength > MAX_MARKDOWN_DRAFT_BYTES) {
    return failure(input, jobId, "DRAFT_INVALID", "The Markdown draft exceeds the 2 MiB limit.", "Reduce the draft or split it into smaller source files.");
  }
  if (!input.markdown.trim()) {
    return failure(input, jobId, "DRAFT_INVALID", "The Markdown draft is empty.", "Provide a non-empty Markdown draft.");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    const markdown = await artifactStore.put(jobId, fileName, MARP_MIME, bytes);
    return SaveMarkdownDraftOutputSchema.parse({
      status: "completed",
      jobId,
      markdown,
      sourceJobId: input.sourceJobId,
      sourceIds: input.sourceIds,
      options: input.options,
      byteLength: bytes.byteLength,
      sha256,
      warnings: [],
    });
  } catch (error) {
    try { await artifactStore.deleteJob?.(jobId); } catch { /* Preserve the original publish failure. */ }
    return failure(input, jobId, "DRAFT_STORE_FAILED", error instanceof Error ? error.message : "The Markdown artifact could not be saved.", "Check the output directory and retry.", true);
  }
}
