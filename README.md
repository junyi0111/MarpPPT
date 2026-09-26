# MarpPPT

[繁體中文](README.zh-TW.md)

MarpPPT is an open-source Codex plugin for turning Markdown and conversation images into Marp source and an editable PowerPoint deck. It includes a Codex Skill and a local MCP server. PowerPoint slides use native text, shapes, tables, charts, and embedded images.

## Features

- Builds a sourced slide plan from Markdown, user directions, and supplied image attachments.
- Uses moderate, content-aware summarization unless the user specifies a different level.
- Preserves key facts, numbers, units, names, terminology, and qualifications.
- Keeps each image's aspect ratio and uses `contain` fit; text boxes are vertically centered.
- Bundles the Tech Editorial design system, bilingual font settings, shape spacing, and table layout rules with the Skill.
- Validates the PPTX ZIP package, including every `[Content_Types].xml` Override and every internal relationship target.
- Includes a local PDF text extraction helper for optional source and page-number verification.
- Returns editable `.pptx` and `.marp.md` files, plus an image bundle when needed.

## Use in Codex

Install the plugin using Codex's local plugin controls, then invoke the Skill with `$marp-ppt` or ask Codex to create a PowerPoint deck from a Markdown file and its supplied images. The display name is **MarpPPT**. Typing `@MarpPPT` is not currently a verified activation path.

The Skill uses this plugin's `render_presentation` MCP tool to create the deck. The final-delivery workflow also asks Codex's built-in `unified-computer-use` capability to open the PPTX in Microsoft PowerPoint, save a new copy, close it, and reopen it. That computer-use capability is provided by the Codex host; it is not bundled in this repository. If the host cannot perform that step, the deck must be labeled an unverified draft.

## Agent and operating system support

MarpPPT runs a local stdio MCP server and requires Node.js 22 or later, local file access for attachment staging, and a writable output directory. It is intended for a desktop or development machine, not a mobile-only or browser-only agent session.

| Agent | Required deployment method | Current status |
| --- | --- | --- |
| **Codex** | Install this package as a Codex plugin and invoke `$marp-ppt`. Follow [OpenAI's plugin packaging and marketplace guidance](https://developers.openai.com/plugins/build/plugins). | Primary target. The package has Codex manifests; fresh-host attachment handoff and the complete PowerPoint gate still need verification. |
| **OpenCode** | Configure the local MCP server in `opencode.json` and expose the Skill through OpenCode's Agent Skills locations. Follow the [MCP](https://opencode.ai/docs/en/mcp-servers/) and [Skills](https://opencode.ai/docs/skills) guides. | Requires an OpenCode-specific setup. The current Skill contains Codex-specific attachment and computer-use steps, so the full workflow is not supported as-is. |
| **Claude Code** | Use Claude Code's plugin, MCP, and Skill conventions. Follow its [plugin](https://code.claude.com/docs/en/plugins), [MCP](https://code.claude.com/docs/en/mcp), and [Skills](https://code.claude.com/docs/en/skills) guides. | The current package is not a directly installable Claude Code plugin. It needs a Claude Code manifest/configuration and a host-adapted Skill. |

Do not install the Codex candidate ZIP into another agent as if it were a universal plugin. For OpenCode or Claude Code, configure the MCP process and Skill using that agent's own deployment format; the current release does not bundle those adapters. A remote/browser-only agent also cannot use the local stdio server. Hosted HTTP attachment transfer is not production-ready.

| Operating system | Current status |
| --- | --- |
| **macOS** | The current build and package workflow was verified here. |
| **Linux** | A starter Dockerfile targets Debian with Node.js 22. The container build and host-side end-to-end workflow have not been verified. |
| **Windows** | Node.js 22 may run the MCP server, but this package has not been validated on Windows. OpenCode recommends WSL for its Windows workflow. |

Local slide previews and PDF source checks additionally need LibreOffice, Poppler utilities, fontconfig, and Noto CJK fonts. The PowerPoint save/reopen gate requires Microsoft PowerPoint and a computer-use capability available to the agent host; the current Skill specifically describes Codex's built-in capability.

## Build and package

### Requirements

- Node.js 22 or later and npm.
- For local preview rendering: LibreOffice Impress, Poppler utilities (`pdfinfo`, `pdftoppm`, `pdftotext`), fontconfig, and Noto CJK fonts.
- For the complete delivery check: Microsoft PowerPoint and Codex computer-use support on the host.

### Create a local plugin archive

```bash
npm ci
npm run package:plugin -- --profile local
```

This command builds the TypeScript sources, applies the maintained presentation design overrides, validates the plugin package, and writes `runtime/marpppt-0.1.0-local-candidate.zip`. The archive excludes `node_modules`, tests, source TypeScript, local runtime data, and environment files. Install dependencies after extracting the archive.

Other development commands:

```bash
npm run build
npm run package:validate
npm test
npm run typecheck
```

The generated `dist/` directory and `runtime/` archive are intentionally ignored by Git. The plugin archive includes the built runtime, manifests, Skill references, theme, local PDF helper, and operations documentation.

## Design and delivery rules

The bundled [layout contract](skills/marp-ppt/references/layout-contract.md) defines typography, aspect-ratio-safe image placement, vertical text alignment, whitespace, and editable table requirements. The [production quality guide](skills/marp-ppt/references/production-quality.md) defines source verification, image handling, ZIP validation, and the PowerPoint save/reopen gate.

PowerPoint compatibility is not inferred from a valid ZIP or a rendered preview. The Skill reports ZIP validation, first-open repair status, PowerPoint save/reopen status, and visual inspection separately.

## Current limitations

- Codex conversation attachment transfer and opening returned artifacts in the Codex UI still depend on host-side file access and handoff. Local staging alone does not prove that end-to-end path.
- Hosted HTTP attachment transfer is not production-ready. A stage reference created on a Skill host does not transfer the file bytes to a separate hosted MCP server.
- OpenCode and Claude Code do not yet have bundled deployment adapters or host-specific versions of the Skill.
- The complete clean-open PowerPoint gate must be run for each release candidate in the target host environment.

See [the acceptance report](docs/operations/acceptance-report.md), [hosted deployment notes](docs/operations/hosted-deployment.md), and [privacy and retention](docs/operations/privacy-and-retention.md).

## License

MIT. See [LICENSE](LICENSE).
