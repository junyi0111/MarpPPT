import { createHash } from "node:crypto";
import pptxgen from "pptxgenjs";
import { createSampleArtifact } from "./sample-artifact.js";
import type { ProbeFileRef, ProbeResolver } from "../attachments/attachment-reference.js";
export type { ProbeFileRef, ProbeResolver } from "../attachments/attachment-reference.js";

export interface ProbeFileReport {
  fileName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
}

export interface ProbeReport {
  files: ProbeFileReport[];
  sampleArtifactUri: string;
}

export interface ProbeInput {
  sourceFile: ProbeFileRef;
  imageFiles: ProbeFileRef[];
}

export async function probeAttachments(
  input: ProbeInput,
  resolver: ProbeResolver,
): Promise<ProbeReport> {
  if (input.imageFiles.length > 30) throw new Error("At most 30 images are allowed");
  if (input.sourceFile.mimeType !== "text/markdown" || !input.sourceFile.fileName.toLowerCase().endsWith(".md")) {
    throw new Error("Source must be a Markdown file");
  }
  const seenIds = new Set<string>();
  if (input.sourceFile.assetId) seenIds.add(input.sourceFile.assetId);
  for (const image of input.imageFiles) {
    const lower = image.fileName.toLowerCase();
    if (!((image.mimeType === "image/png" && lower.endsWith(".png")) ||
      (image.mimeType === "image/jpeg" && (lower.endsWith(".jpg") || lower.endsWith(".jpeg"))))) {
      throw new Error("Images must be PNG or JPEG files");
    }
    if (!image.assetId || seenIds.has(image.assetId)) throw new Error("Image asset IDs must be unique");
    seenIds.add(image.assetId);
  }
  const files: ProbeFileReport[] = [];
  let totalBytes = 0;
  for (const ref of [input.sourceFile, ...input.imageFiles]) {
    const bytes = await resolver.read(ref);
    const limit = ref === input.sourceFile ? 2 * 1024 * 1024 : 10 * 1024 * 1024;
    if (bytes.byteLength < 1 || bytes.byteLength > limit) throw new Error("Attachment exceeds its size limit");
    totalBytes += bytes.byteLength;
    if (totalBytes > 50 * 1024 * 1024) throw new Error("Attachments exceed 50 MB total");
    files.push({
      fileName: ref.fileName,
      mimeType: ref.mimeType,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const sampleArtifactUri = await createSampleArtifact(async (artifactPath) => {
    // PptxGenJS 4's ESM runtime is constructable; its published NodeNext type is not.
    // @ts-expect-error upstream ESM declaration mismatch
    const pptx = new pptxgen();
    pptx.layout = "LAYOUT_WIDE";
    const slide = pptx.addSlide();
    slide.addText("Attachment probe sample", {
      x: 0.7,
      y: 0.7,
      w: 11.9,
      h: 0.8,
      fontSize: 28,
    });
    await pptx.writeFile({ fileName: artifactPath });
  });
  return { files, sampleArtifactUri };
}
