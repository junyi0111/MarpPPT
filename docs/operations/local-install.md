# Local candidate package: setup and verification

This page describes building and installing a local candidate ZIP. End-to-end Codex attachment transfer and clean PowerPoint opening must be verified in the target host before treating a candidate as a validated release.

## Prerequisites

- Node.js 22 or later and npm.
- LibreOffice Impress, Poppler (`pdfinfo`, `pdftoppm`, `pdftotext`), fontconfig, and Noto CJK fonts for local preview and PDF-source checks.
- Microsoft PowerPoint and Codex `unified-computer-use` for the final save/reopen gate.
- A private, absolute output directory on the same machine as the MCP stdio server. Set `PPTX_OUTPUT_ROOT` to that directory before starting the server. The server rejects missing, non-absolute, symlinked, or group/world-accessible output roots.

## Build the local archive

```bash
npm ci
npm run package:plugin -- --profile local
```

The command compiles the TypeScript runtime, applies the maintained presentation design overlays, validates the package, and writes `runtime/marpppt-0.2.0-local-candidate.zip`. The ZIP omits `node_modules`; install dependencies in the extracted directory and run `npm run package:validate` before registering it.

The package contains both portable manifests (`plugin.json`, `mcp.json`) and the Codex compatibility pair (`.codex-plugin/plugin.json`, `.mcp.json`). Both launch `dist/mcp/stdio.js` using the local `presentation` MCP server ID. The explicit Skill name is `$marp-ppt`; `@MarpPPT` has not been verified as an activation path.

## Attachment and output flow

The Skill may stage only paths the host exposes as readable conversation attachments. Invoke `stage:attachments` through a structured process argument array, never by interpolating paths into shell code. The CLI copies verified Markdown and PNG/JPEG inputs into a private expiring job and returns opaque `assetId` references. The MCP receives those references, not arbitrary local paths or source bytes.

After the MCP renders a PPTX, verify the package result and open it in Microsoft PowerPoint through Codex computer use. Save a new copy, close PowerPoint, and reopen that saved copy. Deliver that copy only if no repair prompt appears. If attachment handoff, CUA, or PowerPoint is unavailable, report the exact blocked gate and label the raw export as an unverified draft.

See [privacy and retention](privacy-and-retention.md) for staging limits and artifact lifetimes.
