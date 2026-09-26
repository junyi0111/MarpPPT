# Changelog

## [0.2.0] - 2026-09-26

### Fixed

- Repair PptxGenJS 4.0.1's phantom slide-master Content Types entries before running the strict PPTX package validator.
- Align package-test fixtures with the published bilingual README, license, PDF helper, and current worker validation schema.
- Make a clean `npm test` build the runtime first, so package and built-artifact checks work from a fresh clone.
- Pin the transitive `image-size` dependency to a patched release and add production dependency auditing to CI.

### Changed

- Keep plugin manifests and MCP server version metadata in sync with package version `0.2.0`.
