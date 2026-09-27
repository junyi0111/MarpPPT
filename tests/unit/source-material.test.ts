import { describe, expect, it, vi } from "vitest";
import { prepareSourceMaterial, type SourceMaterialDependencies } from "../../src/source/source-material.js";

const baseInput = {
  sources: [{ kind: "url" as const, url: "https://example.com/article" }],
  options: {},
};

function deps(overrides: Partial<SourceMaterialDependencies> = {}): SourceMaterialDependencies {
  return {
    resolveHostname: async () => ["93.184.216.34"],
    fetchSource: async () => ({
      status: 200,
      finalUrl: "https://example.com/article",
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from("<html><head><title>Example</title><style>.x{}</style></head><body><h1>Heading</h1><script>alert(1)</script><p>Visible text &amp; facts.</p></body></html>", "utf8"),
    }),
    extractPdfText: async () => "PDF text",
    ...overrides,
  };
}

describe("source material preparation", () => {
  it("extracts bounded visible HTML text and normalizes options", async () => {
    const result = await prepareSourceMaterial(baseInput, deps());
    expect(result.status).toBe("ready");
    expect(result.options).toMatchObject({ complexity: "standard", style: "tech-editorial", summary: "moderate", language: "auto" });
    expect(result.sources[0]).toMatchObject({ id: "source-1", title: "Example", content: expect.stringContaining("Visible text & facts.") });
    expect(result.sources[0]!.content).not.toContain("alert");
    expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects private DNS results before making a request", async () => {
    const fetchSource = vi.fn();
    const result = await prepareSourceMaterial(baseInput, deps({
      resolveHostname: async () => ["127.0.0.1"],
      fetchSource,
    }));
    expect(result.status).toBe("failed");
    expect(result.failures[0]).toMatchObject({ code: "PRIVATE_ADDRESS_BLOCKED", stage: "fetch" });
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it("rejects redirects and response-origin changes", async () => {
    const redirected = await prepareSourceMaterial(baseInput, deps({
      fetchSource: async () => ({ status: 302, finalUrl: "https://example.com/other", headers: {}, body: Buffer.alloc(0) }),
    }));
    expect(redirected.failures[0]).toMatchObject({ code: "REDIRECT_BLOCKED" });
    const crossOrigin = await prepareSourceMaterial(baseInput, deps({
      fetchSource: async () => ({ status: 200, finalUrl: "https://evil.example/secret", headers: { "content-type": "text/plain" }, body: Buffer.from("secret") }),
    }));
    expect(crossOrigin.failures[0]).toMatchObject({ code: "REDIRECT_BLOCKED" });
    const sameOriginPathChange = await prepareSourceMaterial(baseInput, deps({
      fetchSource: async () => ({ status: 200, finalUrl: "https://example.com/other", headers: { "content-type": "text/plain" }, body: Buffer.from("unexpected") }),
    }));
    expect(sameOriginPathChange.failures[0]).toMatchObject({ code: "REDIRECT_BLOCKED" });
  });

  it("dispatches PDF attachments and returns partial results when one source fails", async () => {
    const result = await prepareSourceMaterial({
      sources: [
        { kind: "pdf", file: { fileName: "paper.pdf", mimeType: "application/pdf", assetId: "stage:pdf" } },
        { kind: "url", url: "https://example.com/unsupported" },
      ],
      options: { summary: "deep" },
    }, deps({
      readAttachment: async () => Buffer.from("%PDF-1.7\nbytes"),
      fetchSource: async () => ({ status: 200, finalUrl: "https://example.com/unsupported", headers: { "content-type": "application/octet-stream" }, body: Buffer.from("binary") }),
      extractPdfText: async () => "Extracted PDF facts",
    }));
    expect(result.status).toBe("partial");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ id: "source-1", kind: "pdf", content: "Extracted PDF facts" });
    expect(result.failures).toMatchObject([{ sourceId: "source-2", code: "SOURCE_UNSUPPORTED_TYPE" }]);
  });

  it("fails a source that would exceed the prepared context limit", async () => {
    const result = await prepareSourceMaterial(baseInput, deps({
      fetchSource: async () => ({ status: 200, finalUrl: "https://example.com/article", headers: { "content-type": "text/plain" }, body: Buffer.alloc(2 * 1024 * 1024 + 1, 65) }),
    }));
    expect(result.failures[0]).toMatchObject({ code: "SOURCE_LIMIT_EXCEEDED", stage: "extract" });
  });
});
