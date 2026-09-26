import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const useManifestCommand = process.env.PROBE_SERVER_LAUNCH === "manifest";
const serverCommand = useManifestCommand ? "npx" : process.execPath;
const serverArgs = useManifestCommand
  ? ["tsx", "src/probe/probe-server.ts"]
  : ["--import", "tsx", "src/probe/probe-server.ts"];
const client = new Client({ name: "probe-smoke-client", version: "0.1.0" });
try {
  const markdown = new TextEncoder().encode("title: Deck\n");
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

  await client.connect(new StdioClientTransport({
    command: serverCommand,
    args: serverArgs,
    cwd: process.cwd(),
    env: { ...process.env, PRESENTATION_PROBE_TEST_FIXTURES: "1" } as Record<string, string>,
  }));
  const { tools } = await client.listTools();
  assert(tools.some((tool) => tool.name === "probe_attachments"));
  const result = await client.callTool({
    name: "probe_attachments",
    arguments: {
      sourceFile: { fileName: "source.md", mimeType: "text/markdown", assetId: "fixture:source-md" },
      imageFiles: [{ fileName: "photo.png", mimeType: "image/png" }],
      imageAssetIds: ["fixture:photo-png"],
    },
  });
  assert.equal(result.isError, undefined);
  const report = result.structuredContent as {
    files: Array<{ fileName: string; mimeType: string; byteLength: number; sha256: string }>;
    sampleArtifactUri: string;
  };
  assert.deepEqual(report.files, [
    {
      fileName: "source.md",
      mimeType: "text/markdown",
      byteLength: 12,
      sha256: createHash("sha256").update(markdown).digest("hex"),
    },
    {
      fileName: "photo.png",
      mimeType: "image/png",
      byteLength: 8,
      sha256: createHash("sha256").update(png).digest("hex"),
    },
  ]);
  const output = JSON.stringify(result);
  assert(!output.includes("title: Deck"));
  assert(!output.includes("/etc/passwd"));
  assert(result.content.some((item) => item.type === "resource_link" && item.uri === report.sampleArtifactUri));
  const pptx = await readFile(fileURLToPath(report.sampleArtifactUri));
  assert.equal(pptx.subarray(0, 2).toString(), "PK");
  const forbidden = await client.callTool({
    name: "probe_attachments",
    arguments: {
      sourceFile: { fileName: "source.md", mimeType: "text/markdown", path: "/etc/passwd" },
      imageFiles: [],
      imageAssetIds: [],
    },
  });
  assert.equal(forbidden.isError, true);
} finally {
  await client.close();
}

const defaultClient = new Client({ name: "probe-default-client", version: "0.1.0" });
try {
  await defaultClient.connect(new StdioClientTransport({
    command: serverCommand,
    args: serverArgs,
    cwd: process.cwd(),
    env: { ...process.env, PRESENTATION_PROBE_TEST_FIXTURES: "0" } as Record<string, string>,
  }));
  const denied = await defaultClient.callTool({
    name: "probe_attachments",
    arguments: {
      sourceFile: { fileName: "source.md", mimeType: "text/markdown", assetId: "fixture:source-md" },
      imageFiles: [],
      imageAssetIds: [],
    },
  });
  assert.equal(denied.isError, true);
  assert(JSON.stringify(denied).includes("Host-authorized attachment access is unavailable"));
} finally {
  await defaultClient.close();
}
console.log("MCP local probe passed: fixed fixtures, default refusal, path refusal, metadata-only report and PPTX ZIP artifact.");
