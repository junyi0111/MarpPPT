# MarpPPT

<p align="center">
  <strong>From Markdown and images to fast, editable template-based PowerPoint decks.</strong><br>
  A Codex plugin, Skill, and local MCP server for presentations you can keep editing.
</p>

<p align="center">
  <a href="https://github.com/junyi0111/MarpPPT/actions/workflows/build.yml"><img alt="Build and package validation" src="https://github.com/junyi0111/MarpPPT/actions/workflows/build.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2563EB.svg"></a>
  <img alt="Node.js 22 or later" src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white">
  <img alt="Package version 0.3.0" src="https://img.shields.io/badge/package-0.3.0-6D5EF7">
  <a href="https://github.com/junyi0111/MarpPPT/commits/main"><img alt="Latest commit" src="https://img.shields.io/github/last-commit/junyi0111/MarpPPT?label=last%20update"></a>
</p>

<p align="center">
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="#install-in-codex-desktop">Quick start</a> ·
  <a href="#support-matrix">Support</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a>
</p>

![MarpPPT workflow: Markdown and image attachments become an editable PowerPoint through planning, layout, and validation.](assets/readme/marpppt-workflow.svg)

MarpPPT turns Markdown, conversation directions, and supplied images into Marp source and an **editable `.pptx`**. Text, shapes, tables, charts, and images are placed as native PowerPoint objects so you can continue editing the deck.

## Where MarpPPT fits

MarpPPT focuses on **fast, cost-conscious production of conventional template-based slides**. It turns existing content into consistently laid out PowerPoint decks whose elements remain editable. It is suited to recurring reports, teaching materials, research summaries, and presentations that need frequent revisions.

Its quality goals are **clear information, reliable layout, repeatable production, and easy editing**. Automatically generated presentations in the style of NotebookLM and image-generated decks in the style of Image2 emphasize different storytelling or visual effects. If you want that generated visual style, MarpPPT's template-based output serves a different design goal. Actual costs still depend on your agent, model, and software such as PowerPoint.

## What you get

- **A clear story:** creates a sourced slide plan and applies moderate, content-aware summarization while preserving key facts, numbers, units, names, and qualifications.
- **Consistent layout:** includes the Tech Editorial design system, bilingual font settings, editable table rules, and spacing guidance.
- **Selectable font themes:** defaults to Noto Sans TC and also supports Noto Serif TC, Source Han Serif TC, and IBM Plex Sans TC. The local MCP can install a missing family from an official source into the user's font directory, then rerun preflight; see [font themes](docs/operations/fonts.md).
- **Images handled carefully:** keeps each image's aspect ratio and uses `contain` fit; text boxes are vertically centered.
- **A checked package:** validates every `[Content_Types].xml` Override and internal relationship target in the PPTX archive.
- **Useful deliverables:** returns editable `.pptx` and `.marp.md` files, plus an image bundle when needed.
- **Source checks:** includes a local PDF text extraction helper for optional source and page-number verification.

## From URLs or PDFs to a Markdown brief

You can start with one to eight public HTTPS URLs or staged PDF attachments when you do not have a Markdown file yet. MarpPPT asks for the missing preferences in one compact choice: **complexity** (`brief`, `standard`, `detailed`), **style** (`tech-editorial`, `academic`, `executive`, `tutorial`), and **summary** (`light`, `moderate`, `deep`). It then prepares bounded source text, drafts a traceable Markdown brief, and saves it as a private Markdown artifact before any optional PPTX rendering.

The local MCP exposes `prepare_markdown_sources` and `save_markdown_draft` for this workflow. Sources are treated as untrusted reference material: their text cannot change tool policy or request secrets. URL acquisition accepts HTTPS only, blocks private or non-public DNS targets, does not follow redirects, and caps response, PDF extraction, context, and draft sizes. Credentials, fragments, arbitrary local paths, `file://` URLs, and unauthorised host files are rejected. A partial result reports each failed source instead of inventing missing facts.

