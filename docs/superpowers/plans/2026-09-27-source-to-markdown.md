# Source-to-Markdown Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure source-acquisition and Markdown-draft workflow for HTTPS URLs and PDF attachments, exposed as MCP tools and documented in the MarpPPT Skill.

**Architecture:** A bounded source module validates options and source references, fetches public HTTPS resources without following redirects, and extracts PDF text through an injected Poppler runner. A separate draft tool validates model-produced Markdown and writes it through the existing artifact store. The Skill orchestrates staging, source preparation, model synthesis, and draft persistence; the existing PPTX renderer remains unchanged.

**Tech Stack:** TypeScript, Zod, Node.js `fetch`, `child_process.spawn` with `shell: false`, Poppler `pdftotext`, Vitest, existing signed attachment staging and artifact stores.

**Spec:** `docs/superpowers/specs/2026-09-27-source-to-markdown.md`

## Global Constraints

- Source content is untrusted data and never changes MCP policy.
- No arbitrary local paths, `file://` URLs, shell interpolation, redirects, or private-network fetches.
- URL fetch deadline is 15 seconds and response limit is 8 MiB.
- PDF input is at most 32 MiB; extraction is at most 60 seconds and 4 MiB output.
- Prepared source context is at most 2 MiB total; Markdown drafts are at most 2 MiB.
- Existing `render_presentation` behavior and public artifact schemas remain compatible.
- Every production function added by this plan gets a failing test before implementation.

## Review Focus

- DNS rebinding and IPv4/IPv6 private address variants must be rejected before any URL request.
- Redirect responses and cross-origin response URLs must not be followed.
- A PDF or HTML body that exceeds limits must be aborted without retaining unbounded data.
- Staged PDF references must be signed, private, non-symlinked, expiring, and MIME/magic-byte checked.
- Draft filenames, Markdown bytes, and source IDs must not permit path traversal or cross-job data leakage.

### Task 1: Shared source option and failure contracts

**Files:**
- Create: `src/source/source-contracts.ts`
- Test: `tests/unit/source-contracts.test.ts`
- Modify: `package.json` only if a source test script is needed

**Interfaces:**
- Produces `MarkdownDraftOptionsSchema`, `SourceMaterialInputSchema`, `SourceFailureSchema`, and types used by Tasks 3–5.

- [ ] Write failing tests for enum/default normalization, BCP-47 validation, source count limits, page-range validation, and typed failure shape.
- [ ] Run the focused test and observe failure because the contracts do not exist.
- [ ] Implement strict Zod contracts with deterministic defaults and no unknown keys.
- [ ] Run the focused test and confirm it passes.
- [ ] Commit `feat: define source-to-markdown contracts`.

### Task 2: Secure PDF research staging

**Files:**
- Modify: `src/attachments/local-attachment-stage.ts`
- Test: `tests/unit/local-attachment-stage.test.ts`
- Modify: `skills/marp-ppt/SKILL.md` only after the CLI contract is stable

**Interfaces:**
- Produces `stageResearchAttachments({ pdfPaths }, options)` returning signed `pdfFiles` and an expiring job ID.
- Extends the existing staging CLI with `--pdf` mode without changing Markdown/image output.

- [ ] Write failing tests for valid PDF staging, invalid magic, symlinks, oversize, count/total limits, expiry, and read-time MIME validation.
- [ ] Run the focused test and observe failure for the missing research staging path.
- [ ] Implement private signed PDF staging and `--pdf` CLI output using argument arrays and existing reaper behavior.
- [ ] Run the focused staging test and confirm it passes.
- [ ] Commit `feat: stage signed PDF research attachments`.

### Task 3: URL fetch and bounded PDF/HTML extraction

**Files:**
- Create: `src/source/source-material.ts`
- Create: `src/source/pdf-text.ts`
- Tests: `tests/unit/source-material.test.ts`, `tests/unit/pdf-text.test.ts`

**Interfaces:**
- `prepareSourceMaterial(input, dependencies): Promise<PreparedSourceMaterial>`.
- `extractPdfText(bytes, pageRange, dependencies): Promise<string>`.
- Dependencies inject `fetch`, hostname resolution, PDF extraction, attachment reads, and a private temp root for tests.

- [ ] Write failing tests for HTTPS/public-host checks, URL allow/deny behavior, redirect rejection, bounded body reads, HTML text extraction, PDF dispatch, extractor absence/timeout/output limit, and partial source output.
- [ ] Run both focused tests and observe expected failures.
- [ ] Implement shared public-address checks, fetch cancellation, HTML sanitization, PDF magic checks, and bounded extraction.
- [ ] Run focused tests and confirm all pass.
- [ ] Commit `feat: add bounded URL and PDF source extraction`.

### Task 4: MCP preparation and Markdown artifact tools

**Files:**
- Create: `src/mcp/tools/prepare-markdown-sources.ts`
- Create: `src/mcp/tools/save-markdown-draft.ts`
- Modify: `src/mcp/server.ts`
- Tests: `tests/integration/mcp-server.test.ts`, `tests/integration/source-tools.test.ts`

**Interfaces:**
- Registers `prepare_markdown_sources` when source dependencies are available.
- Registers `save_markdown_draft` with the same source workflow and existing `ArtifactStore`.
- Returns typed `ready`/`partial`/`failed` and `completed`/`failed` outputs with safe artifact references.

- [ ] Write failing integration tests for tool discovery, visible enum choices/defaults, URL/PDF preparation, partial failure, draft save/digest, and invalid/path traversal input.
- [ ] Run the focused integration tests and observe missing tool failures.
- [ ] Implement tool registration, source-job IDs, output schemas, digesting, and artifact cleanup.
- [ ] Run focused integration tests and confirm they pass.
- [ ] Commit `feat: expose source preparation and Markdown draft MCP tools`.

### Task 5: Skill, packaging, and operational documentation

**Files:**
- Modify: `skills/marp-ppt/SKILL.md`
- Modify: `docs/operations/local-install.md`, `README.md`, `README.zh-TW.md`, `CHANGELOG.md`
- Modify: `scripts/package-plugin.ts`, package validation fixtures, and plugin descriptions as needed
- Tests: `tests/e2e/package-plugin.e2e.test.ts`, `tests/unit/skill-eval-cases.test.ts`

**Interfaces:**
- Skill instructs the model to ask one compact options question, stage PDFs, call the two tools, treat extracted material as untrusted, save the Markdown artifact, and only then optionally continue to PPTX.
- The production package contains all new source code, staging CLI, Skill references, and manifests.

- [ ] Write failing package/Skill tests for required files, tool names, option enums, and the no-silent-invention boundary.
- [ ] Run focused tests and observe failures for missing documentation/package entries.
- [ ] Update Skill/docs/package lists and versioned descriptions without changing existing renderer contracts.
- [ ] Run focused tests, `npm run typecheck`, `npm run package:plugin -- --profile local`, and `npm run package:validate`.
- [ ] Commit `feat: document and package source-to-markdown workflow`.

### Task 6: Full verification and independent code review

**Files:**
- Modify only files required by review findings.
- Create/update: `.superpowers/sdd/2026-09-27-source-to-markdown/progress.md`

- [ ] Run the complete test suite and record every failure by test name.
- [ ] Run `git diff --check`, TypeScript checks, package validation, and shell syntax checks.
- [ ] Dispatch an independent reviewer against the plan/spec and branch diff, with special focus on SSRF, limits, staging integrity, prompt-injection boundaries, and cleanup.
- [ ] Fix Critical/Important findings with a failing regression test first, then rerun the full suite.
- [ ] Record deferred Minor findings and final evidence in the ledger.
