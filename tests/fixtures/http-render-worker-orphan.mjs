import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

let body = "";
for await (const part of process.stdin) body += part.toString();
const { markerPath, heartbeatPath } = JSON.parse(body);
const childSource = `const fs=require("node:fs");process.on("SIGTERM",()=>{});setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeatPath)},String(Date.now())),20)`;
const grandchild = spawn(process.execPath, ["-e", childSource], { stdio: "ignore" });
writeFileSync(markerPath, String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 10_000);
