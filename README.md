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
- The complete clean-open PowerPoint gate must be run for each release candidate in the target host environment.

See [the acceptance report](docs/operations/acceptance-report.md), [hosted deployment notes](docs/operations/hosted-deployment.md), and [privacy and retention](docs/operations/privacy-and-retention.md).

## License

MIT. See [LICENSE](LICENSE).
