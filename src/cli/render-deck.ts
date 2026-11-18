import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFailClosedRenderDependencies } from "../mcp/server.js";
import { renderPresentation } from "../mcp/tools/render-presentation.js";
import { stageAttachments } from "../attachments/local-attachment-stage.js";

const USAGE = [
  "Usage:",
  "  render-deck inspect --source deck.md [--image a.png ...]",
  "  render-deck render  --source deck.md --plan plan.json [--image a.png ...] [--out /abs/output/dir]",
].join("\n");

interface ParsedArgs {
  command: "inspect" | "render";
  source: string;
  images: string[];
  plan?: string;
  out?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "inspect" && command !== "render") throw new Error(USAGE);
  const parsed: ParsedArgs = { command, source: "", images: [] };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value) throw new Error(USAGE);
    if (flag === "--source") parsed.source = resolve(value);
    else if (flag === "--image") parsed.images.push(resolve(value));
    else if (flag === "--plan") parsed.plan = resolve(value);
    else if (flag === "--out") parsed.out = resolve(value);
    else throw new Error(USAGE);
  }
  if (!parsed.source || (command === "render" && !parsed.plan)) throw new Error(USAGE);
  return parsed;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function inspect(args: ParsedArgs): Promise<unknown> {
  const source = await readFile(args.source);
  const assetManifest = await Promise.all(args.images.map(async (path, index) => {
    const bytes = await readFile(path);
    const extension = extname(path).toLowerCase();
    return {
      assetId: `image-${index + 1}`,
      fileName: basename(path),
      mimeType: extension === ".png" ? "image/png" : "image/jpeg",
      byteLength: bytes.length,
      sha256: sha256(bytes),
    };
  }));
  return { sourceDigest: sha256(source), imageAssetIds: assetManifest.map((asset) => asset.assetId), assetManifest };
}

async function render(args: ParsedArgs): Promise<{ output: unknown; failed: boolean }> {
  const plan = JSON.parse(await readFile(args.plan!, "utf8")) as { imageAssetIds?: string[] };
  const staged = await stageAttachments({ sourcePath: args.source, imagePaths: args.images });
  const dependencies = await createFailClosedRenderDependencies({ outputRoot: args.out });
  try {
    const output = await renderPresentation({
      plan,
      sourceFile: staged.sourceFile,
      imageFiles: staged.imageFiles,
      imageAssetIds: plan.imageAssetIds ?? [],
    }, dependencies);
    return { output, failed: (output as { status: string }).status === "failed" };
  } finally {
    await dependencies.artifactStore.close?.();
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "inspect") {
    process.stdout.write(`${JSON.stringify(await inspect(args), null, 2)}\n`);
    return 0;
  }
  const { output, failed } = await render(args);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
