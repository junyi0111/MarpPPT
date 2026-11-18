# Plan format (`plan.json`)

Top level (all required): `version: 1`, `title`, `language` (e.g. `en`, `zh-TW`), `themeId` (`default`, `default-serif`, `default-source-serif`, `default-plex`), `sourceDigest` (from `inspect`), `slides`, `imageAssetIds`, `assetManifest` (both from `inspect`; `[]` when there are no images). Max 60 slides, 30 images.

Each slide: `id` (letters, digits, `_`, `-`; unique), `title`, `layout`, `imageIds` (`[]` unless image layout), optional `sourceRefs` (source headings/locations; required on every slide except cover/section/closing without body text).

| layout | extra fields |
| --- | --- |
| `cover` | optional `subtitle`, `blocks` |
| `section`, `closing` | optional `blocks` |
| `takeaway` | `blocks`: exactly 1 |
| `bullets` | `blocks`: 3–5 |
| `image-text` | `blocks`: 1–8, `imageIds`: ≥1 |
| `image` | `imageIds`: ≥1, optional `blocks` |
| `comparison` | `columns`: exactly 2 × `{id, title, blocks: 1–5}` |
| `table` | `table: {columns: string[], rows: string[][]}` (rows match column count) |
| `chart` | `chart: {kind: "bar"|"line"|"pie", labels: string[], series: [{name, values: number[]}]}` (pie = exactly 1 series) |
| `diagram` | `diagram: {nodes: [{id, label}] (2–30), edges: [{from, to, label?}]}`; no `blocks`; no placeholder labels such as `...`, `TBD`, `TODO` |

A block is `{id, text}`, with optional `runs: [{text, bold?: true, color?: "accent"}]` whose concatenated text equals `text` exactly.

Only `cover` may have a `subtitle`. Images only on `image` / `image-text`. Complete example: `examples/sample.plan.json`.
