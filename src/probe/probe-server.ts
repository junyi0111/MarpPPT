import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { probeAttachments } from "./attachment-probe.js";
import { createProbeResolver } from "./probe-resolver.js";
import { cleanExpiredStagedJobs } from "./local-attachment-stage.js";

const fileRefSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  assetId: z.string().optional(),
}).strict();

const server = new McpServer({ name: "presentation-probe", version: "0.1.0" });

server.registerTool(
  "probe_attachments",
  {
    description: "Development-only check of conversation attachment bytes and PPTX artifact delivery",
    inputSchema: {
      sourceFile: fileRefSchema,
      imageFiles: z.array(fileRefSchema),
      imageAssetIds: z.array(z.string()),
    },
  },
  async ({ sourceFile, imageFiles, imageAssetIds }) => {
    if (imageFiles.length !== imageAssetIds.length) {
      throw new Error("imageFiles and imageAssetIds must have the same length");
    }
    const report = await probeAttachments(
      {
        sourceFile,
        imageFiles: imageFiles.map((file, index) => ({
          ...file,
          assetId: imageAssetIds[index],
        })),
      },
      createProbeResolver({ fixtureMode: process.env.PRESENTATION_PROBE_TEST_FIXTURES === "1" }),
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(report) },
        {
          type: "resource_link" as const,
          uri: report.sampleArtifactUri,
          name: "attachment-probe-sample.pptx",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      ],
      structuredContent: { ...report },
    };
  },
);

await cleanExpiredStagedJobs();
setInterval(() => {
  void cleanExpiredStagedJobs().catch(() => console.error("Attachment staging cleanup failed"));
}, 60_000).unref();
await server.connect(new StdioServerTransport());
