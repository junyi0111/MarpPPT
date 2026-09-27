import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, expect, it } from "vitest";
import { packagePlugin } from "../../scripts/package-plugin.js";
import { validatePackage } from "../../scripts/validate-package.js";

const root = resolve(import.meta.dirname, "../..");
const tempRoots: string[] = [];

async function clonedPackageRoot(): Promise<string> {
  const cloneRoot = await mkdtemp(join(tmpdir(), "marpppt-package-clone-"));
  tempRoots.push(cloneRoot);
  for (const path of [
    "plugin.json", "mcp.json", ".codex-plugin/plugin.json", ".mcp.json",
    "package.json", "package-lock.json", "README.md", "README.zh-TW.md", "LICENSE",
    "scripts/validate-package.ts", "scripts/package-plugin.ts", "scripts/write-hosted-manifest.ts",
    "scripts/extract-pdf-reference.mjs", "scripts/preflight.mjs", "scripts/update-codex-macos.sh",
    "skills", "assets", "dist", "docs/operations",
  ]) {
    const target = join(cloneRoot, path);
    await mkdir(join(target, ".."), { recursive: true });
    await cp(join(root, path), target, { recursive: true });
  }
  return cloneRoot;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("creates a deterministic local candidate ZIP with only runtime and validation files", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "marpppt-package-test-"));
  tempRoots.push(outputRoot);
  const first = await packagePlugin({ root, profile: "local", outputPath: join(outputRoot, "first.zip") });
  const second = await packagePlugin({ root, profile: "local", outputPath: join(outputRoot, "second.zip") });
  const archiveBytes = await readFile(first);
  expect(archiveBytes).toEqual(await readFile(second));
  expect(archiveBytes.readUInt16LE(10)).toBe(0); // fixed DOS time, independent of build clock
  expect(archiveBytes.readUInt16LE(12)).toBe(0x2821); // 2000-01-01
  const files = unzipSync(archiveBytes);
  const paths = Object.keys(files);
  for (const required of [
    "plugin.json", ".codex-plugin/plugin.json", "mcp.json", ".mcp.json",
    "package.json", "package-lock.json", "skills/marp-ppt/SKILL.md",
    "assets/themes/default.json", "dist/mcp/stdio.js", "dist/attachments/local-attachment-stage.js",
    "dist/mcp/http-render-worker-child.js", "dist/attachments/staged-resolver.js", "scripts/validate-package.ts",
    "scripts/write-hosted-manifest.ts",
    "scripts/preflight.mjs",
    "scripts/update-codex-macos.sh",
    "dist/pptx/pptxgenjs-compat.js",
  ]) expect(paths).toContain(required);
  expect(JSON.parse(new TextDecoder().decode(files["package.json"]!)).scripts["stage:attachments"])
    .toBe("node dist/attachments/local-attachment-stage.js");
  expect(paths.some((path) => path === ".env" || path.startsWith("src/probe/") || path.startsWith("dist/probe/")
    || path.startsWith("tests/") || path.startsWith("node_modules/") || path.startsWith("runtime/")
    || path.includes(".DS_Store") || path.endsWith("~"))).toBe(false);
  const extracted = await mkdtemp(join(tmpdir(), "marpppt-package-extract-"));
  tempRoots.push(extracted);
  const { writeFile, mkdir } = await import("node:fs/promises");
  for (const [relativePath, bytes] of Object.entries(files)) {
    await mkdir(join(extracted, relativePath, ".."), { recursive: true });
    await writeFile(join(extracted, relativePath), bytes);
  }
  await expect(validatePackage(extracted)).resolves.toBeUndefined();
});

it("rejects a package missing the isolated HTTP render worker entrypoint", async () => {
  const cloneRoot = await clonedPackageRoot();
  await rm(join(cloneRoot, "dist/mcp/http-render-worker-child.js"));

  await expect(validatePackage(cloneRoot)).rejects.toThrow(/http-render-worker-child\.js/u);
});

it("does not package environment-file variants from selected directories", async () => {
  const cloneRoot = await clonedPackageRoot();
  await writeFile(join(cloneRoot, "assets", ".env.local"), "SECRET_TEST_ONLY=do-not-package\n");
  const archive = await packagePlugin({ root: cloneRoot, profile: "local" });
  const files = unzipSync(await readFile(archive));
  expect(Object.keys(files)).not.toContain("assets/.env.local");
  expect(JSON.stringify(Object.keys(files))).not.toContain(".env.local");
});

it.each(["assets", "docs/operations"])("rejects a symlinked selected directory at %s", async (selected) => {
  const cloneRoot = await clonedPackageRoot();
  const external = await mkdtemp(join(tmpdir(), "marpppt-package-external-"));
  tempRoots.push(external);
  await cp(join(cloneRoot, selected), external, { recursive: true });
  await rm(join(cloneRoot, selected), { recursive: true });
  await symlink(external, join(cloneRoot, selected), "dir");
  await expect(packagePlugin({ root: cloneRoot, profile: "local" })).rejects.toThrow(/symbolic link|outside|escapes/u);
});

it("rejects a symlinked package root", async () => {
  const cloneRoot = await clonedPackageRoot();
  const linkParent = await mkdtemp(join(tmpdir(), "marpppt-package-root-link-"));
  tempRoots.push(linkParent);
  const linkedRoot = join(linkParent, "candidate");
  await symlink(cloneRoot, linkedRoot, "dir");
  await expect(packagePlugin({ root: linkedRoot, profile: "local" })).rejects.toThrow(/symbolic link/u);
});

it("overlays hosted manifests into an isolated candidate ZIP and preserves local source manifests", async () => {
  const cloneRoot = await clonedPackageRoot();
  const outputRoot = await mkdtemp(join(tmpdir(), "marpppt-hosted-package-"));
  tempRoots.push(outputRoot);
  const localPortable = await readFile(join(cloneRoot, "mcp.json"));
  const localCodex = await readFile(join(cloneRoot, ".mcp.json"));
  const archive = await packagePlugin({
    root: cloneRoot,
    profile: "hosted",
    hostedMcpUrl: "https://slides.example.org/mcp",
    outputPath: join(outputRoot, "hosted-candidate.zip"),
  });
  const files = unzipSync(await readFile(archive));
  const portable = JSON.parse(new TextDecoder().decode(files["mcp.json"]!)) as { mcpServers: { presentation: Record<string, unknown> } };
  const codex = JSON.parse(new TextDecoder().decode(files[".mcp.json"]!)) as { mcpServers: { presentation: Record<string, unknown> } };

  expect(portable).toMatchObject({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" });
  expect(portable.mcpServers.presentation).toEqual({ type: "streamable-http", url: "https://slides.example.org/mcp" });
  expect(codex.mcpServers.presentation).toEqual({ type: "http", url: "https://slides.example.org/mcp" });
  expect(await readFile(join(cloneRoot, "mcp.json"))).toEqual(localPortable);
  expect(await readFile(join(cloneRoot, ".mcp.json"))).toEqual(localCodex);

  const extracted = await mkdtemp(join(tmpdir(), "marpppt-hosted-extract-"));
  tempRoots.push(extracted);
  for (const [relativePath, bytes] of Object.entries(files)) {
    await mkdir(join(extracted, relativePath, ".."), { recursive: true });
    await writeFile(join(extracted, relativePath), bytes);
  }
  await expect(validatePackage(extracted, "hosted")).resolves.toBeUndefined();
});
