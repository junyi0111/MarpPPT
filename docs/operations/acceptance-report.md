# Release acceptance status

This repository contains the local MarpPPT plugin package and its current end-to-end acceptance limits. A successful build or structurally valid ZIP is not, by itself, evidence that a Codex conversation can transfer attachments or that Microsoft PowerPoint opens the resulting file without repair.

## Verified in local candidate work

- The production MCP can render Markdown and image attachments supplied through the local staging path.
- The renderer checks editable slide structure, embedded images, slide bounds, and internal package relationships.
- Local previews can be rendered when LibreOffice, Poppler, and the required CJK fonts are available.
- On 2026-09-26, a clean isolated Codex profile installed the local marketplace plugin and successfully called the installed MCP to render a two-slide Markdown deck without setting `PPTX_OUTPUT_ROOT`.
- The candidate PPTX passed package checks for content type overrides, relationship targets, and slide bounds. Microsoft PowerPoint opened it without a repair prompt; a Save As copy was closed and reopened successfully, and both slides rendered.
- The first clean-install attempt exposed two setup defects: the marketplace source must have production dependencies installed before Codex copies it into the plugin cache, and the MCP previously refused to start when `PPTX_OUTPUT_ROOT` was unset. The current local candidate documents `npm ci` before plugin registration and defaults output to `~/.marpppt/artifacts`.

These checks apply to the local `v0.2.1` candidate based on commit `5218a9b`. The clean-install fixes are scoped to this patch release. Model-driven Skill activation, automatic conversation-attachment transfer, and Codex artifact opening remain unverified and are tracked separately from the local-install fix.

## Still requires host verification

| Gate | Status | Notes |
| --- | --- | --- |
| `$marp-ppt` activation in a fresh Codex task | Not verified | The isolated Codex profile was not signed in, so model-driven Skill activation was not exercised. The `@MarpPPT` form is not a verified activation path. |
| Automatic transfer of conversation Markdown and images to the MCP | Not verified end to end | Local staging only proves the host-local bridge. |
| Opening and saving returned artifacts in Codex | Not verified | Artifact references must be opened in the target Codex host. |
| Clean PowerPoint open, Save As, close, and reopen | Passed for local smoke candidate | Re-run for each release candidate. This does not verify the Codex artifact handoff. |
| Hosted attachment transfer and public HTTP endpoint | Not production-ready | Host-local staging references do not transfer bytes to a remote MCP process. |

## Dependency security status

The production dependency tree resolves `image-size@2.0.4` through the `pptxgenjs@4.0.1` override. A fresh `npm audit --omit=dev --audit-level=high` attempt on 2026-09-26 could not reach `registry.npmjs.org` (`ENOTFOUND`), so the current audit status is unknown. Re-run the audit from a network-enabled environment before publishing; do not report it as passed based only on the installed dependency version.

## Release rule

Do not call a candidate PowerPoint-verified until it passes the ZIP package checks and the Microsoft PowerPoint open/save/reopen procedure in [production-quality.md](../../skills/marp-ppt/references/production-quality.md). If a host-side gate is unavailable, report that status and mark the raw export as an unverified draft.

A successful TypeScript build and plugin archive validation verify packaging only; they do not satisfy attachment handoff or Codex artifact-opening checks. Do not describe the dependency audit as passed until it can be refreshed from the npm registry.
