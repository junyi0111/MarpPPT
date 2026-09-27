import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalArtifactStore } from "../../src/artifacts/local-artifact-store.js";
import { createFailClosedRenderDependencies, createMcpServer } from "../../src/mcp/server.js";
import { createApp } from "../../src/mcp/http.js";
import { startStdioServer } from "../../src/mcp/stdio.js";
import { removeStagedJob, stageAttachments } from "../../src/probe/local-attachment-stage.js";
import type { PresentationPlan } from "../../src/contracts/presentation-plan.js";
import type { PreviewReport } from "../../src/preview/render-preview.js";

describe("production MCP entry points", () => {
  let outputRoot: string;
  let inputRoot: string;
  let store: Awaited<ReturnType<typeof createLocalArtifactStore>> | undefined;
  const stagedJobIds: string[] = [];

  beforeEach(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), "marpppt-mcp-test-"));
    inputRoot = await mkdtemp(join(tmpdir(), "marpppt-stage-input-"));
  });

  afterEach(async () => {
    await store?.close?.();
    store = undefined;
    await Promise.all([
      rm(outputRoot, { recursive: true, force: true }),
      rm(inputRoot, { recursive: true, force: true }),
      ...stagedJobIds.splice(0).map((jobId) => removeStagedJob(jobId).catch(() => undefined)),
    ]);
  });

  function failClosedResolver() {
    return { probeResolver: { read: async () => { throw new Error("not authorized"); } } };
  }

  async function createStore() {
    store = await createLocalArtifactStore({ outputRoot });
    return store;
  }

  it("registers only render_presentation with closed-world non-destructive annotations and returns a typed MCP result", async () => {
    const artifactStore = await createStore();
    const server = createMcpServer({
      attachmentResolver: failClosedResolver(),
      artifactStore,
      theme: { id: "default" } as never,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "task7-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(["render_presentation"]);
    expect(tools.tools[0]?.annotations).toMatchObject({ openWorldHint: false, destructiveHint: false });
    expect(tools.tools[0]?.inputSchema.properties).toHaveProperty("plan");
    expect(tools.tools[0]?.outputSchema).toBeDefined();

    const markdown = Buffer.from("# Source\n", "utf8");
    const call = await client.callTool({
      name: "render_presentation",
      arguments: {
        plan: {
          version: 1,
          title: "Source",
          language: "en",
          themeId: "default",
          sourceDigest: createHash("sha256").update(markdown).digest("hex"),
          slides: [{ id: "cover", title: "Source", layout: "cover", imageIds: [] }],
          imageAssetIds: [],
          assetManifest: [],
        },
        sourceFile: { fileName: "source.md", mimeType: "text/markdown", assetId: "stage:source" },
        imageFiles: [],
        imageAssetIds: [],
      },
    });
    expect(call.isError).toBe(true);
    expect(call.structuredContent).toMatchObject({ status: "failed", failure: { code: "ATTACHMENT_UNREADABLE" } });

    await client.close();
    await server.close();
  });

  it("exposes ensure_font only when a local font installer is explicitly provided", async () => {
    const artifactStore = await createStore();
    const server = createMcpServer({
      attachmentResolver: failClosedResolver(),
      artifactStore,
      theme: { id: "default" } as never,
      fontInstaller: {
        ensure: async (request) => ({
          status: "installed" as const,
          themeId: request.themeId,
          family: "Noto Sans CJK TC",
          platform: "darwin" as const,
          installDirectory: "/Users/tester/Library/Fonts",
          files: ["NotoSansTC-variable.ttf"],
          matched: "Noto Sans CJK TC",
          verified: true,
          message: "installed",
          userAction: "rerun preflight",
        }),
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "font-installer-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["render_presentation", "ensure_font"]);
    expect(tools.tools.find((tool) => tool.name === "ensure_font")?.annotations).toMatchObject({ openWorldHint: true, destructiveHint: true });

    const result = await client.callTool({ name: "ensure_font", arguments: { themeId: "default", installIfMissing: true } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "installed", themeId: "default", verified: true });
    await client.close();
    await server.close();
  });

  it("uses an injected hosted render executor while preserving the public tool result shape", async () => {
    const artifactStore = await createStore();
    const executeRender = vi.fn(async () => ({
      status: "failed" as const,
      jobId: "00000000-0000-4000-8000-000000000099",
      failure: { code: "WORKER_TEST", stage: "render" as const, message: "Worker fixture result.", retryable: false },
      warnings: [],
    }));
    const server = createMcpServer({
      attachmentResolver: failClosedResolver(),
      artifactStore,
      theme: { id: "default" } as never,
      executeRender,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "hosted-worker-route-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const arguments_ = {
      plan: {
        version: 1,
        title: "Worker route",
        language: "en",
        themeId: "default",
        sourceDigest: "0".repeat(64),
        slides: [{ id: "cover", title: "Worker route", layout: "cover", imageIds: [] }],
        imageAssetIds: [],
        assetManifest: [],
      },
      sourceFile: { fileName: "source.md", mimeType: "text/markdown", assetId: "stage:source" },
      imageFiles: [],
      imageAssetIds: [],
    };

    const result = await client.callTool({ name: "render_presentation", arguments: arguments_ });

    expect(executeRender).toHaveBeenCalledTimes(1);
    expect(executeRender).toHaveBeenCalledWith(arguments_, expect.any(Function));
    expect(result.structuredContent).toMatchObject({ status: "failed", failure: { code: "WORKER_TEST" } });
    await client.close();
    await server.close();
  });

  it("mounts the Streamable HTTP MCP and opaque artifact routes", async () => {
    const artifactStore = await createStore();
    const app = createApp({
      server: {
        attachmentResolver: failClosedResolver(),
        artifactStore,
        theme: { id: "default" } as never,
      },
    });
    const routePaths = (app as unknown as { router: { stack: Array<{ route?: { path: string } }> } }).router.stack
      .flatMap((layer) => layer.route ? [layer.route.path] : []);
    expect(typeof app).toBe("function");
    expect(routePaths).toContain("/mcp");
    expect(routePaths).toContain("/artifacts/:token");
    expect(typeof startStdioServer).toBe("function");
  });

  it("renders signed CLI-staged refs using canonical deck IDs while rejecting unsupported host refs", async () => {
    const sourceBytes = Buffer.from("# Staged source\n\nThe attachment bridge is signed.\n", "utf8");
    const imageBytes = await sharp({ create: { width: 12, height: 8, channels: 4, background: "#336699" } }).png().toBuffer();
    const sourcePath = join(inputRoot, "source.md");
    const imagePath = join(inputRoot, "diagram.png");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(imagePath, imageBytes);
    const staged = await stageAttachments({ sourcePath, imagePaths: [imagePath] });
    stagedJobIds.push(staged.jobId);

    const deckAssetId = "deck-image-1";
    const plan: PresentationPlan = {
      version: 1,
      title: "Staged attachment integration",
      language: "en",
      themeId: "default",
      sourceDigest: createHash("sha256").update(sourceBytes).digest("hex"),
      slides: [{ id: "slide-1", title: "Received image", layout: "image", imageIds: [deckAssetId], sourceRefs: ["# Staged source"] }],
      imageAssetIds: [deckAssetId],
      assetManifest: [{
        assetId: deckAssetId,
        fileName: staged.imageFiles[0]!.fileName,
        mimeType: "image/png",
        byteLength: imageBytes.byteLength,
        sha256: createHash("sha256").update(imageBytes).digest("hex"),
      }],
    };
    expect(staged.imageAssetIds).toEqual(staged.imageFiles.map((file) => file.assetId));
    expect(staged.imageAssetIds).not.toEqual([deckAssetId]);

    const artifactStore = await createStore();
    const dependencies = await createFailClosedRenderDependencies({ artifactStore });
    await expect(dependencies.attachmentResolver.probeResolver.read(staged.sourceFile)).resolves.toEqual(sourceBytes);
    dependencies.preview = async (): Promise<PreviewReport> => ({
      status: "draft",
      slideCount: 1,
      pdfPageCount: 0,
      pageCount: 0,
      pdfPath: null,
      pngPaths: [],
      contactSheetPath: null,
      font: { requested: dependencies.theme.typography.fontFace, selected: null, substituted: false },
      warnings: [],
      errors: [{ code: "PREVIEW_UNAVAILABLE", stage: "soffice", message: "Preview disabled for this integration test." }],
      visualQaPassed: false,
    });

    const server = createMcpServer(dependencies);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "task7-staged-input-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const validArguments = {
      plan,
      sourceFile: staged.sourceFile,
      imageFiles: staged.imageFiles,
      // The CLI IDs remain on the ProbeFileRefs as read capabilities. Map by order to safe deck IDs here.
      imageAssetIds: [deckAssetId],
    };
    const rendered = await client.callTool({ name: "render_presentation", arguments: validArguments });
    expect(rendered.isError).not.toBe(true);
    expect(rendered.structuredContent).toMatchObject({
      status: "draft",
      slideCount: 1,
      imageUsage: [{ assetId: deckAssetId, fileName: "diagram.png", slideIds: ["slide-1"] }],
    });

    const passedThroughCliIds = await client.callTool({
      name: "render_presentation",
      arguments: { ...validArguments, imageAssetIds: staged.imageAssetIds },
    });
    expect(passedThroughCliIds.isError).toBe(true);

    const hostReference = {
      kind: "host-file",
      fileId: "file_opaque_123",
      fileName: staged.sourceFile.fileName,
      mimeType: staged.sourceFile.mimeType,
      downloadUrl: "https://files.example.test/source.md",
    };
    const unsupported = await client.callTool({
      name: "render_presentation",
      arguments: { ...validArguments, sourceFile: hostReference },
    });
    expect(unsupported.isError).toBe(true);
    expect(unsupported.structuredContent).toMatchObject({ status: "failed", failure: { code: "ATTACHMENT_UNREADABLE", stage: "attachments" } });

    await client.close();
    await server.close();
  });
});
