import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ARTIFACT_RETENTION_MS = 30 * 60 * 1000;

async function startReaper(jobDir: string, retentionMs: number): Promise<void> {
  // A detached child keeps the deadline even if the MCP server exits first.
  const reaper = spawn(process.execPath, [
    "-e",
    "setTimeout(async()=>{const {rm}=await import('node:fs/promises');await rm(process.argv[1],{recursive:true,force:true})},Number(process.argv[2]))",
    jobDir,
    String(retentionMs),
  ], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    reaper.once("spawn", () => resolve());
    reaper.once("error", reject);
  });
  reaper.unref();
}

export async function createSampleArtifact(
  write: (path: string) => Promise<unknown>,
  options: { root?: string; retentionMs?: number } = {},
): Promise<string> {
  const root = options.root ?? join(tmpdir(), "markdown-to-editable-pptx-probe");
  const retentionMs = options.retentionMs ?? ARTIFACT_RETENTION_MS;
  await mkdir(root, { recursive: true });
  const jobDir = await mkdtemp(join(root, "job-"));
  const artifactPath = join(jobDir, "sample.pptx");
  try {
    await write(artifactPath);
    await startReaper(jobDir, retentionMs);
  } catch (error) {
    await rm(jobDir, { recursive: true, force: true });
    throw error;
  }
  return pathToFileURL(artifactPath).href;
}
