import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { runLocalPreflight } = await import(pathToFileURL(resolve(root, "dist/quality/preflight.js")).href);
const outputRoot = process.argv[2] ?? resolve(root, "output");
const report = await runLocalPreflight({ outputRoot });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status === "failed") process.exitCode = 1;
