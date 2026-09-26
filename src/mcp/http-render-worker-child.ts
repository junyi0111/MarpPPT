import { SERVER_JOB_ID_PATTERN } from "../artifacts/artifact-store.js";
import { createFailClosedRenderDependencies } from "./server.js";
import { HTTP_RENDER_WORKER_INPUT_LIMIT_BYTES, HTTP_RENDER_WORKER_OUTPUT_LIMIT_BYTES } from "./http-render-worker.js";
import { RenderPresentationOutputSchema, renderPresentation } from "./tools/render-presentation.js";

const [jobId] = process.argv.slice(2);
if (!jobId || !SERVER_JOB_ID_PATTERN.test(jobId)) process.exit(2);

const inputChunks: Buffer[] = [];
let inputBytes = 0;
for await (const part of process.stdin) {
  const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
  inputBytes += chunk.byteLength;
  if (inputBytes > HTTP_RENDER_WORKER_INPUT_LIMIT_BYTES) process.exit(2);
  inputChunks.push(chunk);
}

let input: unknown;
try { input = JSON.parse(Buffer.concat(inputChunks).toString("utf8")); }
catch { process.exit(2); }

const outputRoot = process.env.PPTX_OUTPUT_ROOT;
const tempRoot = process.env.MARPPPT_PRIVATE_TEMP_ROOT;
if (!outputRoot || !tempRoot) process.exit(2);

const cancellation = new AbortController();
process.once("SIGTERM", () => cancellation.abort());
process.once("SIGINT", () => cancellation.abort());

try {
  const dependencies = await createFailClosedRenderDependencies({ outputRoot, tempRoot });
  dependencies.signal = cancellation.signal;
  dependencies.previewProcessGroupId = process.pid;
  const rendered = await renderPresentation(input, dependencies, { jobId });
  const output = RenderPresentationOutputSchema.parse(rendered);
  const envelope = JSON.stringify({ version: 1, output });
  if (Buffer.byteLength(envelope, "utf8") > HTTP_RENDER_WORKER_OUTPUT_LIMIT_BYTES) process.exit(3);
  process.stdout.write(envelope);
} catch {
  process.exitCode = 1;
}
