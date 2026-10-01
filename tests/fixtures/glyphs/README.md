# Glyph raster regression fixture

`linux-noto-cjk.png` is slide 3 of the synthetic `simple-brief.plan.json`
acceptance deck, rendered by LibreOffice with Noto Sans CJK TC on the
GitHub Actions Ubuntu runner. It contains no user documents or attachments.

The original size/density heuristic falsely reported seven replacement glyphs
in this correctly rendered page. The regression covers sparse CJK strokes and
the nested rectangular strokes in 回, which must not be treated as an empty
missing-glyph square. Synthetic positive tests retain detection of empty boxes.
