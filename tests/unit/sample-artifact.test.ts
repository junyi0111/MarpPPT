import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_RETENTION_MS, createSampleArtifact } from "../../src/probe/sample-artifact.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sample-artifact-test-"));
  roots.push(root);
  return root;
}

describe("sample artifact retention", () => {
  it("keeps a per-job artifact readable until its retention timer expires", async () => {
    const root = await newRoot();
    const uri = await createSampleArtifact(
      async (path) => writeFile(path, "sample pptx"),
      { root, retentionMs: 500 },
    );
    const path = fileURLToPath(uri);
    expect(await readFile(path, "utf8")).toBe("sample pptx");
    expect(await readdir(root)).toHaveLength(1);
    expect(ARTIFACT_RETENTION_MS).toBe(30 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(path, "utf8")).toBe("sample pptx");
    await vi.waitFor(async () => expect(await readdir(root)).toEqual([]), {
      timeout: 2500,
      interval: 30,
    });
  });

  it("removes the isolated job directory when artifact writing fails", async () => {
    const root = await newRoot();
    await expect(createSampleArtifact(async (path) => {
      await writeFile(path, "partial");
      throw new Error("write failed");
    }, { root, retentionMs: 30 * 60 * 1000 })).rejects.toThrow("write failed");
    expect(await readdir(root)).toEqual([]);
  });

  it("removes an artifact after retention even when its creating process exits", async () => {
    const root = await newRoot();
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [
      "--import", "tsx", "tests/helpers/create-short-lived-artifact.ts", root,
    ], { cwd: process.cwd() });
    const path = fileURLToPath(stdout.trim());
    expect(await readFile(path, "utf8")).toBe("sample pptx");
    await vi.waitFor(async () => expect(await readdir(root)).toEqual([]), {
      timeout: 2500,
      interval: 30,
    });
  });
});
