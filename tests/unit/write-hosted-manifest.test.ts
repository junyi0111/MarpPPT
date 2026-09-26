import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeHostedManifest } from "../../scripts/write-hosted-manifest.js";

const root = resolve(import.meta.dirname, "../..");
const tempRoots: string[] = [];
let releaseDir: string;

beforeEach(async () => {
  releaseDir = await realpath(await mkdtemp(join(tmpdir(), "marpppt-hosted-manifest-")));
  tempRoots.push(releaseDir);
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("hosted manifest generator", () => {
  it.each([
    "http://slides.example.org/mcp",
    "https://slides.example.org/other",
    "https://user:secret@slides.example.org/mcp",
    "https://slides.example.org/mcp?token=secret",
    "https://slides.example.org/mcp#fragment",
    "not-a-url",
  ])("rejects hosted MCP endpoint %s", async (url) => {
    await expect(writeHostedManifest(url, releaseDir)).rejects.toThrow();
  });

  it("writes portable and Codex HTTP configs into release only", async () => {
    const localPortable = await readFile(join(root, "mcp.json"));
    const localCodex = await readFile(join(root, ".mcp.json"));
    const path = await writeHostedManifest("https://slides.example.org/mcp", releaseDir);
    const portable = JSON.parse(await readFile(path, "utf8")) as { mcpServers: { presentation: Record<string, unknown> } };
    const codex = JSON.parse(await readFile(join(releaseDir, ".mcp.json"), "utf8")) as { mcpServers: { presentation: Record<string, unknown> } };

    expect(portable).toMatchObject({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" });
    expect(portable.mcpServers.presentation).toEqual({ type: "streamable-http", url: "https://slides.example.org/mcp" });
    expect(codex.mcpServers.presentation).toEqual({ type: "http", url: "https://slides.example.org/mcp" });
    expect(await readFile(join(root, "mcp.json"))).toEqual(localPortable);
    expect(await readFile(join(root, ".mcp.json"))).toEqual(localCodex);
  });

  it("validates endpoint syntax without making a reachability request", async () => {
    await expect(writeHostedManifest("https://slides.example.org/mcp", releaseDir)).resolves.toBe(join(releaseDir, "mcp.json"));
  });

  it("rejects a release directory reached through a symlinked parent", async () => {
    const target = await realpath(await mkdtemp(join(tmpdir(), "marpppt-release-target-")));
    const aliasParent = await realpath(await mkdtemp(join(tmpdir(), "marpppt-release-alias-")));
    tempRoots.push(target, aliasParent);
    const alias = join(aliasParent, "source-root-alias");
    await symlink(target, alias, "dir");

    await expect(writeHostedManifest("https://slides.example.org/mcp", join(alias, "runtime", "hosted-release")))
      .rejects.toThrow(/symbolic link/u);
    await expect(readFile(join(target, "runtime", "hosted-release", "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
