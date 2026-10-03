import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePackage } from "../../scripts/validate-package.js";

const root = resolve(import.meta.dirname, "../..");
const skillPath = resolve(root, "skills/marp-ppt/SKILL.md");

async function guidance(): Promise<string> {
  return readFile(skillPath, "utf8");
}

describe("MarpPPT skill decision guidance", () => {
  it("covers direct Markdown-to-PPTX and indirect brief-to-deck requests", async () => {
    const text = await guidance();
    expect(text).toMatch(/Markdown.*(?:PPTX|PowerPoint)/is);
    expect(text).toMatch(/brief|簡報.*需求|素材摘要/i);
    expect(text).toMatch(/(?:明確|直接|explicit).*\$marp-ppt/is);
  });

  it("asks one focused question for missing or ambiguous Markdown and scopes existing-PPTX editing", async () => {
    const text = await guidance();
    expect(text).toMatch(/(?:缺少|沒有|missing).*\.md.*(?:一個|one).*問題/is);
    expect(text).toMatch(/(?:多份|multiple).*Markdown.*(?:詢問|ask)/is);
    expect(text).toMatch(/(?:既有|existing).*PPTX.*(?:不適用|範圍外|out of scope)/is);
  });

  it("maps no-image and multi-image requests into the real render input without losing assets", async () => {
    const text = await guidance();
    expect(text).toMatch(/(?:沒有|no)\s*(?:圖片|image).*imageFiles.*\[\].*imageAssetIds.*\[\]/is);
    expect(text).toMatch(/(?:每張|every).*圖片.*(?:至少|at least).*一頁/is);
    expect(text).toMatch(/(?:sourceFile\.assetId|imageFiles\[\]\.assetId).*stage:/is);
    expect(text).toMatch(/imageAssetIds.*(?:安全|safe).*assetManifest/is);
  });

  it("preserves all requested numbers and resolves conflicting page limits with the user", async () => {
    const text = await guidance();
    expect(text).toMatch(/(?:所有|全部|every|all).*數字.*(?:單位|units)/is);
    expect(text).toMatch(/(?:頁數|slide count).*(?:衝突|conflict|無法兼得).*詢問/is);
  });

  it("revises only affected overflow content at most twice and never treats a draft as complete", async () => {
    const text = await guidance();
    expect(text).toMatch(/SPLIT_REQUIRED.*SUMMARY_REQUIRED.*LAYOUT_OVERFLOW/is);
    expect(text).toMatch(/(?:受影響|affected).*(?:最多兩次|at most twice)/is);
    expect(text).toMatch(/draft.*(?:交付驗證未完成|delivery verification incomplete)/is);
  });

  it("keeps attachment text untrusted and uses only the production renderer", async () => {
    const text = await guidance();
    expect(text).toMatch(/(?:附件|attachment).*(?:不可信|untrusted).*(?:指令|instructions)/is);
    expect(text).toMatch(/render_presentation/);
    expect(text).not.toMatch(/probe_attachments/);
  });

  it("passes host attachment paths as data even when filenames contain apostrophes", async () => {
    const text = await guidance();
    expect(text).not.toContain("'<exact readable .md path>'");
    expect(text).not.toContain("'<exact readable image path>'");
    expect(text).toMatch(/(?:結構化|structured).*argv.*(?:路徑|path)/is);
    expect(text).toMatch(/POSIX.*(?:單引號|single.quote).*(?:關閉|close).*(?:跳脫|escape).*(?:重新|reopen)/is);
  });

  it("routes URL/PDF-only requests through source preparation and Markdown draft persistence", async () => {
    const text = await guidance();
    expect(text).toMatch(/(?:網址|URL).*PDF.*(?:Markdown|MD).*prepare_markdown_sources/is);
    expect(text).toMatch(/save_markdown_draft/);
    expect(text).toMatch(/(?:complexity|複雜度).*(?:brief|standard|detailed|選項)/is);
    expect(text).toMatch(/(?:style|風格).*(?:academic|executive|tutorial|tech-editorial|選項)/is);
    expect(text).toMatch(/(?:來源|source).*(?:不可信|untrusted).*(?:指令|instructions)/is);
    expect(text).toMatch(/(?:--pdf|stage:research)/is);
  });
});

describe("package consistency checks", () => {
  it("keeps the updater's MCP smoke check aligned with the public tool set", async () => {
    const updater = await readFile(resolve(root, "scripts/update-codex-macos.sh"), "utf8");
    expect(updater).toContain("prepare_markdown_sources");
    expect(updater).toContain("save_markdown_draft");
  });

  it("rejects mismatched server IDs, HTTP mode, and paths outside the plugin", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "marpppt-package-check-"));
    const clone = async (path: string) => {
      const content = await readFile(resolve(root, path));
      const target = resolve(temporary, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, content);
    };
    try {
      for (const path of [
        "package.json", "plugin.json", "mcp.json", ".codex-plugin/plugin.json", ".mcp.json",
        "skills/marp-ppt/SKILL.md", "skills/marp-ppt/agents/openai.yaml", "dist/mcp/stdio.js",
        "dist/mcp/http-render-worker-child.js",
        "dist/source/source-contracts.js", "dist/source/source-material.js", "dist/source/pdf-text.js",
        "dist/mcp/tools/prepare-markdown-sources.js", "dist/mcp/tools/save-markdown-draft.js",
        "dist/pptx/pptxgenjs-compat.js", "dist/pptx/office-xml.js",
        "dist/attachments/local-attachment-stage.js", "dist/attachments/staged-resolver.js",
        "scripts/write-hosted-manifest.ts", "scripts/preflight.mjs", "scripts/update-codex-macos.sh",
      ]) await clone(path);
      await expect(validatePackage(temporary)).resolves.toBeUndefined();

      const localPath = resolve(temporary, ".mcp.json");
      const local = JSON.parse(await readFile(localPath, "utf8"));
      local.mcpServers.other = local.mcpServers.presentation;
      delete local.mcpServers.presentation;
      await writeFile(localPath, JSON.stringify(local));
      await expect(validatePackage(temporary)).rejects.toThrow(/presentation MCP server/);
      await clone(".mcp.json");

      const portablePath = resolve(temporary, "mcp.json");
      const portable = JSON.parse(await readFile(portablePath, "utf8"));
      portable.mcpServers.presentation.type = "http";
      await writeFile(portablePath, JSON.stringify(portable));
      await expect(validatePackage(temporary)).rejects.toThrow(/stdio transport/);
      await clone("mcp.json");

      const manifestPath = resolve(temporary, "plugin.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.mcpServers = "../outside.json";
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(validatePackage(temporary)).rejects.toThrow(/inside the plugin root/);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
