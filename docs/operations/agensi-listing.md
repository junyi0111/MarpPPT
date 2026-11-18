# Agensi listing copy (MarpPPT)

Draft text for a skill-marketplace listing. Nothing here has been submitted.

**Name:** MarpPPT — Markdown to editable PowerPoint

**One-line description:** Turn a Markdown file and images into a PowerPoint deck whose text, tables, charts, diagrams and images stay editable, plus matching Marp source.

**Description:**
Give your agent a `.md` file and it plans the slides, picks a layout per slide (bullets, comparison, table, chart, diagram, image, takeaway), and renders a native `.pptx` you can keep editing. Source figures, units and dates are preserved, and each slide records which source section it came from. Traditional Chinese and English text are supported with a single consistent font. Everything runs locally: no network calls, no API keys.

**Requirements:** Node.js 22+. Optional: LibreOffice (slide previews), Poppler and Noto Sans CJK TC (CJK text checks).

**Install:** unzip into your agent's skills folder, run `bash marp-ppt/scripts/setup.sh`.

**What it does not do (state this in the listing):**
- Does not edit an existing `.pptx`.
- Output is an unverified draft: the engine validates the file structure but cannot run Microsoft PowerPoint. Open it once in PowerPoint before sending it on.
- Display equations become images, not native PowerPoint equations.
- Template-based layouts, not AI-generated artwork.

**Licensing:** repo is MIT. A paid listing of MIT code is allowed, but buyers can get the source free on GitHub; the paid value has to be packaging, support or extras (e.g. additional themes), not exclusivity.

**Package file:** `npm run package:agensi` → `runtime/marp-ppt-skill-<version>.zip`.
