import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFailClosedRenderDependencies, createMcpServer, type PresentationServerDependencies } from "./server.js";

export async function startStdioServer(dependencies: PresentationServerDependencies): Promise<{ close(): Promise<void> }> {
  const server = createMcpServer(dependencies);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    async close() {
      await server.close();
      await dependencies.artifactStore.close?.();
    },
  };
}

export async function runStdioFromEnvironment(): Promise<void> {
  const dependencies = await createFailClosedRenderDependencies({ outputRoot: process.env.PPTX_OUTPUT_ROOT, enableFontInstallation: true });
  await startStdioServer(dependencies);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStdioFromEnvironment().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unable to start the MarpPPT stdio server.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
