import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [jobId] = process.argv.slice(2);
const outputRoot = process.env.PPTX_OUTPUT_ROOT;
const tempRoot = process.env.MARPPPT_PRIVATE_TEMP_ROOT;
const input = JSON.parse(await new Promise((resolve, reject) => {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => resolve(body));
  process.stdin.on("error", reject);
}));
if (input.spawnedMarker) await writeFile(input.spawnedMarker, "spawned");
const workspaceName = `job-${createHash("sha256").update(jobId).digest("hex").slice(0, 20)}-fixture`;

if (input.mode === "block") {
  await mkdir(join(outputRoot, jobId), { recursive: true, mode: 0o700 });
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  await mkdir(join(tempRoot, workspaceName), { recursive: true, mode: 0o700 });
  await writeFile(join(outputRoot, jobId, "before-timeout.txt"), "created", { mode: 0o600 });
  await writeFile(join(tempRoot, workspaceName, "before-timeout.txt"), "created", { mode: 0o600 });
  const end = Date.now() + 30_000;
  while (Date.now() < end) { /* Deliberately block only the child event loop. */ }
  await writeFile(join(outputRoot, jobId, "after-timeout.txt"), "must never exist", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ version: 1, output: { unexpected: "late success" } }));
  process.exit(0);
}

const jobOutput = join(outputRoot, jobId);
await mkdir(jobOutput, { recursive: true, mode: 0o700 });
await mkdir(tempRoot, { recursive: true, mode: 0o700 });
await mkdir(join(tempRoot, workspaceName), { recursive: true, mode: 0o700 });
const artifacts = [
  { fileName: "presentation.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: "PPTX DATA" },
  { fileName: "presentation.marp.md", mimeType: "text/markdown", bytes: "# Example\n" },
];
for (const artifact of artifacts) {
  await writeFile(join(jobOutput, artifact.fileName), artifact.bytes, { mode: 0o600 });
}
const inspection = {
  slideCount: 1,
  textShapeCount: 1,
  pictureCount: 0,
  tableCount: 0,
  chartCount: 0,
  fullSlidePictureCount: 0,
  slideBoundsValid: true,
  shapeCount: 1,
  graphicFrameCount: 0,
  embeddedMediaCount: 0,
  relationshipsValid: true,
};
const output = {
  status: "draft",
  jobId,
  pptx: { fileName: artifacts[0].fileName, mimeType: artifacts[0].mimeType, uri: pathToFileURL(join(jobOutput, artifacts[0].fileName)).href, expiresAt: null },
  marp: { fileName: artifacts[1].fileName, mimeType: artifacts[1].mimeType, uri: pathToFileURL(join(jobOutput, artifacts[1].fileName)).href, expiresAt: null },
  previews: [],
  slideCount: 1,
  imageUsage: [],
  warnings: [],
  validation: {
    pptx: inspection,
    preview: { status: "draft", pageCount: 0, fontRequested: "Arial", fontSelected: null, fontSubstituted: false, issues: [] },
    visualQaPassed: false,
  },
};
if (input.mode === "invalid-ref") output.marp.uri = "file:///etc/passwd";
process.stdout.write(JSON.stringify({ version: 1, output }));
