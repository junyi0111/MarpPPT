import { writeFile } from "node:fs/promises";
import { createSampleArtifact } from "../../src/probe/sample-artifact.js";

const root = process.argv[2];
if (!root) throw new Error("Expected artifact test root");
const uri = await createSampleArtifact((path) => writeFile(path, "sample pptx"), {
  root,
  retentionMs: 500,
});
process.stdout.write(uri);
