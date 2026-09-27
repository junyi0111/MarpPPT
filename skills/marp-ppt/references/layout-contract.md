# MarpPPT layout contract

This file is the shared layout reference for the `marp-ppt` Skill.

## Canvas and type

- Use a fixed 13.333 × 7.5 inch 16:9 canvas.
- Keep every object within the 0.45 inch left/right and 0.35 inch top/bottom safe margins.
- Use the shared 12-column grid and theme tokens from `assets/themes/default.json`; do not invent per-slide colors, margins, or coordinates in the Skill.
- Use one selected font family for all English and Traditional Chinese text in the editable PPTX and preview. The safe default is `Noto Sans CJK TC`; supported alternatives are `Noto Serif CJK TC`, `Source Han Serif TC`, and `IBM Plex Sans TC`. Do not use 新細明體 (PMingLiU) or a mixed font stack. Confirm the selected family resolves on the host; if it is unavailable, report the font issue instead of silently substituting a potentially incompatible face. Body text stays at or above 18 pt; source and note text stays at or above 12 pt. Titles target two lines and never shrink below the title minimum.
- Render title, subtitle, each paragraph/list item, each diagram node label, chart/table, shape, connector, and image as separate layout objects. The PPTX renderer maps them to separate native PowerPoint objects.

## Text alignment

Vertically center every editable text box, including titles, subtitles, paragraph/list items, diagram labels, and table cells. Use `valign: mid` with equal top and bottom inner spacing; keep horizontal alignment as defined by the slide template. If text does not fit, split or summarize it under the overflow contract rather than top-aligning it or shrinking below the font floor.

## Controlled slide templates

Use only the canonical `PresentationPlan` layouts: `cover`, `section`, `takeaway`, `bullets`, `image-text`, `comparison`, `image`, `chart`, `table`, `diagram`, and `closing`. A page should make one main point. Use 3–5 bullets for a regular bullets slide; split or summarize excess text rather than shrinking the font below its floor.

Images use safe canonical plan asset IDs (distinct from opaque staging references) and `contain` fit only. Scale uniformly to preserve each original aspect ratio; never stretch, distort, crop, or use `cover`. Keep the full image visible inside its assigned box, leaving unused space when needed. Apply the same rule in the editable PPTX and preview. Never fetch a URL or infer an image from a filename. Every received image must have a planned slide; if it cannot be matched to content, place it on an appendix/image slide and retain its original filename in the asset manifest.

Comparison columns, chart values, table cells, diagram nodes, and connectors remain structured data or individual native objects. Do not flatten a slide into a screenshot.

## Overflow contract

Layout coordinates are inches. `findOverflow` checks the safe rectangle and estimates line wrapping with wider character weights for CJK text. It does not lower font sizes to force a fit.

- `SPLIT_REQUIRED`: the text is moderately over its box; revise the affected plan section into shorter content or additional slides.
- `SUMMARY_REQUIRED`: the text is far over its box, a title/source line exceeds its fixed line limit, or table content cannot fit; summarize while preserving must-keep facts, or report that the plan needs user input.
- `LAYOUT_OVERFLOW`: a generated object crosses the safe rectangle; change the controlled layout before rendering.

Each issue identifies the slide and object IDs, includes an actionable message, and should be returned to the agent for a targeted plan revision. Do not mark an output complete while any layout issue remains unresolved.

## Marp serialization and safety

The Marp source is serialized from the same validated `PresentationPlan` as the PPTX. It has `marp: true`, `size: 16:9`, a known theme, and one slide boundary between planned slides. Keep titles, text, structured table/chart/diagram data, relative image references, and visible source references aligned with that plan.

Text is escaped as Markdown text. Reject raw HTML, Marp directive comments, and external URLs rather than executing, interpreting, or fetching them. Attachments use relative paths of the form `assets/<encoded-asset-id>.<ext>`; never emit a local temp path or a URL. When image assets exist, deliver the Markdown together with an asset bundle so the relative references resolve.


## Tech editorial visual system

- Use a dark navy background (`darkBackground`) on cover, section, and closing slides. Use the pale `background` token on content slides, with white `surface` panels for bullets, comparisons, image-text pairs, charts, and tables.
- Keep the hierarchy consistent: white titles on dark slides, navy titles on content slides, and a short cyan accent rule or edge beside the title. Use the theme's blue, cyan, warm, and violet tokens for diagram nodes and chart series.
- Vary the page structure to match the content. Use cards for grouped points, two balanced panels for comparisons, a text-image split for image-text, and the structured chart, table, or diagram layout when its data fits. Avoid repeating a plain bullet page when another controlled layout communicates the same source more clearly.
- Keep whitespace around panels and between objects. One slide should carry one primary message; shorten or split content instead of filling every available space. Decorative elements must remain native editable PowerPoint objects and stay inside the safe area.
- Content backgrounds and accents come from `assets/themes/default.json`. Do not hardcode per-slide palette values in the Skill or create full-slide rectangle objects that trip safe-area validation; use the PPTX native slide background for the canvas color.


## Text and shape spacing contract

- Convert centimeters to PPTX coordinates with `inches = cm / 2.54`. The comfortable default is 0.4–0.6 cm per side; use 0.20 in (about 0.51 cm) for ordinary cards, image-text panels, chart/table panels, and comparison cards.
- For dense information, compact spacing may be 0.2–0.3 cm per side; use 0.10 in (about 0.25 cm) only where the content needs it, such as stacked bullet cards. Do not go below 0.2 cm per side. For cover titles, quotations, or minimal layouts, leave at least 0.8 cm (0.315 in) around the content group.
- Keep the editable text box inside its backing shape by the selected inset. Do not rely on PowerPoint text-box margin alone to create spacing: the layout and overflow checker must see the actual reduced text box. Keep vertically centered text and summarize/split when the reduced box no longer fits.

## Table contract

- Use a dark navy header row with white bold text, centered horizontally and vertically. Allocate it a visibly taller row height than a one-line body row and provide 0.4 cm total vertical padding (0.079 in above and below).
- Keep the first column widest. Align it left and bold as the row/category label. Detect columns whose non-empty cells are consistently numeric or numeric-with-units; align those values right, and keep description columns left. Emphasize numeric values in navy bold for scanability. Do not right-align prose.
- Use 1.2 line spacing. Provide approximately 0.5 cm total vertical padding and 0.5 cm padding on each horizontal side in body cells. Compute and validate column widths and row heights after these insets; if content cannot fit, shorten or split the table rather than removing the padding or shrinking below the font floor.
- Table cells remain native PowerPoint cells. Never flatten the table into an image.
