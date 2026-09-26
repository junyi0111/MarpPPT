import { stageAttachments } from "../../src/probe/local-attachment-stage.js";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Source path required");
const staged = await stageAttachments({ sourcePath, imagePaths: [] }, { retentionMs: 500 });
process.stdout.write(staged.jobId + "\n");
