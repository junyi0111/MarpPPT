# Changelog

## [0.2.2] - 2026-09-27

### Added

- Add the local stdio MCP `ensure_font` tool for checking and installing missing CJK font themes into the current user's font directory.
- Add post-install font verification and Skill guidance that retries preflight before rendering.
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
