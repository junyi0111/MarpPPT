import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalArtifactStore } from "../../src/artifacts/local-artifact-store.js";
import { createMcpServer } from "../../src/mcp/server.js";

describe("source preparation and Markdown draft MCP tools", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function connect() {
    const outputRoot = await mkdtemp(join(tmpdir(), "marpppt-source-tools-"));
    roots.push(outputRoot);
    const artifactStore = await createLocalArtifactStore({ outputRoot });
    const server = createMcpServer({
      attachmentResolver: { probeResolver: { read: async () => Buffer.from("unused") } },
      artifactStore,
      theme: { id: "default" } as never,
      sourceMaterial: {
        resolveHostname: async () => ["93.184.216.34"],
        fetchSource: async () => ({
          status: 200,
          finalUrl: "https://example.com/article",
          headers: { "content-type": "text/plain" },
          body: Buffer.from("A measured source fact.", "utf8"),
        }),
        readAttachment: async () => Buffer.from("%PDF-1.7\nattached", "ascii"),
        extractPdfText: async () => "A PDF source fact.",
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "source-tools-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server, artifactStore, outputRoot };
  }

  it("exposes choice enums and prepares URL/PDF source context", async () => {
    const { client, server, artifactStore } = await connect();
    const tools = await client.listTools();
    const prepare = tools.tools.find((tool) => tool.name === "prepare_markdown_sources");
    expect(prepare).toBeDefined();
    expect(prepare?.inputSchema.properties?.options?.properties?.style?.enum).toEqual([
      "tech-editorial", "academic", "executive", "tutorial",
    ]);
    expect(prepare?.inputSchema.properties?.options?.properties?.complexity?.enum).toEqual(["brief", "standard", "detailed"]);

    const result = await client.callTool({
      name: "prepare_markdown_sources",
      arguments: {
        sources: [
          { kind: "url", url: "https://example.com/article" },
          { kind: "pdf", file: { fileName: "paper.pdf", mimeType: "application/pdf", assetId: "stage:pdf" } },
        ],
        options: { style: "academic", complexity: "detailed" },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "ready", sources: [{ content: "A measured source fact." }, { content: "A PDF source fact." }] });
    await client.close();
    await server.close();
    await artifactStore.close?.();
  });

  it("saves a Markdown draft and rejects source IDs from another preparation job", async () => {
    const { client, server, artifactStore } = await connect();
    const prepared = await client.callTool({
      name: "prepare_markdown_sources",
      arguments: { sources: [{ kind: "url", url: "https://example.com/article" }], options: {} },
    });
    const preparedValue = prepared.structuredContent as { jobId: string; sources: Array<{ id: string }>; options: object };
    const draft = await client.callTool({
      name: "save_markdown_draft",
      arguments: {
        sourceJobId: preparedValue.jobId,
        sourceIds: [preparedValue.sources[0]!.id],
        title: "Source brief",
        markdown: "# Source brief\n\n- A measured source fact.\n",
        options: preparedValue.options,
      },
    });
    expect(draft.isError).not.toBe(true);
    expect(draft.structuredContent).toMatchObject({ status: "completed", markdown: { mimeType: "text/markdown" } });
    const artifactUri = (draft.structuredContent as { markdown: { uri: string } }).markdown.uri;
    await expect(readFile(new URL(artifactUri), "utf8")).resolves.toContain("A measured source fact");

    const mismatchedOptions = await client.callTool({
      name: "save_markdown_draft",
      arguments: {
        sourceJobId: preparedValue.jobId,
        sourceIds: [preparedValue.sources[0]!.id],
        title: "Mismatched options",
        markdown: "# Mismatch\n",
        options: { ...preparedValue.options, style: "academic" },
      },
    });
    expect(mismatchedOptions.isError).toBe(true);
    expect(mismatchedOptions.structuredContent).toMatchObject({ failure: { code: "SOURCE_CONTEXT_NOT_FOUND" } });

    const crossJob = await client.callTool({
      name: "save_markdown_draft",
      arguments: {
        sourceJobId: "00000000-0000-4000-8000-000000000099",
        sourceIds: [preparedValue.sources[0]!.id],
        title: "Wrong source job",
        markdown: "# Wrong\n",
        options: {},
      },
    });
    expect(crossJob.isError).toBe(true);
    expect(crossJob.structuredContent).toMatchObject({ failure: { code: "SOURCE_CONTEXT_NOT_FOUND" } });

    const forgedSourceId = `source-${preparedValue.jobId}-8`;
    const forged = await client.callTool({
      name: "save_markdown_draft",
      arguments: {
        sourceJobId: preparedValue.jobId,
        sourceIds: [forgedSourceId],
        title: "Forged source context",
        markdown: "# Forged\n",
        options: preparedValue.options,
      },
    });
    expect(forged.isError).toBe(true);
    expect(forged.structuredContent).toMatchObject({ failure: { code: "SOURCE_CONTEXT_NOT_FOUND" } });
    await client.close();
    await server.close();
    await artifactStore.close?.();
  });

  it("rejects traversal filenames before writing a draft", async () => {
    const { client, server, artifactStore } = await connect();
    const prepared = await client.callTool({
      name: "prepare_markdown_sources",
      arguments: { sources: [{ kind: "url", url: "https://example.com/article" }], options: {} },
    });
    const preparedValue = prepared.structuredContent as { jobId: string; sources: Array<{ id: string }>; options: object };
    const result = await client.callTool({
      name: "save_markdown_draft",
      arguments: {
        sourceJobId: preparedValue.jobId,
        sourceIds: [preparedValue.sources[0]!.id],
        title: "Draft",
        fileName: "../escape.md",
        markdown: "# Draft\n",
        options: preparedValue.options,
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ failure: { code: "DRAFT_INVALID" } });
    await client.close();
    await server.close();
    await artifactStore.close?.();
  });
});
