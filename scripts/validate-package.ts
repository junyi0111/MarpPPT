import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validateHostedMcpUrl } from "./write-hosted-manifest.js";

type JsonObject = Record<string, unknown>;
const ID = "markdown-to-editable-pptx";
const SERVER_ID = "presentation";
const SERVER_ARGS = ["${PLUGIN_ROOT}/dist/mcp/stdio.js"];
export type PackageProfile = "local" | "hosted";

function object(value: unknown, where: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as JsonObject;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`);
  return value;
}

async function json(path: string): Promise<JsonObject> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch { throw new Error(`Missing manifest: ${path}`); }
  try { return object(JSON.parse(raw), path); }
  catch (error) { throw new Error(`Invalid JSON manifest ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function inside(root: string, value: unknown, where: string, kind: "file" | "directory"): Promise<string> {
  const path = string(value, where);
  if (!path.startsWith("./") || isAbsolute(path) || path.includes("\\") || path.split("/").includes("..") || path.includes("${")) {
    throw new Error(`${where} must be a relative path inside the plugin root`);
  }
  const resolved = resolve(root, path);
  const rootReal = await realpath(root);
  const targetReal = await realpath(resolved);
  const delta = relative(rootReal, targetReal);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error(`${where} escapes the plugin root`);
  const info = await stat(targetReal);
  if (kind === "file" && !info.isFile() || kind === "directory" && !info.isDirectory()) {
    throw new Error(`${where} must point to a ${kind}`);
  }
  return targetReal;
}

function validateServer(config: JsonObject, where: string, portable: boolean, profile: PackageProfile): void {
  const servers = object(config.mcpServers, `${where}.mcpServers`);
  const ids = Object.keys(servers);
  if (ids.length !== 1 || ids[0] !== SERVER_ID) throw new Error(`${where} must declare only the ${SERVER_ID} MCP server`);
  const server = object(servers[SERVER_ID], `${where}.${SERVER_ID}`);
  if (profile === "hosted") {
    const expectedType = portable ? "streamable-http" : "http";
    let normalizedUrl: string;
    try { normalizedUrl = validateHostedMcpUrl(string(server.url, `${where}.url`)); }
    catch { throw new Error(`${where} must use a syntactically valid HTTPS /mcp endpoint.`); }
    if (server.type !== expectedType || server.url !== normalizedUrl || Object.keys(server).sort().join(",") !== "type,url") {
      throw new Error(`${where} must use the ${expectedType} hosted transport with only type and url.`);
    }
    return;
  }
  if (portable) {
    if (server.type !== "stdio") throw new Error(`${where} must use stdio transport`);
  } else if (server.type !== undefined && server.type !== "stdio") {
    throw new Error(`${where} must use stdio transport`);
  }
  if (server.url !== undefined || server.endpoint !== undefined || server.command !== "node" || server.cwd !== "${PLUGIN_ROOT}" ||
      JSON.stringify(server.args) !== JSON.stringify(SERVER_ARGS)) {
    throw new Error(`${where} must launch the production stdio server from PLUGIN_ROOT`);
  }
}

export async function validatePackage(root = resolve(import.meta.dirname, ".."), profile: PackageProfile = "local"): Promise<void> {
  const packageMetadata = await json(resolve(root, "package.json"));
  const packageScripts = object(packageMetadata.scripts, "package scripts");
  if (packageScripts["stage:attachments"] !== "node dist/attachments/local-attachment-stage.js") {
    throw new Error("Local staging must launch the packaged production JavaScript entrypoint");
  }
  const portable = await json(resolve(root, "plugin.json"));
  const codex = await json(resolve(root, ".codex-plugin/plugin.json"));
  if (portable.name !== ID || codex.name !== ID || portable.version !== codex.version || portable.version !== "0.1.0") {
    throw new Error("Portable and Codex manifests must share the stable package ID and version");
  }
  const codexInterface = object(codex.interface, "Codex plugin interface");
  if (codexInterface.displayName !== "MarpPPT") throw new Error("Plugin display name must be MarpPPT");
  if (portable.skills !== "./skills/" || codex.skills !== "./skills/") {
    throw new Error("Both manifests must point to the packaged skills directory");
  }
  await inside(root, portable.skills, "portable.skills", "directory");
  await inside(root, codex.skills, "codex.skills", "directory");
  const portableMcp = await inside(root, portable.mcpServers, "portable.mcpServers", "file");
  const codexMcp = await inside(root, codex.mcpServers, "codex.mcpServers", "file");
  const rootReal = await realpath(root);
  if (relative(rootReal, portableMcp) !== "mcp.json" || relative(rootReal, codexMcp) !== ".mcp.json") {
    throw new Error("Each runtime mode must use its own MCP manifest");
  }
  const portableConfig = await json(portableMcp);
  if (profile === "hosted" && portableConfig.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json") {
    throw new Error("Hosted portable MCP manifest must include the supported schema URI.");
  }
  validateServer(portableConfig, "portable MCP", true, profile);
  validateServer(await json(codexMcp), "Codex MCP", false, profile);
  const skill = await inside(root, "./skills/marp-ppt/SKILL.md", "MarpPPT skill", "file");
  const skillText = await readFile(skill, "utf8");
  if (!/^---\nname: marp-ppt\n/mu.test(skillText)) throw new Error("MarpPPT skill frontmatter has the wrong name");
  const metadata = await inside(root, "./skills/marp-ppt/agents/openai.yaml", "Skill UI metadata", "file");
  const metadataText = await readFile(metadata, "utf8");
  const shortDescription = metadataText.match(/^\s*short_description:\s*["']([^"']+)["']\s*$/mu)?.[1];
  if (!/^\s*display_name:\s*["']?MarpPPT["']?\s*$/mu.test(metadataText) ||
      !shortDescription || Array.from(shortDescription).length < 25 || Array.from(shortDescription).length > 64 ||
      !/\$marp-ppt/u.test(metadataText) || !/^\s*allow_implicit_invocation:\s*true\s*$/mu.test(metadataText)) {
    throw new Error("Skill UI metadata must expose MarpPPT with implicit and explicit invocation");
  }
  await inside(root, "./dist/mcp/stdio.js", "built MCP entrypoint", "file");
  await inside(root, "./dist/mcp/http-render-worker-child.js", "built isolated HTTP render worker entrypoint", "file");
  await inside(root, "./dist/attachments/local-attachment-stage.js", "built attachment staging CLI", "file");
  await inside(root, "./dist/attachments/staged-resolver.js", "built staged attachment resolver", "file");
  await inside(root, "./scripts/write-hosted-manifest.ts", "hosted manifest generator", "file");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  validatePackage(resolve(process.argv[2] ?? resolve(import.meta.dirname, "..")))
    .then(() => process.stdout.write("Package manifests and Skill paths are valid.\n"))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
