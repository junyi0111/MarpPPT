# Contributing

Thanks for helping improve MarpPPT. Keep changes focused and preserve the plugin's explicit source, attachment, and output safety boundaries.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Use the repository's issue templates for bugs, feature requests, or documentation problems. Do not post security vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).

## Development setup

- Node.js 22 or later and npm.
- For preview-related changes, install LibreOffice Impress, Poppler utilities, fontconfig, and Noto CJK fonts.

```bash
npm ci
npm run build
npm run package:validate
npm test
```

To generate a local Codex plugin archive:

```bash
npm run package:plugin -- --profile local
```

## Change guidelines

- Keep the source TypeScript in `src/` authoritative for runtime behavior.
- The maintained renderer overlays in `scripts/presentation-overrides/` are applied after compilation. Update the corresponding overlay when changing one of those renderer modules, and keep the theme and Skill references in sync.
- Never add real conversation attachments, generated user decks, local machine paths, credentials, or private test artifacts to the repository.
- Keep the default Skill as the user-facing workflow; the MCP server must continue to reject arbitrary local paths and untrusted remote URLs.
- Update operational documentation when a release gate or runtime requirement changes.

## Pull requests

Use the pull request template to describe the behavior change, user impact, and checks you actually ran. If a check was not possible, state that clearly. Do not include private user material in examples or screenshots.
