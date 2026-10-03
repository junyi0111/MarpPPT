# Changelog

## [0.3.1] - 2026-10-03

### Fixed

- Emit legal centered table cells (`anchor="ctr"`) using typed `valign: "middle"` options.
- Prevent dependency-generated table drawing ID collisions at different slide positions without guessing connector targets.
- Repair the confirmed PptxGenJS 4.0.1 trailing apostrophe in generated chart workbook ranges; preserve editable native charts and tables.
- Reject malformed XML, illegal characters, invalid table enums, duplicate drawing IDs, and corrupt embedded XLSX ranges or relationship targets before publishing artifacts.
- Bound Office archive expansion and return deterministic `PPTX_INVALID` errors once, with the affected part when available.

### Changed

- Generation now returns `status: "draft"` and `deliveryStatus: "unverified"` even when previews are ready. `validation.powerPoint` reports `not_run` and the original artifact SHA-256; clients must not treat preview success as final delivery.
- Require repair-free first opening in PowerPoint, then save/close/reopen and content-preservation checks before final delivery. A repair prompt fails the export gate.
- Build validation renders and inspects a real compiled native table instead of searching compiled source for an alignment string. Regression tests run in CI.

## [0.3.0] - 2026-10-01

### Added

- Add `prepare_markdown_sources` for bounded extraction from public HTTPS URLs and staged PDF attachments.
- Add `save_markdown_draft` for publishing a model-generated, source-bound Markdown artifact with a SHA-256 digest.
- Add one-question drafting preferences for complexity, style, summary depth, language, audience, and requested slide count.
- Add PDF research staging with signed, expiring local references and a no-shell Poppler extraction boundary.
- Document source trust boundaries, URL/PDF limits, partial-source failure handling, and the Codex invocation example.
- Preserve explicit LaTeX in Marp and render standalone equations locally as selectable, aspect-preserving PowerPoint images with source TeX in alternative text.
- Add editable PowerPoint text runs for controlled bold and theme accent emphasis, with equivalent Marp styling.

### Fixed

- Report unsupported equations explicitly instead of silently losing mathematical notation.
- Synchronize preview and HTTP worker timeout fixtures with actual child-process and cleanup readiness.
- Require a continuous rectangular outline and an empty center before flagging raster replacement glyphs, avoiding false failures on correctly rendered CJK text in Linux previews.

### Security

- Reject credentialed or fragment-bearing authorized file URLs and keep the hosted JSON envelope large enough for a maximum-size Markdown draft without removing request limits.

## [0.2.2] - 2026-09-27

### Added

- Add the local stdio MCP `ensure_font` tool for checking and installing missing CJK font themes into the current user's font directory.
- Add post-install font verification and Skill guidance that retries preflight before rendering.
- Add `scripts/update-codex-macos.sh` so installed users can update the source and plugin cache without redownloading the managed Node.js runtime.
- Keep remote HTTP MCP instances closed to host file installation; unsupported platforms receive a manual installation action.

## [0.2.1] - 2026-09-26

### Fixed

- Default local artifacts to the private `~/.marpppt/artifacts` directory when `PPTX_OUTPUT_ROOT` is not set.
- Document a reproducible clean-clone Codex marketplace installation that installs production dependencies before plugin registration.
- Add the local marketplace manifest required by the documented Codex install commands.
- Add a regression test for the default private artifact directory and record clean-install verification results.

## [0.2.0] - 2026-09-26

### Fixed

- Repair PptxGenJS 4.0.1's phantom slide-master Content Types entries before running the strict PPTX package validator.
- Align package-test fixtures with the published bilingual README, license, PDF helper, and current worker validation schema.
- Make a clean `npm test` build the runtime first, so package and built-artifact checks work from a fresh clone.
- Pin the transitive `image-size` dependency to a patched release and add production dependency auditing to CI.

### Changed

- Keep plugin manifests and MCP server version metadata in sync with package version `0.2.0`.