Example request in Codex:

```text
Use $marp-ppt. Read these URLs/PDFs and first produce a saved Markdown brief.
Ask once for complexity, style, and summary if I did not specify them.
Keep source IDs and page or URL references beside important claims.
```

## Install in Codex desktop

The following path targets **Codex desktop on macOS**. You need the desktop app installed and signed in, access to GitHub and nodejs.org, and enough disk space for dependencies. **Git, Node.js, npm, and a `codex` command on your terminal PATH are not prerequisites.** The installer downloads and verifies Node.js, builds the local plugin, and uses the Codex executable bundled with the desktop app. You can [inspect the installer](scripts/install-codex-macos.sh) and [updater](scripts/update-codex-macos.sh) before running them.

### Option 1: ask the Codex agent to install it

Start a new Codex desktop conversation and paste:

```text
Install the MarpPPT plugin from https://github.com/junyi0111/MarpPPT on this macOS computer. First inspect scripts/install-codex-macos.sh in that repository, then run it locally. Confirm that the marpppt marketplace and markdown-to-editable-pptx@marpppt plugin are installed and that the MCP's Node.js executable exists and starts. Report any permission or network block instead of claiming success. Finally remind me to quit and reopen Codex and start a new conversation with $marp-ppt.
```

### Option 2: paste into macOS Terminal

```bash
set -o pipefail
curl -fsSL https://raw.githubusercontent.com/junyi0111/MarpPPT/main/scripts/install-codex-macos.sh | /bin/bash
```

After `Installed.` appears, **quit and reopen Codex completely**, start a new conversation, attach your `.md` file and images, and invoke `$marp-ppt` with your presentation request. Confirm **MarpPPT** is enabled in the desktop app's Plugins view. MCP outputs are stored under `~/.marpppt/artifacts/` by default. Set `PPTX_OUTPUT_ROOT` to an absolute path before launching Codex to change the output location. You can set an absolute `MARPPPT_INSTALL_ROOT` before installation to keep the runtime and plugin source on an external drive; **keep that drive connected while using the plugin**.

### Update an existing installation

Run this command on the same Mac after closing active MarpPPT conversations:

```bash
set -o pipefail
curl -fsSL https://raw.githubusercontent.com/junyi0111/MarpPPT/main/scripts/update-codex-macos.sh | /bin/bash
```

The updater reuses the managed Node.js runtime, downloads the new source, runs `npm ci`, builds and validates it, refreshes the local marketplace and plugin cache, then checks both MCP tools. If the installation uses an external drive, set the same `MARPPPT_INSTALL_ROOT` before running. After `Updated MarpPPT.` appears, quit and reopen Codex and start a new conversation. The updater does not remove your generated artifacts under `~/.marpppt/artifacts/`.

This installs the **plugin and MCP**. A final PowerPoint save-and-reopen check also requires Microsoft PowerPoint and Codex computer-use support. One-step desktop installation on Windows and Linux has not been verified.

> **Activation note:** the display name is **MarpPPT**, but typing `@MarpPPT` is not currently a verified activation path. Use `$marp-ppt` or describe the task in your prompt.

The Skill uses the bundled `render_presentation` MCP tool. Its delivery instructions also ask Codex's built-in `unified-computer-use` capability to open the deck in Microsoft PowerPoint, save a new copy, close it, and reopen it. This computer-use capability comes from the Codex host and is not included in this repository. If the host cannot perform that check, the result must be labeled an unverified draft.

## Support matrix

MarpPPT runs a local stdio MCP server. It needs Node.js 22 or later, local access to staged attachments, and a writable output directory. It is intended for desktop or development environments.

