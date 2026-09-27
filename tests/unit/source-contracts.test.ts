import { describe, expect, it } from "vitest";
import {
  MarkdownDraftOptionsSchema,
  SourceFailureSchema,
  SourceMaterialInputSchema,
} from "../../src/source/source-contracts.js";

describe("source-to-Markdown contracts", () => {
  it("normalizes deterministic drafting defaults and preserves explicit choices", () => {
    expect(MarkdownDraftOptionsSchema.parse({})).toEqual({
      complexity: "standard",
      style: "tech-editorial",
      summary: "moderate",
      language: "auto",
    });
    expect(MarkdownDraftOptionsSchema.parse({
      complexity: "detailed",
      style: "academic",
      summary: "light",
      language: "zh-TW",
      audience: "研究團隊",
      requestedSlideCount: 12,
    })).toMatchObject({
      complexity: "detailed",
      style: "academic",
      summary: "light",
      language: "zh-TW",
      audience: "研究團隊",
      requestedSlideCount: 12,
    });
  });

  it("accepts bounded URL and staged PDF sources with validated page ranges", () => {
    const parsed = SourceMaterialInputSchema.parse({
      sources: [
        { kind: "url", url: "https://example.com/research", label: "研究頁面" },
        {
          kind: "pdf",
          file: { fileName: "paper.pdf", mimeType: "application/pdf", assetId: "stage:abc" },
          pages: { from: 2, to: 4 },
        },
      ],
      options: { style: "academic" },
    });
    expect(parsed.options).toEqual({
      complexity: "standard",
      style: "academic",
      summary: "moderate",
      language: "auto",
    });
    expect(parsed.sources).toHaveLength(2);
  });

  it.each([
    { name: "empty source set", value: { sources: [], options: {} } },
    { name: "http URL", value: { sources: [{ kind: "url", url: "http://example.com" }], options: {} } },
    { name: "zero page", value: { sources: [{ kind: "pdf", file: { fileName: "paper.pdf", mimeType: "application/pdf", assetId: "stage:abc" }, pages: { page: 0 } }], options: {} } },
    { name: "too many sources", value: { sources: Array.from({ length: 9 }, () => ({ kind: "url", url: "https://example.com" })), options: {} } },
  ])("rejects $name", ({ value }) => {
    expect(() => SourceMaterialInputSchema.parse(value)).toThrow();
  });

  it("requires a safe, actionable failure shape", () => {
    const failure = SourceFailureSchema.parse({
      code: "PRIVATE_ADDRESS_BLOCKED",
      stage: "fetch",
      message: "The source host is not public.",
      userAction: "Use a public HTTPS URL.",
      retryable: false,
    });
    expect(failure.retryable).toBe(false);
    expect(() => SourceFailureSchema.parse({ ...failure, stage: "render" })).toThrow();
  });
});
