import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { createFontInstaller, type FontInstallerDependencies } from "../../src/theme/font-installer.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fontBytes(kind: "ttf" | "otf" = "ttf"): Uint8Array {
  return new Uint8Array(kind === "otf" ? [0x4f, 0x54, 0x54, 0x4f, 1, 2, 3] : [0, 1, 0, 0, 1, 2, 3]);
}

function deps(overrides: Partial<FontInstallerDependencies> = {}): FontInstallerDependencies {
  return {
    platform: "linux",
    homeDir: "/home/tester",
    fontDirectory: "/tmp/marpppt-fonts",
    matchFont: async () => null,
    fetch: async () => new Response(fontBytes(), { status: 200 }),
    ...overrides,
  };
}

describe("font installer", () => {
  it("reports an available requested family without downloading anything", async () => {
    const calls: string[] = [];
    const installer = createFontInstaller(deps({
      matchFont: async (family) => {
        calls.push(family);
        return family;
      },
      fetch: async () => { throw new Error("must not download"); },
    }));

    await expect(installer.ensure({ themeId: "default", installIfMissing: true })).resolves.toMatchObject({
      status: "available",
      family: "Noto Sans CJK TC",
      matched: "Noto Sans CJK TC",
    });
    expect(calls).toEqual(["Noto Sans CJK TC"]);
  });

  it("installs a missing font into the user directory and verifies it", async () => {
    const root = await mkdtemp(join(tmpdir(), "marpppt-font-install-"));
    tempRoots.push(root);
    const family = "Noto Sans CJK TC";
    let installed = false;
    const installer = createFontInstaller(deps({
      fontDirectory: root,
      matchFont: async (requested) => installed && requested === family ? family : null,
      fetch: async () => new Response(fontBytes(), { status: 200 }),
      refreshFontCache: async () => { installed = true; },
    }));

    const result = await installer.ensure({ themeId: "default", installIfMissing: true });
    expect(result.status).toBe("installed");
    expect(result.files).toEqual(["NotoSansTC-variable.ttf"]);
    expect(await readFile(join(root, "NotoSansTC-variable.ttf"))).toEqual(Buffer.from(fontBytes()));
  });

  it("extracts only font files from an official archive and never installs when consent is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "marpppt-font-archive-"));
    tempRoots.push(root);
    const archive = zipSync({
      "SourceHanSerifTC-Regular.otf": fontBytes("otf"),
      "README.txt": new TextEncoder().encode("license"),
      "nested/SourceHanSerifTC-Bold.otf": fontBytes("otf"),
    });
    let downloaded = 0;
    const installer = createFontInstaller(deps({
      fontDirectory: root,
      matchFont: async () => null,
      fetch: async () => { downloaded += 1; return new Response(archive, { status: 200, headers: { "content-type": "application/zip" } }); },
    }));

    await expect(installer.ensure({ themeId: "default-source-serif", installIfMissing: false })).resolves.toMatchObject({ status: "missing" });
    expect(downloaded).toBe(0);
    const result = await installer.ensure({ themeId: "default-source-serif", installIfMissing: true });
    expect(result.status).toBe("installed");
    expect(result.files).toEqual(["SourceHanSerifTC-Bold.otf", "SourceHanSerifTC-Regular.otf"]);
    expect(downloaded).toBe(1);
  });

  it("rejects unknown themes and untrusted download hosts", async () => {
    const installer = createFontInstaller(deps({ fetch: async () => new Response(fontBytes(), { status: 200 }) }));
    await expect(installer.ensure({ themeId: "nope", installIfMissing: true })).rejects.toThrow("UNSUPPORTED_FONT_PRESET");
    const unsafe = createFontInstaller(deps({
      fontDirectory: "/tmp/marpppt-fonts",
      fetch: async () => new Response(fontBytes(), { status: 200 }),
      downloadHostAllowlist: new Set(["example.invalid"]),
    }));
    await expect(unsafe.ensure({ themeId: "default", installIfMissing: true })).rejects.toThrow("FONT_DOWNLOAD_HOST_NOT_ALLOWED");
  });
});
