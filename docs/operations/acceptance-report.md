# Release acceptance status

This repository contains the local MarpPPT plugin package and its current end-to-end acceptance limits. A successful build or structurally valid ZIP is not, by itself, evidence that a Codex conversation can transfer attachments or that Microsoft PowerPoint opens the resulting file without repair.

## Verified in local candidate work

- The production MCP can render Markdown and image attachments supplied through the local staging path.
- The renderer checks editable slide structure, embedded images, slide bounds, and internal package relationships.
- Local previews can be rendered when LibreOffice, Poppler, and the required CJK fonts are available.
- A prior PowerPoint trial opened a generated candidate only after a Repair prompt. A separately repaired copy could be edited, saved, closed, and reopened; that does not pass the clean-open gate for the original export.

These observations describe earlier local candidate checks. Re-run the build and all applicable release gates for the exact commit being released.

## Still requires host verification

| Gate | Status | Notes |
| --- | --- | --- |
| `$marp-ppt` activation in a fresh Codex task | Not recently verified | The `@MarpPPT` form is not a verified activation path. |
| Automatic transfer of conversation Markdown and images to the MCP | Not verified end to end | Local staging only proves the host-local bridge. |
| Opening and saving returned artifacts in Codex | Not verified | Artifact references must be opened in the target Codex host. |
| Clean PowerPoint open, Save As, close, and reopen | Must be rerun for each candidate | Deliver the PowerPoint-saved copy only after reopening without a repair prompt. |
| Hosted attachment transfer and public HTTP endpoint | Not production-ready | Host-local staging references do not transfer bytes to a remote MCP process. |

## Dependency security status

The production dependency tree currently includes `image-size@1.2.1` through `pptxgenjs@4.0.1`. GitHub Security Advisories GHSA-5p2g-fcmc-qvqq and GHSA-w3rx-r6r6-pgpr list `image-size` versions through 2.0.2 as affected and do not currently identify a published patched release. The affected parser paths are not used directly by MarpPPT's current image-validation code, which accepts PNG and JPEG inputs, but the transitive dependency remains in the install tree and this is not a clean security audit.

The release machine could not refresh `npm audit` on 2026-09-26 because the npm registry hostname was unreachable. Re-run `npm audit --omit=dev --audit-level=high` from a network-enabled environment before publishing. Do not describe the dependency audit as passed until the advisory is resolved or a reviewed mitigation is recorded.

## Release rule

Do not call a candidate PowerPoint-verified until it passes the ZIP package checks and the Microsoft PowerPoint open/save/reopen procedure in [production-quality.md](../../skills/marp-ppt/references/production-quality.md). If a host-side gate is unavailable, report that status and mark the raw export as an unverified draft.

Do not call this repository security-clean while the `image-size` advisory remains unresolved. A successful TypeScript build and plugin archive validation verify packaging only; they do not satisfy dependency-security or PowerPoint host checks.
