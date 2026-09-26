# Install and verify the local Codex plugin

The supported Codex install path uses the repository as a local marketplace. Codex copies the plugin from that source into its local cache, so build the runtime and install its production dependencies in the source tree first.

## Prerequisites

- Node.js 22 or later and npm.
- LibreOffice Impress, Poppler (`pdfinfo`, `pdftoppm`, `pdftotext`), fontconfig, and Noto CJK fonts for local preview and PDF-source checks.
- Microsoft PowerPoint and Codex `unified-computer-use` for the final save/reopen gate.
- Codex CLI, available with the Codex desktop installation.

## Install from a clean clone

Run these commands from a terminal:

```bash
git clone https://github.com/junyi0111/MarpPPT.git
cd MarpPPT
npm ci
npm run build
codex plugin marketplace add .
codex plugin add markdown-to-editable-pptx@marpppt
```

Restart Codex and start a new conversation. Attach a Markdown file and any images, then invoke `$marp-ppt`. The local MCP creates `~/.marpppt/artifacts/` with private permissions when it first starts. Set `PPTX_OUTPUT_ROOT` to another absolute path before launching Codex only when a different output location is needed.

To remove the test installation later, run `codex plugin remove markdown-to-editable-pptx@marpppt` and `codex plugin marketplace remove marpppt`.

## Build a local candidate archive

This archive is useful for packaging checks. It omits `node_modules`, so the clean-clone workflow above is the supported installation path; do not install the ZIP into Codex without first arranging its runtime dependencies.

## Build the local archive

```bash
npm ci
npm run package:plugin -- --profile local
```

The command compiles the TypeScript runtime, applies the maintained presentation design overlays, validates the package, and writes `runtime/marpppt-0.2.1-local-candidate.zip`.

The package contains both portable manifests (`plugin.json`, `mcp.json`) and the Codex compatibility pair (`.codex-plugin/plugin.json`, `.mcp.json`). Both launch `dist/mcp/stdio.js` using the local `presentation` MCP server ID. The explicit Skill name is `$marp-ppt`; `@MarpPPT` has not been verified as an activation path.

## Attachment and output flow

The Skill may stage only paths the host exposes as readable conversation attachments. Invoke `stage:attachments` through a structured process argument array, never by interpolating paths into shell code. The CLI copies verified Markdown and PNG/JPEG inputs into a private expiring job and returns opaque `assetId` references. The MCP receives those references, not arbitrary local paths or source bytes.

After the MCP renders a PPTX, verify the package result and open it in Microsoft PowerPoint through Codex computer use. Save a new copy, close PowerPoint, and reopen that saved copy. Deliver that copy only if no repair prompt appears. If attachment handoff, CUA, or PowerPoint is unavailable, report the exact blocked gate and label the raw export as an unverified draft.

See [privacy and retention](privacy-and-retention.md) for staging limits and artifact lifetimes.
