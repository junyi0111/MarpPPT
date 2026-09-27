import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { validatePackage, type PackageProfile } from "./validate-package.js";
import { writeHostedManifest } from "./write-hosted-manifest.js";

const FILES = [
  "plugin.json", "mcp.json", ".codex-plugin/plugin.json", ".mcp.json",
  "package.json", "package-lock.json", "README.md", "README.zh-TW.md", "LICENSE",
  "scripts/validate-package.ts", "scripts/package-plugin.ts", "scripts/write-hosted-manifest.ts", "scripts/extract-pdf-reference.mjs", "scripts/preflight.mjs", "scripts/update-codex-macos.sh",
] as const;
const DIRECTORIES = ["skills", "assets", "dist", "docs/operations"] as const;
const ARCHIVE_MTIME = new Date(2000, 0, 1, 0, 0, 0);

export interface PackagePluginOptions {
  root?: string;
  profile: "local" | "hosted";
  hostedMcpUrl?: string;
  outputPath?: string;
}

async function validateArchive(bytes: Uint8Array, profile: PackageProfile): Promise<void> {
  const validationRoot = await mkdtemp(join(tmpdir(), "marpppt-archive-validation-"));
  try {
    const files = unzipSync(bytes);
    for (const [path, content] of Object.entries(files)) {
      if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) {
        throw new Error(`Generated archive contains an unsafe path: ${path}`);
      }
      const destination = join(validationRoot, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, content, { mode: 0o600 });
    }
    await validatePackage(validationRoot, profile);
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

function excluded(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some((part) => part.toLowerCase().startsWith(".env")
    || ["node_modules", ".DS_Store", "runtime", "coverage", "tests", "src"].includes(part))
    || relativePath.startsWith("dist/probe/")
    || relativePath.endsWith("~");
}

function withinRoot(realRoot: string, target: string): boolean {
  const delta = relative(realRoot, target);
  return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

async function checkedPath(root: string, realRoot: string, relativePath: string, expected?: "file" | "directory"): Promise<string> {
  const components = relativePath.split("/");
  if (components.length === 0 || components.some((component) => !component || component === "." || component === ".." || component.includes("\\"))) {
    throw new Error(`Invalid package input path: ${relativePath}`);
  }
  let current = root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Package input is a symbolic link: ${relativePath}`);
    if (index < components.length - 1 && !info.isDirectory()) throw new Error(`Package input has a non-directory parent: ${relativePath}`);
    if (!withinRoot(realRoot, await realpath(current))) throw new Error(`Package input escapes the package root: ${relativePath}`);
    if (index === components.length - 1 && expected && !(expected === "file" ? info.isFile() : info.isDirectory())) {
      throw new Error(`Package input is not a ${expected}: ${relativePath}`);
    }
  }
  return current;
}

async function collect(directoryPath: string, root: string, realRoot: string, selected: string[]): Promise<void> {
  const directory = await checkedPath(root, realRoot, directoryPath, "directory");
  for (const entry of (await readdir(directory)).sort()) {
    const relativePath = `${directoryPath}/${entry}`;
    if (excluded(relativePath)) continue;
    const fullPath = await checkedPath(root, realRoot, relativePath);
    const info = await lstat(fullPath);
    if (info.isDirectory()) await collect(relativePath, root, realRoot, selected);
    else if (info.isFile()) selected.push(relativePath);
    else throw new Error(`Package input is not a regular file: ${relativePath}`);
  }
}

export async function packagePlugin(options: PackagePluginOptions): Promise<string> {
  if (options.profile === "hosted" && !options.hostedMcpUrl) {
    throw new Error("Set PLUGIN_MCP_URL to the selected public HTTPS /mcp endpoint before packaging a hosted profile.");
  }
  const root = resolve(options.root ?? resolve(import.meta.dirname, ".."));
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Package root must be a real directory, not a symbolic link");
  const realRoot = await realpath(root);
  for (const path of FILES) await checkedPath(root, realRoot, path, "file");
  for (const path of DIRECTORIES) await checkedPath(root, realRoot, path, "directory");
  await validatePackage(root);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  const profileName = options.profile === "hosted" ? "hosted" : "local";
  const outputPath = resolve(options.outputPath ?? join(root, "runtime", `marpppt-${manifest.version}-${profileName}-candidate.zip`));
  const paths: string[] = [...FILES];
  let releaseDirectory: string | undefined;
  try {
    const manifestOverrides = new Map<string, Uint8Array>();
    if (options.profile === "hosted") {
      releaseDirectory = await realpath(await mkdtemp(join(tmpdir(), "marpppt-hosted-package-")));
      await writeHostedManifest(options.hostedMcpUrl!, releaseDirectory);
      manifestOverrides.set("mcp.json", await readFile(join(releaseDirectory, "mcp.json")));
      manifestOverrides.set(".mcp.json", await readFile(join(releaseDirectory, ".mcp.json")));
    }
    for (const directory of DIRECTORIES) await collect(directory, root, realRoot, paths);
    const entries: Zippable = Object.create(null) as Zippable;
    for (const path of paths.sort()) {
      const fullPath = await checkedPath(root, realRoot, path, "file");
      entries[path] = [manifestOverrides.get(path) ?? await readFile(fullPath), { mtime: ARCHIVE_MTIME }];
    }
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const archiveBytes = zipSync(entries, { level: 6 });
    await validateArchive(archiveBytes, options.profile);
    await writeFile(outputPath, archiveBytes, { mode: 0o600 });
    return outputPath;
  } finally {
    if (releaseDirectory) await rm(releaseDirectory, { recursive: true, force: true });
  }
}

function cliOptions(argv: string[]): PackagePluginOptions {
  let profile: "local" | "hosted" | undefined;
  let hostedMcpUrl: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--profile" && (value === "local" || value === "hosted")) profile = value;
    else if (flag === "--mcp-url") hostedMcpUrl = value;
    else if (flag === "--output") outputPath = value;
    else throw new Error(`Unsupported package option: ${flag} ${value}`);
  }
  if (!profile) throw new Error("Specify --profile local or --profile hosted");
  const selectedUrl = hostedMcpUrl ?? process.env.PLUGIN_MCP_URL;
  if (profile === "hosted" && !selectedUrl) throw new Error("Set PLUGIN_MCP_URL to the selected public HTTPS /mcp endpoint.");
  if (profile === "local" && selectedUrl) throw new Error("--mcp-url and PLUGIN_MCP_URL apply only to the hosted profile.");
  return {
    profile,
    ...(selectedUrl ? { hostedMcpUrl: selectedUrl } : {}),
    ...(outputPath ? { outputPath } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packagePlugin(cliOptions(process.argv.slice(2)))
    .then((path) => process.stdout.write(`${cliOptions(process.argv.slice(2)).profile} candidate package: ${path}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
