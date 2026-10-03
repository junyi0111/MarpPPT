# PPTX repair prevention: 0.3.1 validation

Validated on 2026-10-03. This report uses a synthetic deck; no user presentation or research attachments are distributed.

## What changed

| Failure | Prevention |
| --- | --- |
| Invalid centered table cells (`anchor="mid"`) | Typed table options emit legal `anchor="ctr"`; real rendering tests cover tables at different slide positions. |
| Invalid table overflow (`horzOverflow="wrap"`) in a historical third-party export | Inspection rejects illegal values. Foreign files are not silently repaired by the compatibility helper. |
| PptxGenJS table drawing ID collisions | Narrow generation-time correction; ambiguous connector references fail instead of being guessed. |
| PptxGenJS chart workbook range with trailing apostrophe | Correct this confirmed dependency defect only in fresh generated workbooks; strict inspection rejects malformed ranges. |
| XML characters, namespace aliases, duplicate expanded attributes, dangling package/workbook references | Namespace-aware XML validation before artifacts are published, including nested XLSX packages. |
| Archive expansion or declared-size bypass | Enforce entry, byte and embedded-workbook limits before and after decompression. |
| Preview success mistaken for native verification | MCP returns `draft` / `unverified`, `powerPoint.status: not_run` and the exact artifact SHA-256. |
| Repeating an unchanged malformed export | `PPTX_INVALID` returns once, preserves the affected part and publishes no artifacts. |

Compatibility correction applies only to fresh PptxGenJS output. Inspection never changes an input file. Generated presentations must still pass a repair-free first open and native save/close/reopen before final delivery.

## Automated and package evidence

- 42 test files, 356 tests passed; no tests were disabled for the release.
- Initial reproduction suite showed 18 failing cases before the renderer fix. Independent review exposed six further boundary issues; eight added cases failed before the follow-up correction and passed afterwards.
- Type checking, actual compiled table rendering and package validation passed.
- Production dependency audit reported zero vulnerabilities at validation time.
- Extracted the packaged runtime into a separate directory, installed production dependencies there, and exercised its stdio MCP. Server reported version `0.3.1`; previews were ready while delivery correctly remained unverified.
- CI runs the regression tests, package validation and production dependency audit. A passing CI run cannot replace native Office verification.

## Native PowerPoint evidence

Environment: Microsoft PowerPoint for Mac **16.113.2**. A synthetic 11-slide deck included CJK/English text, tables on slides 2 and 5, bar/line/pie charts, a diagram, an attached image and a rendered LaTeX equation.

1. The raw packaged-MCP export opened with **no repair prompt**.
2. The Save As dialog had a disabled Save button. A byte-identical new local copy was opened and saved by PowerPoint using its native Save operation. The output bytes and file size changed, confirming an actual write.
3. The saved file was closed and reopened with **no repair prompt**.
4. Both raw and saved files passed strict package inspection. Exact slide text, table text, cached chart values, embedded worksheet cells and media hashes were preserved.

| Preserved native content | Before and after |
| --- | ---: |
| Slides | 11 |
| Text shapes | 30 |
| Pictures | 2 |
| Native tables | 2 |
| Native charts | 3 |
| Shapes | 61 |
| Graphic frames | 5 |

Raw SHA-256: `eb2bb5286989dc4601f2ca0a8aba54c62380637b3bb3fd890b5955b29c6c5a1e`

PowerPoint-saved SHA-256: `d3668041d8d9fe00e2b340e12bbdb8017ab663e41e31fb5c101f62bc90cfd8d6`

## Limits and future changes

This release prevents the reproduced defects and rejects the tested malformed structures. It is not a complete Office XSD validator and does not promise acceptance by every Office version. Native Windows PowerPoint was not tested. Each final presentation still requires its own native check; dependency upgrades must retain the table-position, chart-workbook and malformed-package regressions. If a new repair prompt occurs, preserve the raw file and identify the failing part before changing the renderer or releasing it.