| Agent | Deployment | Status |
| --- | --- | --- |
| **Codex** | Follow the macOS desktop steps above and invoke `$marp-ppt`. See [OpenAI plugin packaging guidance](https://developers.openai.com/plugins/build/plugins). | **Primary target.** The desktop installer covers Node.js and the bundled Codex executable. Conversation attachment handoff and opening returned files in Codex still depend on host verification. |
| **OpenCode** | Configure the MCP server in `opencode.json` and load the Skill from an Agent Skills location. See the [MCP](https://opencode.ai/docs/en/mcp-servers/) and [Skills](https://opencode.ai/docs/skills) guides. | Requires OpenCode-specific setup. The current Skill's attachment and computer-use steps are Codex-specific, so the full workflow is not supported as-is. |
| **Claude Code** | Use Claude Code's own plugin, MCP, and Skill conventions. See its [plugin](https://code.claude.com/docs/en/plugins), [MCP](https://code.claude.com/docs/en/mcp), and [Skills](https://code.claude.com/docs/en/skills) guides. | Not a directly installable Claude Code plugin yet; it needs a Claude Code manifest and a host-adapted Skill. |

| Operating system | Status |
| --- | --- |
| **macOS** | Build and plugin packaging were verified in the development environment. |
| **Linux** | A Debian/Node.js 22 Docker starter is included. Container build and host-side end-to-end flow are not verified. |
| **Windows** | Node.js 22 may run the MCP server, but this package has not been validated on Windows. |

Do not install the Codex candidate ZIP into another agent as if it were a universal plugin. OpenCode and Claude Code need their own MCP configuration and Skill adapter. Mobile-only, browser-only, or remote agents cannot directly access the local stdio server. Hosted HTTP attachment transfer is not production-ready.

## Build the local plugin package

### Requirements

- Node.js 22 or later and npm.
- For local slide previews and PDF source checks: LibreOffice Impress, Poppler utilities (`pdfinfo`, `pdftoppm`, `pdftotext`), fontconfig, and Noto CJK fonts.
- For the complete delivery gate: Microsoft PowerPoint and Codex computer-use support on the host.

### Package

```bash
npm ci
npm run package:plugin -- --profile local
```

This builds the TypeScript, applies the maintained presentation overrides, validates the plugin package, and writes `runtime/marpppt-0.3.0-local-candidate.zip`. The archive excludes `node_modules`, tests, TypeScript source, local runtime data, and environment files. Install dependencies after extracting it.

Other development commands:

```bash
npm run build
npm run package:validate
npm test
npm run typecheck
```

Generated `dist/` and `runtime/` files are intentionally ignored by Git. The plugin archive includes the built runtime, manifests, Skill references, theme, local PDF helper, and operations documentation.

## Design and delivery checks

- The [layout contract](skills/marp-ppt/references/layout-contract.md) defines typography, aspect-ratio-safe image placement, vertical text alignment, whitespace, and editable table requirements.
- The [production quality guide](skills/marp-ppt/references/production-quality.md) defines source checks, image handling, ZIP validation, and the PowerPoint save/reopen gate.
- A valid ZIP or successful preview alone does not prove PowerPoint compatibility. The Skill reports package validation, first-open repair status, PowerPoint save/reopen status, and visual inspection separately.

## Known limitations

- Conversation attachment transfer and opening returned files in the Codex UI depend on host-side file access and handoff. Local staging alone does not prove the end-to-end path.
- A staging reference created on a Skill host does not transfer attachment bytes to a separate hosted MCP server; hosted HTTP attachment transfer is not production-ready.
- OpenCode and Claude Code deployment adapters and host-specific Skills are not bundled yet.
- The clean-open PowerPoint gate must be run for each release candidate on its target host.

See the [acceptance report](docs/operations/acceptance-report.md), [hosted deployment notes](docs/operations/hosted-deployment.md), and [privacy and retention policy](docs/operations/privacy-and-retention.md).

## Contributing

Bug reports, focused improvements, and agent-specific deployment adapters are welcome. Start with the [contribution guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md), then choose an issue template. Please include your operating system, agent host, and reproduction steps when reporting a problem.

## License

MIT. See [LICENSE](LICENSE).
