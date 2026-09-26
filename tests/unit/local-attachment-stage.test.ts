import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanExpiredStagedJobs, stageAttachments, removeStagedJob, stagedJobDirectory } from "../../src/probe/local-attachment-stage.js";
import { createProbeResolver } from "../../src/probe/probe-resolver.js";

const markdown = Buffer.from("# 簡報\nHello\n", "utf8");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgZGL+DwABFAEG9O6t0QAAAABJRU5ErkJggg==", "base64");
const temporaryDirectories: string[] = [];
const stagedJobs: string[] = [];
const stageTestAttachments = (input: Parameters<typeof stageAttachments>[0]) =>
  stageAttachments(input, { retentionMs: 5000 });

async function inputs() {
  const directory = await mkdtemp(join(tmpdir(), "attachment-stage-test-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "source.md");
  const imagePath = join(directory, "photo.png");
  await writeFile(sourcePath, markdown);
  await writeFile(imagePath, png);
  return { directory, sourcePath, imagePath };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stagedJobs.splice(0).map((jobId) => removeStagedJob(jobId)));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local attachment staging", () => {
  it("copies exact Markdown and image bytes for opaque MCP references", async () => {
    const { sourcePath, imagePath } = await inputs();
    const staged = await stageTestAttachments({ sourcePath, imagePaths: [imagePath] });
    stagedJobs.push(staged.jobId);
    const resolver = createProbeResolver();
    expect(await resolver.read(staged.sourceFile)).toEqual(markdown);
    expect(await resolver.read(staged.imageFiles[0]!)).toEqual(png);
    expect(staged.sourceFile.assetId).toMatch(/^stage:[a-f0-9]{32}:[a-f0-9]{32}$/);
    expect(JSON.stringify(staged)).not.toContain(sourcePath);
    expect(JSON.stringify(staged)).not.toContain(imagePath);
    expect(createHash("sha256").update(await resolver.read(staged.sourceFile)).digest("hex"))
      .toBe(createHash("sha256").update(markdown).digest("hex"));
  });

  it("rejects forged, expired, path-bearing, and tampered references", async () => {
    const { sourcePath } = await inputs();
    const staged = await stageTestAttachments({ sourcePath, imagePaths: [] });
    stagedJobs.push(staged.jobId);
    const resolver = createProbeResolver();
    await expect(resolver.read({ ...staged.sourceFile, assetId: "stage:" + "f".repeat(32) + ":" + "a".repeat(32) })).rejects.toThrow();
    await expect(resolver.read({ ...staged.sourceFile, fileName: "other.md" })).rejects.toThrow();
    await expect(resolver.read({ ...staged.sourceFile, path: "/etc/passwd" } as typeof staged.sourceFile)).rejects.toThrow();
    await expect(resolver.read({ ...staged.sourceFile, url: "file:///etc/passwd" } as typeof staged.sourceFile)).rejects.toThrow();
    await expect(resolver.read({ ...staged.sourceFile, assetId: "stage:../secret" })).rejects.toThrow();
    const filePath = join(stagedJobDirectory(staged.jobId), staged.sourceFile.assetId!.split(":")[2]!);
    await writeFile(filePath, "changed");
    await expect(resolver.read(staged.sourceFile)).rejects.toThrow();
    await expect(createProbeResolver({ now: () => Date.now() + 31 * 60_000 }).read(staged.sourceFile)).rejects.toThrow();
  });

  it("refuses symlink inputs and invalid file contents without leaving jobs", async () => {
    const { directory, sourcePath, imagePath } = await inputs();
    const linkedSource = join(directory, "linked.md");
    await symlink(sourcePath, linkedSource);
    await expect(stageTestAttachments({ sourcePath: linkedSource, imagePaths: [] })).rejects.toThrow();
    await writeFile(imagePath, markdown);
    await expect(stageTestAttachments({ sourcePath, imagePaths: [imagePath] })).rejects.toThrow();
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await expect(stageTestAttachments({ sourcePath, imagePaths: [imagePath] })).rejects.toThrow();
    const data = await readFile(sourcePath);
    expect(data).toEqual(markdown);
  });

  it("rejects altered manifests and symlinked staged assets", async () => {
    const { sourcePath } = await inputs();
    const staged = await stageTestAttachments({ sourcePath, imagePaths: [] });
    stagedJobs.push(staged.jobId);
    const jobDirectory = stagedJobDirectory(staged.jobId);
    const assetPath = join(jobDirectory, staged.sourceFile.assetId!.split(":")[2]!);
    const original = await readFile(assetPath);
    await rm(assetPath);
    await symlink(sourcePath, assetPath);
    await expect(createProbeResolver().read(staged.sourceFile)).rejects.toThrow();
    await rm(assetPath);
    await writeFile(assetPath, original);
    const manifestPath = join(jobDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[0].sha256 = "0".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(createProbeResolver().read(staged.sourceFile)).rejects.toThrow();
  });

  it("does not follow a staged job directory replaced with a symlink", async () => {
    const { directory, sourcePath } = await inputs();
    const staged = await stageTestAttachments({ sourcePath, imagePaths: [] });
    stagedJobs.push(staged.jobId);
    const jobDirectory = stagedJobDirectory(staged.jobId);
    const moved = join(directory, "moved-job");
    const { rename } = await import("node:fs/promises");
    await rename(jobDirectory, moved);
    await symlink(moved, jobDirectory);
    await expect(createProbeResolver().read(staged.sourceFile)).rejects.toThrow();
  });

  it("enforces Markdown UTF-8, source size, and image count limits", async () => {
    const { sourcePath } = await inputs();
    await writeFile(sourcePath, Buffer.from([0xff, 0xfe]));
    await expect(stageTestAttachments({ sourcePath, imagePaths: [] })).rejects.toThrow();
    await writeFile(sourcePath, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    await expect(stageTestAttachments({ sourcePath, imagePaths: [] })).rejects.toThrow();
    await writeFile(sourcePath, markdown);
    await expect(stageTestAttachments({ sourcePath, imagePaths: Array(31).fill(sourcePath) })).rejects.toThrow();
  });

  it("publishes one complete signing key across concurrent first-run CLI processes", async () => {
    const { directory, sourcePath } = await inputs();
    const run = promisify(execFile);
    const script = join(process.cwd(), "tests/helpers/create-short-lived-staged-job.ts");
    const results = await Promise.all(Array.from({ length: 6 }, () => run(process.execPath,
      ["--import", "tsx", script, sourcePath],
      { cwd: process.cwd(), env: { ...process.env, TMPDIR: directory } },
    )));
    expect(results).toHaveLength(6);
    for (const result of results) expect(result.stdout.trim()).toMatch(/^[a-f0-9]{32}$/);
    const keyPath = join(directory, `marpppt-attachments-${process.getuid?.() ?? "local"}`, "signing-key");
    expect((await readFile(keyPath)).length).toBe(32);
    expect((await stat(keyPath)).mode & 0o077).toBe(0);
  });

  it("removes an abandoned job when the cleanup pass reaches its expiry", async () => {
    const { sourcePath } = await inputs();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 31 * 60_000);
    const staged = await stageTestAttachments({ sourcePath, imagePaths: [] });
    stagedJobs.push(staged.jobId);
    vi.useRealTimers();
    await cleanExpiredStagedJobs();
    await expect(stat(stagedJobDirectory(staged.jobId))).rejects.toThrow();
  });

  it("removes staged bytes after expiry even after the staging process exits", async () => {
    const { sourcePath } = await inputs();
    const run = promisify(execFile);
    const helper = join(process.cwd(), "tests/helpers/create-short-lived-staged-job.ts");
    const { stdout } = await run(process.execPath, ["--import", "tsx", helper, sourcePath], { cwd: process.cwd() });
    const jobId = stdout.trim();
    stagedJobs.push(jobId);
    expect((await stat(stagedJobDirectory(jobId))).isDirectory()).toBe(true);
    await vi.waitFor(async () => expect(stat(stagedJobDirectory(jobId))).rejects.toThrow(), {
      timeout: 2500,
      interval: 30,
    });
  });
});
