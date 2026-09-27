import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AttachmentResolverDeps } from "../attachments/attachment-resolver.js";
import type { Theme } from "../layout/geometry.js";
import { createFontThemeCatalog } from "../theme/font-presets.js";
import { createFontInstaller, type FontInstaller, type FontInstallReport } from "../theme/font-installer.js";
import { createStagedAttachmentResolver } from "../attachments/staged-resolver.js";
import { createLocalArtifactStore } from "../artifacts/local-artifact-store.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { withRenderJobAdmission } from "./http-admission.js";
import { renderPresentation, RenderPresentationInputSchema, RenderPresentationOutputSchema, type RenderPresentationDependencies } from "./tools/render-presentation.js";

export type PresentationServerDependencies = RenderPresentationDependencies & {
  fontInstaller?: FontInstaller;
};

export interface McpServerDependencies extends PresentationServerDependencies {
  acquireRenderJob?: () => (() => void) | undefined;
  executeRender?: (
    input: unknown,
    deferReleaseUntil: (pending: Promise<unknown>) => void,
  ) => Promise<Awaited<ReturnType<typeof renderPresentation>>>;
}

export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const server = new McpServer({ name: "marpppt", version: "0.2.1" });
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
  if (dependencies.fontInstaller) {
    const ensureFontInputSchema = z.object({
      themeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
      installIfMissing: z.boolean().default(false),
    }).strict();
    const ensureFontOutputSchema = z.object({
      status: z.enum(["available", "installed", "missing", "unsupported", "failed"]),
      themeId: z.string(),
      family: z.string(),
      platform: z.string(),
      installDirectory: z.string().nullable(),
      files: z.array(z.string()),
      matched: z.string().nullable(),
      verified: z.boolean(),
      message: z.string(),
      userAction: z.string().optional(),
      error: z.string().optional(),
    }).strict();
    server.registerTool("ensure_font", {
      title: "Check and install a local presentation font",
      description: "Check whether the selected MarpPPT font family is available. In local stdio mode, install it into the current user's font directory from the official source URL when installIfMissing is true, then verify the family.",
      inputSchema: ensureFontInputSchema,
      outputSchema: ensureFontOutputSchema,
      annotations: { openWorldHint: true, destructiveHint: true },
    }, async (input) => {
      let output: FontInstallReport | (Omit<FontInstallReport, "status"> & { status: "failed"; error: string });
      try {
        output = await dependencies.fontInstaller!.ensure(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Font installation failed.";
        output = {
          status: "failed",
          themeId: input.themeId,
          family: "unknown",
          platform: process.platform,
          installDirectory: null,
          files: [],
          matched: null,
          verified: false,
          message,
          error: message,
          userAction: "確認網路、官方字體來源與本機字體目錄權限後重試。",
        };
      }
      const failed = output.status === "failed" || output.status === "missing" || output.status === "unsupported" || !output.verified;
      return {
        content: [{ type: "text" as const, text: output.message }],
        structuredContent: output as Record<string, unknown>,
        ...(failed ? { isError: true } : {}),
      };
    });
  }
  return server;
}

export interface DefaultServerOptions {
  outputRoot?: string;
  tempRoot?: string;
  artifactStore?: ArtifactStore;
  attachmentResolver?: AttachmentResolverDeps;
  enableFontInstallation?: boolean;
}

export async function createFailClosedRenderDependencies(options: DefaultServerOptions = {}): Promise<PresentationServerDependencies> {
  const artifactStore = options.artifactStore ?? await createLocalArtifactStore({ outputRoot: options.outputRoot });
  const themeBytes = await readFile(fileURLToPath(new URL("../../assets/themes/default.json", import.meta.url)));
  const theme = JSON.parse(themeBytes.toString("utf8")) as Theme;
  const themes = createFontThemeCatalog(theme);
  // Signed local staging refs are the only default read capability. Host-file
  // refs still require an explicitly injected host authorization adapter.
  const attachmentResolver = options.attachmentResolver ?? {
    probeResolver: createStagedAttachmentResolver(),
    ...(options.tempRoot ? { tempRoot: options.tempRoot } : {}),
  };
  return {
    attachmentResolver,
    artifactStore,
    theme,
    themes,
    ...(options.enableFontInstallation ? { fontInstaller: createFontInstaller() } : {}),
  };
}
