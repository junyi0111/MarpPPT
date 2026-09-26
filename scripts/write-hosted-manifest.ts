import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export function validateHostedMcpUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("PLUGIN_MCP_URL must be an absolute HTTPS URL ending in /mcp."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/mcp" || url.search || url.hash || url.origin === "null") {
    throw new Error("PLUGIN_MCP_URL must be HTTPS /mcp with no userinfo, query, or fragment.");
  }
  return url.href;
}

async function writeRegularFile(path: string, content: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to replace a non-regular hosted release file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, content, { mode: 0o600 });
}

async function rejectSymlinkPathComponents(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  let current = root;
  for (const component of absolutePath.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Hosted release directory path must not contain symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function writeHostedManifest(url: string, releaseDir: string): Promise<string> {
  const hostedUrl = validateHostedMcpUrl(url);
  const outputDir = resolve(releaseDir);
  const repositoryRoot = await realpath(resolve(import.meta.dirname, ".."));
  if (outputDir === repositoryRoot) {
    throw new Error("Hosted manifests must be written to a separate release directory.");
  }
  await rejectSymlinkPathComponents(outputDir);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(outputDir);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("Hosted release directory must be a real directory, not a symbolic link.");
  }
  const realOutputDir = await realpath(outputDir);
  if (realOutputDir === repositoryRoot || realOutputDir !== outputDir) {
    throw new Error("Hosted release directory must resolve to a separate, non-aliased directory.");
  }
  const portablePath = resolve(outputDir, "mcp.json");
  const codexPath = resolve(outputDir, ".mcp.json");
  const portable = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { presentation: { type: "streamable-http", url: hostedUrl } },
  };
  const codex = { mcpServers: { presentation: { type: "http", url: hostedUrl } } };
  await writeRegularFile(portablePath, `${JSON.stringify(portable, null, 2)}\n`);
  await writeRegularFile(codexPath, `${JSON.stringify(codex, null, 2)}\n`);
  return portablePath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const url = process.env.PLUGIN_MCP_URL;
  if (!url) {
    process.stderr.write("Set PLUGIN_MCP_URL to the selected public HTTPS /mcp endpoint.\n");
    process.exitCode = 1;
  } else {
    const releaseDir = resolve(process.env.MARPPPT_RELEASE_DIR ?? "runtime/hosted-release");
    writeHostedManifest(url, releaseDir)
      .then((path) => process.stdout.write(`Hosted portable manifest: ${path}\n`))
      .catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
