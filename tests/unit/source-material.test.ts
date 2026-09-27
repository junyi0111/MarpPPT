import { describe, expect, it, vi } from "vitest";
import { createPinnedLookup, prepareSourceMaterial, type SourceMaterialDependencies } from "../../src/source/source-material.js";

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
  it("returns Node's expected address array when a pinned lookup requests all results", async () => {
    const lookup = createPinnedLookup("93.184.216.34");
    await new Promise<void>((resolve, reject) => lookup("example.com", { all: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
      resolve();
    }));
  });

  it("extracts bounded visible HTML text and normalizes options", async () => {
    const result = await prepareSourceMaterial(baseInput, deps());
    expect(result.status).toBe("ready");
    expect(result.options).toMatchObject({ complexity: "standard", style: "tech-editorial", summary: "moderate", language: "auto" });
    expect(result.sources[0]).toMatchObject({ id: `source-${result.jobId}-1`, title: "Example", content: expect.stringContaining("Visible text & facts.") });
    expect(result.sources[0]!.content).not.toContain("alert");
    expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(["127.0.0.1", "192.0.0.1", "2001:2::1"])("rejects non-public DNS result %s before making a request", async (address) => {
    const fetchSource = vi.fn();
    const result = await prepareSourceMaterial(baseInput, deps({
      resolveHostname: async () => [address],
      fetchSource,
    }));
    expect(result.status).toBe("failed");
    expect(result.failures[0]).toMatchObject({ code: "PRIVATE_ADDRESS_BLOCKED", stage: "fetch" });
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it("bounds DNS resolution by the source timeout", async () => {
    const result = await prepareSourceMaterial(baseInput, deps({
      timeoutMs: 5,
      resolveHostname: async () => await new Promise<string[]>(() => undefined),
    }));
    expect(result.failures[0]).toMatchObject({ code: "SOURCE_FETCH_TIMEOUT", retryable: true });
  });

  it("bounds source titles before publishing the MCP output", async () => {
    const result = await prepareSourceMaterial(baseInput, deps({
      fetchSource: async () => ({
        status: 200,
        finalUrl: "https://example.com/article",
        headers: { "content-type": "text/html" },
        body: Buffer.from(`<title>${"x".repeat(200)}</title><p>Visible fact.</p>`, "utf8"),
      }),
    }));
    expect(result.sources[0]?.title).toHaveLength(160);
    expect(result.sources[0]?.content).toContain("Visible fact.");
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
    expect(result.sources[0]).toMatchObject({ id: `source-${result.jobId}-1`, kind: "pdf", content: "Extracted PDF facts" });
    expect(result.failures).toMatchObject([{ sourceId: `source-${result.jobId}-2`, code: "SOURCE_UNSUPPORTED_TYPE" }]);
  });

  it("fails a source that would exceed the prepared context limit", async () => {
    const result = await prepareSourceMaterial(baseInput, deps({
      fetchSource: async () => ({ status: 200, finalUrl: "https://example.com/article", headers: { "content-type": "text/plain" }, body: Buffer.alloc(2 * 1024 * 1024 + 1, 65) }),
    }));
    expect(result.failures[0]).toMatchObject({ code: "SOURCE_LIMIT_EXCEEDED", stage: "extract" });
  });
});
