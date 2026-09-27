# Install and verify the local Codex plugin

The supported Codex install path uses the repository as a local marketplace. Codex copies the plugin from that source into its local cache, so build the runtime and install its production dependencies in the source tree first. The macOS desktop installer handles this even when Git, Node.js, npm, and `codex` are absent from the user's terminal PATH.

## Prerequisites

- Codex desktop on macOS, signed in, with access to GitHub and nodejs.org.
- LibreOffice Impress, Poppler (`pdfinfo`, `pdftoppm`, `pdftotext`), fontconfig, and the selected CJK font for optional local preview and PDF-source checks. See [font presets](fonts.md).
- Microsoft PowerPoint and Codex `unified-computer-use` for the final save/reopen gate.
- The installer locates the Codex executable inside the desktop app and downloads a private Node.js runtime. No separate CLI or Node.js setup is required for the plugin install.

## Install with only Codex desktop on macOS

Ask a Codex agent to inspect and run [`scripts/install-codex-macos.sh`](../../scripts/install-codex-macos.sh), or paste this into macOS Terminal:

```bash
set -o pipefail
curl -fsSL https://raw.githubusercontent.com/junyi0111/MarpPPT/main/scripts/install-codex-macos.sh | /bin/bash
```

The installer downloads the repository and an official Node.js 24 macOS archive, verifies Node.js against its published SHA-256 checksum, runs `npm ci`, builds and validates the plugin, and registers its local marketplace using either the `codex` command or the executable bundled inside the desktop app. It then connects to the MCP in Codex's installed plugin cache and checks that `render_presentation` is available. It sets both MCP manifests to the installed Node.js binary's absolute path so launching the desktop app does not depend on a terminal PATH. It stores source and Node.js under `~/.local/share/marpppt/` by default; set an absolute `MARPPPT_INSTALL_ROOT` before running to use another location, including an external drive. Keep that drive connected while using the plugin.

Quit and reopen Codex completely, then start a new conversation. Confirm MarpPPT is enabled in the Plugins view, attach a Markdown file and any images, and invoke `$marp-ppt`. The local MCP creates `~/.marpppt/artifacts/` with private permissions when it first starts. Set `PPTX_OUTPUT_ROOT` to another absolute path before launching Codex only when a different output location is needed.

## Manual developer install

When Git, Node.js 22 or later, npm, and `codex` are already available on PATH, this command sequence remains useful for development:

```bash
git clone https://github.com/junyi0111/MarpPPT.git
cd MarpPPT
npm ci
npm run build
codex plugin marketplace add .
codex plugin add markdown-to-editable-pptx@marpppt
```

To remove the test installation later, run `codex plugin remove markdown-to-editable-pptx@marpppt` and `codex plugin marketplace remove marpppt`.

## Build a local candidate archive

This archive is useful for packaging checks. It omits `node_modules`, so the clean-clone workflow above is the supported installation path; do not install the ZIP into Codex without first arranging its runtime dependencies.

## Build the local archive

```bash
npm ci
npm run package:plugin -- --profile local
```

The command compiles the TypeScript runtime, validates the committed presentation design contract, validates the package, and writes `runtime/marpppt-0.2.1-local-candidate.zip`.

The package contains both portable manifests (`plugin.json`, `mcp.json`) and the Codex compatibility pair (`.codex-plugin/plugin.json`, `.mcp.json`). Both launch `dist/mcp/stdio.js` using the local `presentation` MCP server ID. The explicit Skill name is `$marp-ppt`; `@MarpPPT` has not been verified as an activation path.

## Attachment and output flow

The Skill may stage only paths the host exposes as readable conversation attachments. Invoke `stage:attachments` through a structured process argument array, never by interpolating paths into shell code. The CLI copies verified Markdown and PNG/JPEG inputs into a private expiring job and returns opaque `assetId` references. The MCP receives those references, not arbitrary local paths or source bytes.

After the MCP renders a PPTX, verify the package result and open it in Microsoft PowerPoint through Codex computer use. Save a new copy, close PowerPoint, and reopen that saved copy. Deliver that copy only if no repair prompt appears. If attachment handoff, CUA, or PowerPoint is unavailable, report the exact blocked gate and label the raw export as an unverified draft.

Before a full render, run the local preflight against the intended absolute output directory:

```bash
npm run build
node scripts/preflight.mjs /absolute/path/to/marpppt-output "Noto Sans CJK TC"
```

The report separately records Node/MCP startup, output write access, LibreOffice/Poppler availability and the actual selected font family match. A failed preflight is an actionable setup failure, not a presentation draft.

See [privacy and retention](privacy-and-retention.md) for staging limits and artifact lifetimes.
