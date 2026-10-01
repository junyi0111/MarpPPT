import { z } from "zod";
import { SourceFailureSchema } from "../../source/source-contracts.js";
import { prepareSourceMaterial, type PreparedSourceMaterial, type SourceMaterialDependencies } from "../../source/source-material.js";

const pageRangeOutputSchema = z.union([
  z.object({ page: z.number().int().min(1) }).strict(),
  z.object({ from: z.number().int().min(1), to: z.number().int().min(1) }).strict(),
]);

export const PreparedSourceSchema = z.object({
  id: z.string().regex(/^source-[0-9a-f-]{36}-[1-8]$/u),
  kind: z.enum(["url", "pdf"]),
  title: z.string().min(1).max(160),
  locator: z.string().min(1).max(2_048),
  pageRange: pageRangeOutputSchema.optional(),
  content: z.string().min(1).max(2 * 1024 * 1024),
  characterCount: z.number().int().nonnegative(),
}).strict();

export const PrepareMarkdownSourcesOutputSchema = z.object({
  status: z.enum(["ready", "partial", "failed"]),
  jobId: z.string().uuid(),
  options: z.object({
    complexity: z.enum(["brief", "standard", "detailed"]),
    style: z.enum(["tech-editorial", "academic", "executive", "tutorial"]),
    summary: z.enum(["light", "moderate", "deep"]),
    language: z.string(),
    audience: z.string().optional(),
    requestedSlideCount: z.number().int().min(1).max(60).optional(),
  }).strict(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  sources: z.array(PreparedSourceSchema).max(8),
  failures: z.array(SourceFailureSchema).max(8),
  warnings: z.array(z.string().max(500)),
}).strict();

export type PrepareMarkdownSourcesOutput = z.infer<typeof PrepareMarkdownSourcesOutputSchema>;

export function parsePreparedSourceOutput(output: PreparedSourceMaterial): PrepareMarkdownSourcesOutput {
  return PrepareMarkdownSourcesOutputSchema.parse(output);
}

export async function prepareMarkdownSources(
  input: unknown,
  dependencies: SourceMaterialDependencies,
): Promise<PrepareMarkdownSourcesOutput> {
  return parsePreparedSourceOutput(await prepareSourceMaterial(input, dependencies));
}
