# PPTX Repair Prevention Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the authorized implementation, then superpowers:requesting-code-review for an independent review. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Prevent recurrence of the two reproduced table repair errors and block related malformed PPTX before publication.

**Architecture:** Correct table options at their source. Add a namespace-aware XML validation boundary shared by PPTX and embedded XLSX checks; keep narrowly scoped dependency compatibility repairs separate from validation. Every render result remains an unverified draft until the host performs the PowerPoint workflow.

**Tech Stack:** TypeScript, PptxGenJS 4.0.1, fflate, @xmldom/xmldom 0.9.12, Vitest, native PowerPoint for Mac.

**Spec:** The 2026-10-03 PPTX repair review; confirmed failures are `a:tcPr/@anchor="mid"`, `a:tcPr/@horzOverflow="wrap"`, duplicate drawing IDs, illegal XML characters, and the embedded chart table range `A1:B3'`.

## Global Constraints

- Preserve native editable tables/charts/text, image proportions, fonts and existing layout rules.
- Reject malformed exported content; do not silently strip notes, tables, or images.
- Do not package user decks or private source material.
- Deterministic validation failures must retain the failing Part and must not repeat unchanged work.
- Native PowerPoint verification cannot be inferred from ZIP validation or LibreOffice previews.

## Review Focus

- Alternate XML prefixes and attribute order must not bypass checks.
- Escaped control characters and unpaired surrogates must fail, while CJK/emoji/tab/newline remain valid.
- Embedded XLSX ranges/relationships must be validated under bounded decompression.
- Drawing IDs must remain unique with connectors referencing the correct objects.
- Packaged runtime and installed Plugin must contain the same validation as source.

### Task 1: Reproduction and table generation

Files: `tests/integration/pptx-repair-prevention.test.ts`, `src/pptx/add-layout-object.ts`.

- [x] Add real-render tests for tables on slides 1/2/3/5 and semantic assertions for legal centered cells.
- [x] Watch `anchor="mid"` tests fail before changing the renderer.
- [x] Use typed table options and `valign: "middle"` for both table and cell options.
- [x] Verify actual serialized tables remain native and editable.

### Task 2: Strict validation and compatibility fixes

Files: `src/pptx/office-xml.ts`, `src/pptx/validate-pptx.ts`, `src/pptx/pptxgenjs-compat.ts`, `src/pptx/render-pptx.ts`, regression tests.

Interfaces: `parseOfficeXml(xml, part): Document`; `assertOfficeSemantics(document, part): void`; `validateEmbeddedWorkbooks(archive): void`; `repairPptxGenJsCompatibility(bytes): Uint8Array`.

- [x] Independently inject illegal anchor/overflow values, control characters/references, duplicate IDs, malformed embedded ranges and missing nested targets; watch rejection tests fail.
- [x] Use the standard XML parser with namespace-aware semantics, reject DTD/entities, and check decoded XML characters.
- [x] Bound archive sizes, entries and embedded workbook sizes; validate XLSX XML, ranges, Override and internal relationship targets.
- [x] Correct dependency-generated drawing IDs before references exist; narrowly repair the confirmed trailing apostrophe in generated chart workbooks, keeping ordinary validation strict.
- [x] Confirm bad fixtures still fail inspection; compatibility helpers must not repair arbitrary corrupt inputs.

### Task 3: Delivery state and deterministic errors

Files: `src/mcp/tools/render-presentation.ts`, integration tests, Skill production workflow references.

- [x] Add failing tests proving structural failures are returned once, include the failing Part, publish no artifacts, and preserve cleanup.
- [x] Add required `deliveryStatus: "unverified"` and `validation.powerPoint: { status: "not_run", artifactSha256 }` to successful generation output.
- [x] Return drafts even with ready previews; retain previews but disallow a completed delivery claim without native verification.
- [x] Update host instructions to perform PowerPoint first-open/save/close/reopen and identify the exact delivery file.

### Task 4: Release validation and package adoption

Files: package manifests, changelog, package/build preference checks, README and quality documentation.

- [x] Replace the source-string alignment build check with the actual renderer regression gate.
- [x] Run the full suite, typecheck, package validation and production dependency audit; inspect independent review findings.
- [x] Package 0.3.1 and generate a mixed table/chart/diagram/image/CJK deck from the extracted package through MCP.
- [x] Open the raw output in PowerPoint with no repair, save a new copy, close and reopen; compare slide/text/media/chart-data preservation.
- [x] Update installed Plugin via supported installation workflow; document restart and user update command.
- [x] Publish only after validation; retain explicit platform and native-check limitations.

## Execution evidence

- Full suite: 42 files / 356 tests passed; typecheck and package validation passed.
- One independent review completed; all six findings fixed with eight observed RED-to-GREEN cases.
- Extracted 0.3.1 package exercised through stdio MCP; 11 slides with tables, charts, CJK, diagram, image and math retained.
- PowerPoint for Mac 16.113.2 opened raw output and reopened its saved copy without repair. Save As was disabled, so the validated alternate was a new byte-identical copy followed by native Save; changed SHA and exact content comparisons prove a real native write.
- Installed `markdown-to-editable-pptx@personal` refreshed through supported Codex CLI to cache version 0.3.1. Original source retained as a rollback backup.
- Public synthetic evidence and platform limits: [validation report](../../operations/pptx-repair-prevention-0.3.1.md).
- Validated patch published as [PR #2](https://github.com/junyi0111/MarpPPT/pull/2); main merge and release remain gated on GitHub CI.
