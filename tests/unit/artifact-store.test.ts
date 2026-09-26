import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpArtifactStore } from "../../src/artifacts/http-artifact-store.js";
import { createLocalArtifactStore } from "../../src/artifacts/local-artifact-store.js";

const pptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("artifact stores", () => {
  let outputRoot: string;

  beforeEach(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), "marpppt-artifact-test-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(outputRoot, { recursive: true, force: true });
  });

  it("writes local output only below its configured root and marks it non-expiring", async () => {
    const store = await createLocalArtifactStore({ outputRoot });
    const jobId = randomUUID();
    const ref = await store.put(jobId, "deck.pptx", pptxMime, new Uint8Array([1, 2, 3]));
    const savedPath = fileURLToPath(ref.uri);

    expect(savedPath.startsWith(`${await realpath(outputRoot)}/`)).toBe(true);
    expect(await readFile(savedPath)).toEqual(Buffer.from([1, 2, 3]));
    expect(ref.expiresAt).toBeNull();
    await store.close?.();
  });

  it("rejects traversal job IDs and filenames without writing outside the root", async () => {
    const store = await createLocalArtifactStore({ outputRoot });
    await expect(store.put("../../outside", "../deck.pptx", pptxMime, new Uint8Array([1])))
      .rejects.toMatchObject({ code: "ARTIFACT_INVALID_NAME" });

    let outsideExists = true;
    try {
      await access(join(outputRoot, "..", "deck.pptx"));
    } catch {
      outsideExists = false;
    }
    expect(outsideExists).toBe(false);
  });

  it("expires opaque HTTP tokens after 30 minutes while leaving persistent output intact", async () => {
    vi.useFakeTimers();
    const localStore = await createLocalArtifactStore({ outputRoot });
    const store = createHttpArtifactStore({ localStore, publicBaseUrl: "https://files.example.test", cleanupIntervalMs: 60_000 });
    const ref = await store.put(randomUUID(), "deck.pptx", pptxMime, new Uint8Array([4, 5, 6]));
    const token = new URL(ref.uri).pathname.split("/").at(-1)!;

    expect(ref.expiresAt).toBe(new Date(Date.now() + 30 * 60 * 1000).toISOString());
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    await expect(store.get(token)).rejects.toMatchObject({ code: "ARTIFACT_EXPIRED" });
    await store.pruneExpired();
    const jobs = await readdir(outputRoot);
    const persistedFile = join(outputRoot, jobs[0]!, "deck.pptx");
    expect(await readFile(persistedFile)).toEqual(Buffer.from([4, 5, 6]));
    await store.close();
    await localStore.close?.();
  });
});
