import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AttachmentResolverDeps } from "../attachments/attachment-resolver.js";
import type { Theme } from "../layout/geometry.js";
import { createStagedAttachmentResolver } from "../attachments/staged-resolver.js";
import { createLocalArtifactStore } from "../artifacts/local-artifact-store.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { withRenderJobAdmission } from "./http-admission.js";
import { renderPresentation, RenderPresentationInputSchema, RenderPresentationOutputSchema, type RenderPresentationDependencies } from "./tools/render-presentation.js";

export type PresentationServerDependencies = RenderPresentationDependencies;

export interface McpServerDependencies extends PresentationServerDependencies {
  acquireRenderJob?: () => (() => void) | undefined;
  executeRender?: (
    input: unknown,
    deferReleaseUntil: (pending: Promise<unknown>) => void,
  ) => Promise<Awaited<ReturnType<typeof renderPresentation>>>;
}

export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const server = new McpServer({ name: "marpppt", version: "0.1.0" });
  server.registerTool("render_presentation", {
    title: "Render editable PowerPoint and Marp artifacts",
    description: "Validate authorized Markdown and image attachments, render an editable PPTX and matching Marp source, and return verified artifact references.",
    inputSchema: RenderPresentationInputSchema,
    outputSchema: RenderPresentationOutputSchema,
    annotations: { openWorldHint: false, destructiveHint: false },
  }, async (input) => await withRenderJobAdmission(
    dependencies.acquireRenderJob,
    async (deferReleaseUntil) => {
      const output = dependencies.executeRender
        ? await dependencies.executeRender(input, deferReleaseUntil)
        : await renderPresentation(input, dependencies);
      const text = output.status === "failed"
        ? `${output.failure.code}: ${output.failure.message}`
        : `Presentation ${output.status}: ${output.slideCount} slides. Visual QA passed: false.`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: output as Record<string, unknown>,
        ...(output.status === "failed" ? { isError: true } : {}),
      };
    },
    () => {
      const output = {
        status: "failed" as const,
        jobId: randomUUID(),
        failure: {
          code: "JOB_LIMIT",
          stage: "input" as const,
          message: "The service is at its active rendering job limit.",
          userAction: "Retry after another presentation job finishes.",
          retryable: true,
        },
        warnings: [],
      };
      return {
        content: [{ type: "text" as const, text: "JOB_LIMIT: The service is at its active rendering job limit." }],
        structuredContent: output as Record<string, unknown>,
        isError: true,
      };
    },
  ));
  return server;
}

export interface DefaultServerOptions {
  outputRoot?: string;
  tempRoot?: string;
  artifactStore?: ArtifactStore;
  attachmentResolver?: AttachmentResolverDeps;
}

export async function createFailClosedRenderDependencies(options: DefaultServerOptions = {}): Promise<PresentationServerDependencies> {
  const artifactStore = options.artifactStore ?? await createLocalArtifactStore({ outputRoot: options.outputRoot });
  const themeBytes = await readFile(fileURLToPath(new URL("../../assets/themes/default.json", import.meta.url)));
  const theme = JSON.parse(themeBytes.toString("utf8")) as Theme;
  // Signed local staging refs are the only default read capability. Host-file
  // refs still require an explicitly injected host authorization adapter.
  const attachmentResolver = options.attachmentResolver ?? {
    probeResolver: createStagedAttachmentResolver(),
    ...(options.tempRoot ? { tempRoot: options.tempRoot } : {}),
  };
  return { attachmentResolver, artifactStore, theme };
}
