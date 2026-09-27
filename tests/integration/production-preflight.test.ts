import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLocalPreflight } from "../../src/quality/preflight.js";

function command(stdout: string, code = 0) {
  const script = join(process.cwd(), "node_modules", ".bin", "tsx");
  return { file: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(stdout)}); process.exit(${code})`] };
}

describe("production preflight", () => {
  it("passes only when the output root, renderer tools, MCP entrypoint and requested font are all confirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "marpppt-preflight-"));
    const entrypoint = join(root, "stdio.js");
    await writeFile(entrypoint, "export {};", "utf8");
    const report = await runLocalPreflight({
      outputRoot: join(root, "output"),
      mcpEntrypoint: entrypoint,
      commands: {
        soffice: command("LibreOffice 25"),
        pdfinfo: command("pdfinfo version 25"),
        pdftoppm: command("pdftoppm version 25"),
        "fc-match": command("Noto Sans CJK TC"),
      },
    });
    expect(report.status).toBe("passed");
    expect(report.output.writable).toBe(true);
    expect(report.font).toMatchObject({ requested: "Noto Sans CJK TC", matched: "Noto Sans CJK TC", available: true });
  });

  it("reports actionable missing prerequisites without starting a full render", async () => {
    const root = await mkdtemp(join(tmpdir(), "marpppt-preflight-"));
    const report = await runLocalPreflight({
      outputRoot: join(root, "output"),
      mcpEntrypoint: join(root, "missing-stdio.js"),
      commands: {
        soffice: command("", 1),
        pdfinfo: command("", 1),
        pdftoppm: command("", 1),
        "fc-match": command("Liberation Sans"),
      },
    });
    expect(report.status).toBe("failed");
    expect(report.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "MCP_ENTRYPOINT_MISSING", "SOFFICE_MISSING", "PDFINFO_MISSING", "PDFTOPPM_MISSING", "FONT_NOT_MATCHED",
    ]));
  });
});
