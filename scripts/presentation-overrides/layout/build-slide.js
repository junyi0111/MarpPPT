import { getTextBox } from "./geometry.js";
function textObject(slide, theme, id, role, text, box, options = {}) {
    const note = role === "source";
    return {
        kind: "text",
        id,
        slideId: slide.id,
        ...box,
        role,
        text,
        fontFace: theme.typography.fontFace,
        fontSize: options.fontSize ?? (note ? theme.typography.note : theme.typography.body),
        minFontSize: options.minFontSize ?? (note ? theme.typography.minNote : theme.typography.minBody),
        lineHeight: theme.typography.lineHeight,
        ...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }),
        color: options.color ?? (note ? theme.colors.muted : theme.colors.body),
        ...(options.bold === undefined ? {} : { bold: options.bold }),
    };
}
function titleObject(slide, theme) {
    const box = getTextBox("title", slide.layout, theme);
    if (slide.layout === "section" || slide.layout === "closing") {
        box.x += 0.25;
        box.w -= 0.25;
    }
    const fontSize = slide.layout === "cover" ? theme.typography.coverTitle : slide.layout === "section" || slide.layout === "closing"
        ? theme.typography.sectionTitle
        : theme.typography.title;
    return textObject(slide, theme, `${slide.id}:title`, "title", slide.title, box, {
        fontSize,
        minFontSize: Math.max(theme.typography.minBody, 24),
        maxLines: 2,
        color: theme.colors.title,
        bold: true,
    });
}
function sourceObject(slide, theme) {
    if (!slide.sourceRefs?.length)
        return undefined;
    const prefix = theme.footer.sourcePrefix || "來源：";
    return textObject(slide, theme, `${slide.id}:source`, "source", `${prefix}${slide.sourceRefs.join("；")}`, getTextBox("footer", slide.layout, theme), {
        maxLines: 2,
    });
}
function blockObjects(slide, theme, blocks, box, role = "body", options = {}) {
    if (blocks.length === 0)
        return [];
    const requestedGap = options.gap ?? 0.12;
    const gap = blocks.length > 1 ? Math.min(requestedGap, box.h / (2 * (blocks.length - 1))) : 0;
    const itemHeight = box.h > 0 ? (box.h - gap * (blocks.length - 1)) / blocks.length : 0;
    return blocks.map((block, index) => textObject(slide, theme, `${slide.id}:text:${block.id}`, role, block.text, {
        x: box.x,
        y: box.y + index * (itemHeight + gap),
        w: box.w,
        h: itemHeight,
    }, { fontSize: options.fontSize }));
}
function imageObjects(slide, theme, assetIds, box) {
    if (assetIds.length === 0)
        return [];
    const columns = Math.min(assetIds.length, Math.max(1, Math.ceil(Math.sqrt(assetIds.length * 1.72))));
    const rows = Math.ceil(assetIds.length / columns);
    const gap = assetIds.length === 1 ? 0 : 0.14;
    const cellW = (box.w - gap * (columns - 1)) / columns;
    const cellH = (box.h - gap * (rows - 1)) / rows;
    return assetIds.map((assetId, index) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        return {
            kind: "image",
            id: `${slide.id}:image:${assetId}`,
            slideId: slide.id,
            assetId,
            alt: assetId,
            x: box.x + col * (cellW + gap),
            y: box.y + row * (cellH + gap),
            w: cellW,
            h: cellH,
            fit: theme.imageFit,
        };
    });
}
function shape(slide, id, box, options) {
    return {
        kind: "shape",
        id: `${slide.id}:${id}`,
        slideId: slide.id,
        ...box,
        shape: options.shape ?? "roundRect",
        fill: options.fill,
        stroke: options.stroke ?? "#00000000",
        strokeWidth: options.strokeWidth ?? 0,
    };
}
function comparisonObjects(slide, theme) {
    const content = getTextBox("content", slide.layout, theme);
    const gap = 0.28;
    const columnW = (content.w - gap) / 2;
    return slide.columns.flatMap((column, index) => {
        const x = content.x + index * (columnW + gap);
        const card = { x, y: content.y + 0.12, w: columnW, h: content.h - 0.18 };
        const columnTitle = textObject(slide, theme, `${slide.id}:${column.id}:title`, "comparison-heading", column.title, {
            x: x + (theme.spacing?.comfortable?.inches ?? 0.2), y: card.y + (theme.spacing?.comfortable?.inches ?? 0.2), w: card.w - (theme.spacing?.comfortable?.inches ?? 0.2) * 2, h: 0.72,
        }, { fontSize: theme.typography.title, minFontSize: theme.typography.minBody, color: theme.colors.title, bold: true, maxLines: 2 });
        const rows = blockObjects(slide, theme, column.blocks, {
            x: x + (theme.spacing?.comfortable?.inches ?? 0.2), y: card.y + 1.12, w: card.w - (theme.spacing?.comfortable?.inches ?? 0.2) * 2, h: card.h - 1.35,
        }, "body", { gap: 0.15 });
        return [shape(slide, `${column.id}:card`, card, { fill: theme.colors.surface, stroke: theme.colors.border, strokeWidth: 0.8 }), columnTitle, ...rows];
    });
}
function diagramObjects(slide, theme, diagram) {
    const area = getTextBox("content", slide.layout, theme);
    const rows = Math.ceil(Math.sqrt(diagram.nodes.length / 1.7));
    const columns = Math.ceil(diagram.nodes.length / rows);
    const gapX = 0.3;
    const gapY = 0.38;
    const nodeW = Math.min(2.55, (area.w - gapX * (columns - 1)) / columns);
    const nodeH = Math.min(0.86, (area.h - gapY * (rows - 1)) / rows);
    const gridW = columns * nodeW + (columns - 1) * gapX;
    const gridH = rows * nodeH + (rows - 1) * gapY;
    const left = area.x + (area.w - gridW) / 2;
    const top = area.y + (area.h - gridH) / 2;
    const positions = new Map();
    diagram.nodes.forEach((node, index) => {
        positions.set(node.id, {
            x: left + (index % columns) * (nodeW + gapX),
            y: top + Math.floor(index / columns) * (nodeH + gapY),
            w: nodeW,
            h: nodeH,
        });
    });
    const connectors = diagram.edges.map((edge, index) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        const fromCenterX = from.x + from.w / 2;
        const fromCenterY = from.y + from.h / 2;
        const toCenterX = to.x + to.w / 2;
        const toCenterY = to.y + to.h / 2;
        const deltaX = toCenterX - fromCenterX;
        const deltaY = toCenterY - fromCenterY;
        const length = Math.hypot(deltaX, deltaY);
        if (edge.from === edge.to || length === 0) {
            return {
                kind: "line",
                id: `${slide.id}:edge:${index + 1}`,
                slideId: slide.id,
                x: fromCenterX,
                y: fromCenterY,
                w: 0,
                h: 0,
                x1: fromCenterX,
                y1: fromCenterY,
                x2: fromCenterX,
                y2: fromCenterY,
                from: edge.from,
                to: edge.to,
                stroke: theme.colors.accent,
                strokeWidth: 1.4,
                endArrow: true,
            };
        }
        const unitX = length === 0 ? 0 : deltaX / length;
        const unitY = length === 0 ? 0 : deltaY / length;
        const borderDistance = (box, directionX, directionY) => Math.min(directionX === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(directionX), directionY === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(directionY));
        const endpointGap = 0.04;
        const fromDistance = borderDistance(from, unitX, unitY) + endpointGap;
        const toDistance = borderDistance(to, -unitX, -unitY) + endpointGap;
        const x1 = fromCenterX + unitX * fromDistance;
        const y1 = fromCenterY + unitY * fromDistance;
        const x2 = toCenterX - unitX * toDistance;
        const y2 = toCenterY - unitY * toDistance;
        return {
            kind: "line",
            id: `${slide.id}:edge:${index + 1}`,
            slideId: slide.id,
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            w: Math.abs(x2 - x1),
            h: Math.abs(y2 - y1),
            x1,
            y1,
            x2,
            y2,
            from: edge.from,
            to: edge.to,
            stroke: theme.colors.accent,
            strokeWidth: 1.4,
            endArrow: true,
        };
    });
    const edgeLabels = [];
    const placedEdgeLabelBoxes = [];
    diagram.edges.forEach((edge, index) => {
        if (!edge.label)
            return;
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        const x1 = from.x + from.w / 2;
        const y1 = from.y + from.h / 2;
        const x2 = to.x + to.w / 2;
        const y2 = to.y + to.h / 2;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);
        const normalX = length === 0 ? 0 : -dy / length;
        const normalY = length === 0 ? -1 : dx / length;
        const labelEm = Array.from(edge.label).reduce((width, character) => {
            if (/[\u2E80-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}\u{1F000}-\u{1FAFF}]/u.test(character))
                return width + 1;
            return width + (/\s/u.test(character) ? 0.28 : 0.54);
        }, 0);
        const labelW = Math.min(2.6, area.w, Math.max(0.75, labelEm * theme.typography.minBody / 72 + 0.16));
        const labelH = 0.38;
        const offset = (nodeW * Math.abs(normalX) + nodeH * Math.abs(normalY) + labelW * Math.abs(normalX) + labelH * Math.abs(normalY)) / 2 + 0.08;
        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        const labelBoxAt = (centerX, centerY) => ({ x: centerX - labelW / 2, y: centerY - labelH / 2, w: labelW, h: labelH });
        const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        const fits = (box) => box.x >= area.x - 1e-6
            && box.y >= area.y - 1e-6
            && box.x + box.w <= area.x + area.w + 1e-6
            && box.y + box.h <= area.y + area.h + 1e-6
            && !Array.from(positions.values()).some((nodeBox) => intersects(box, nodeBox))
            && !placedEdgeLabelBoxes.some((placed) => intersects(box, placed));
        const candidates = [];
        const tangentX = length === 0 ? 1 : dx / length;
        const tangentY = length === 0 ? 0 : dy / length;
        for (const distance of [offset, offset + 0.3]) {
            for (const side of [1, -1]) {
                for (const tangentShift of [0, 0.5, -0.5, 1, -1]) {
                    const centerX = clamp(midX + normalX * distance * side + tangentX * tangentShift, area.x + labelW / 2, area.x + area.w - labelW / 2);
                    const centerY = clamp(midY + normalY * distance * side + tangentY * tangentShift, area.y + labelH / 2, area.y + area.h - labelH / 2);
                    candidates.push(labelBoxAt(centerX, centerY));
                }
            }
        }
        const chosen = candidates.find(fits);
        const fallback = labelBoxAt(clamp(midX + normalX * offset, area.x + labelW / 2, area.x + area.w - labelW / 2), clamp(midY + normalY * offset, area.y + labelH / 2, area.y + area.h - labelH / 2));
        const box = chosen ?? fallback;
        placedEdgeLabelBoxes.push(box);
        edgeLabels.push(textObject(slide, theme, `${slide.id}:edge-label:${index + 1}`, "diagram-edge-label", edge.label, {
            ...box,
        }, { fontSize: theme.typography.minBody, minFontSize: theme.typography.minBody, color: theme.colors.body }));
    });
    const nodes = diagram.nodes.flatMap((node) => {
        const box = positions.get(node.id);
        const label = textObject(slide, theme, `${slide.id}:node-label:${node.id}`, "diagram-node", node.label, {
            x: box.x + 0.08, y: box.y + 0.08, w: box.w - 0.16, h: box.h - 0.16,
        }, { fontSize: theme.typography.body, minFontSize: theme.typography.minBody, color: theme.colors.title, bold: true, maxLines: 3 });
        return [shape(slide, `node:${node.id}`, box, { shape: "roundRect", fill: theme.colors.accentSoft, stroke: theme.colors.accent, strokeWidth: 1 }), label];
    });
    return [...connectors, ...edgeLabels, ...nodes];
}
function chartObject(slide, theme, chart) {
    const content = getTextBox("content", slide.layout, theme);
    const inset = theme.spacing?.comfortable?.inches ?? 0.2;
    const captionReserve = slide.blocks?.length ? 0.78 : 0;
    const { kind: chartKind, ...data } = chart;
    return {
        kind: "chart",
        id: `${slide.id}:chart`,
        slideId: slide.id,
        x: content.x + inset,
        y: content.y + inset,
        w: content.w - inset * 2,
        h: content.h - inset * 2 - captionReserve,
        ...data,
        chartKind,
    };
}
function weightedCharacters(text) {
    return Array.from(text).reduce((width, character) => {
        if (/[\u2E80-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}\u{1F000}-\u{1FAFF}]/u.test(character)) return width + 1;
        return width + (/\s/u.test(character) ? 0.28 : 0.54);
    }, 0);
}
function numericTableCell(value) {
    const normalized = String(value).trim().replace(/[\s,，]/gu, "");
    return /^(?:(?:NT|US)\$|[$€£¥￥])?[+-]?\d+(?:\.\d+)?(?:[-–~至][+-]?\d+(?:\.\d+)?)?(?:%|元|美元|台幣|USD|TWD|天|日|週|周|月|年|小時|分鐘|秒|個|件|次|倍|MB|GB|TB|ms|kg|km)?$/iu.test(normalized);
}
function estimatedCellLines(value, width, margin, fontSize) {
    const capacity = Math.max(1, ((width - margin[1] - margin[3]) * 72) / fontSize);
    return String(value).split("\n").reduce((sum, paragraph) => sum + Math.max(1, Math.ceil(weightedCharacters(paragraph) / capacity)), 0);
}
function tableObject(slide, theme, table) {
    const content = getTextBox("content", slide.layout, theme);
    const inset = theme.spacing?.comfortable?.inches ?? 0.2;
    const tableBox = {
        x: content.x + inset,
        y: content.y + inset,
        w: content.w - inset * 2,
        h: content.h - inset * 2 - (slide.blocks?.length ? 0.78 : 0),
    };
    const headerVertical = theme.spacing?.table?.headerVerticalEachInches ?? 0.079;
    const bodyVertical = theme.spacing?.table?.bodyVerticalEachInches ?? 0.098;
    const horizontal = theme.spacing?.table?.horizontalEachInches ?? 0.197;
    const headerCellMargin = [headerVertical, horizontal, headerVertical, horizontal];
    const bodyCellMargin = [bodyVertical, horizontal, bodyVertical, horizontal];
    const columnCount = table.columns.length;
    const firstColumnShare = columnCount === 1 ? 1 : columnCount === 2 ? 0.52 : 0.40;
    const otherColumnShare = columnCount > 1 ? (1 - firstColumnShare) / (columnCount - 1) : 0;
    const columnWidths = table.columns.map((_, index) => tableBox.w * (index === 0 ? firstColumnShare : otherColumnShare));
    const numericColumns = table.columns.map((_, columnIndex) => {
        if (columnIndex === 0) return false;
        const values = table.rows.map((row) => row[columnIndex]).filter((value) => String(value).trim().length > 0);
        return values.length > 0 && values.every(numericTableCell);
    }).flatMap((numeric, index) => numeric ? [index] : []);
    const fontSize = theme.typography.body;
    const minFontSize = theme.typography.minBody;
    const lineHeight = theme.typography.lineHeight;
    const lineHeightInches = Math.max(fontSize, minFontSize) * lineHeight / 72;
    const allRows = [table.columns, ...table.rows];
    const rowWeights = allRows.map((row, rowIndex) => {
        const margin = rowIndex === 0 ? headerCellMargin : bodyCellMargin;
        const maxLines = Math.max(1, ...row.map((text, columnIndex) => estimatedCellLines(text, columnWidths[columnIndex], margin, Math.max(fontSize, minFontSize))));
        const verticalPaddingLines = (margin[0] + margin[2]) / lineHeightInches;
        return maxLines + verticalPaddingLines + (rowIndex === 0 ? 0.6 : 0);
    });
    const totalWeight = rowWeights.reduce((sum, value) => sum + value, 0);
    const rowHeights = rowWeights.map((weight) => tableBox.h * weight / totalWeight);
    return {
        kind: "table",
        id: `${slide.id}:table`,
        slideId: slide.id,
        ...tableBox,
        ...table,
        columnWidths,
        rowHeights,
        numericColumns,
        headerCellMargin,
        bodyCellMargin,
        fontFace: theme.typography.fontFace,
        fontSize,
        minFontSize,
        lineHeight,
        color: theme.colors.body,
        headerFill: theme.colors.darkBackground,
        headerColor: theme.colors.white,
        numericColor: theme.colors.title,
    };
}
function optionalBlocks(slide) {
    return "blocks" in slide && slide.blocks ? slide.blocks : [];
}
function buildSlideLayoutBase(slide, theme) {
    const objects = [titleObject(slide, theme)];
    switch (slide.layout) {
        case "cover": {
            if (slide.subtitle) {
                objects.push(textObject(slide, theme, `${slide.id}:subtitle`, "subtitle", slide.subtitle, {
                    x: 0.95, y: 3.35, w: 11.43, h: 0.72,
                }, { fontSize: theme.typography.body, minFontSize: theme.typography.minBody, color: theme.colors.muted, maxLines: 2 }));
            }
            const blocks = optionalBlocks(slide);
            objects.push(...blockObjects(slide, theme, blocks, { x: 1.0, y: 4.35, w: 11.33, h: 1.3 }, "body"));
            break;
        }
        case "section":
        case "closing": {
            const blocks = optionalBlocks(slide);
            objects.push(...blockObjects(slide, theme, blocks, { x: 1.1, y: 3.75, w: 11.13, h: 1.4 }, "body", { fontSize: theme.typography.body }));
            break;
        }
        case "takeaway": {
            const card = { x: 0.7, y: 2.05, w: 11.933, h: 2.7 };
            objects.push(shape(slide, "takeaway-card", card, { fill: theme.colors.accentSoft, stroke: theme.colors.accent, strokeWidth: 1 }));
            objects.push(...blockObjects(slide, theme, slide.blocks, { x: 1.1, y: 2.45, w: 11.133, h: 1.9 }, "body", { fontSize: theme.typography.takeaway }));
            break;
        }
        case "bullets": {
            const area = { x: 0.57, y: 1.55, w: 12.24, h: 4.95 };
            const gap = 0.1;
            const compactInset = theme.spacing?.compact?.inches ?? 0.1;
            const itemH = (area.h - gap * (slide.blocks.length - 1)) / slide.blocks.length;
            slide.blocks.forEach((block, index) => {
                const y = area.y + index * (itemH + gap);
                objects.push(shape(slide, `bullet-marker:${block.id}`, { x: 0.73, y: y + (itemH - 0.14) / 2, w: 0.14, h: 0.14 }, { shape: "ellipse", fill: theme.colors.accent }));
                objects.push(textObject(slide, theme, `${slide.id}:text:${block.id}`, "bullet", block.text, { x: 1.07, y: y + compactInset, w: 11.5, h: itemH - compactInset * 2 }, {
                    fontSize: theme.typography.body, minFontSize: theme.typography.minBody,
                }));
            });
            break;
        }
        case "image-text": {
            const inset = theme.spacing?.comfortable?.inches ?? 0.2;
            const textArea = { x: 0.52 + inset, y: 1.49 + inset, w: 5.52 - inset * 2, h: 5.12 - inset * 2 };
            objects.push(...blockObjects(slide, theme, slide.blocks, textArea, "body", { gap: 0.14 }));
            objects.push(...imageObjects(slide, theme, slide.imageIds, { x: 6.24 + inset, y: 1.49 + inset, w: 6.56 - inset * 2, h: 5.12 - inset * 2 }));
            break;
        }
        case "comparison":
            objects.push(...comparisonObjects(slide, theme));
            break;
        case "image": {
            const content = getTextBox("image", slide.layout, theme);
            const blocks = optionalBlocks(slide);
            const imageBox = blocks.length ? { ...content, h: content.h - 0.65 } : content;
            objects.push(...imageObjects(slide, theme, slide.imageIds, imageBox));
            if (blocks.length)
                objects.push(...blockObjects(slide, theme, blocks, { x: content.x, y: content.y + content.h - 0.52, w: content.w, h: 0.44 }, "body", { fontSize: theme.typography.minBody }));
            break;
        }
        case "chart": {
            objects.push(chartObject(slide, theme, slide.chart));
            const blocks = optionalBlocks(slide);
            if (blocks.length)
                objects.push(...blockObjects(slide, theme, blocks, { x: 0.65, y: 6.1, w: 12.0, h: 0.55 }, "body", { fontSize: theme.typography.minBody }));
            break;
        }
        case "table": {
            objects.push(tableObject(slide, theme, slide.table));
            const blocks = optionalBlocks(slide);
            if (blocks.length)
                objects.push(...blockObjects(slide, theme, blocks, { x: 0.65, y: 6.1, w: 12.0, h: 0.55 }, "body", { fontSize: theme.typography.minBody }));
            break;
        }
        case "diagram":
            objects.push(...diagramObjects(slide, theme, slide.diagram));
            break;
    }
    const source = sourceObject(slide, theme);
    if (source)
        objects.push(source);
    return objects;
}


function designShape(slide, id, box, fill, stroke = "#00000000", strokeWidth = 0, shapeName = "roundRect") {
    return {
        kind: "shape",
        id: `${slide.id}:design:${id}`,
        slideId: slide.id,
        ...box,
        shape: shapeName,
        fill,
        stroke,
        strokeWidth,
    };
}

export function buildSlideLayout(slide, theme) {
    const sourceObjects = buildSlideLayoutBase(slide, theme);
    const colors = theme.colors;
    const dark = ["cover", "section", "closing"].includes(slide.layout);
    const backgroundObjects = [];
    const styledObjects = sourceObjects.map((object) => {
        if (object.kind !== "text") return object;
        if (dark) {
            const color = object.role === "title" ? colors.white
                : object.role === "source" ? colors.darkMuted
                    : object.role === "subtitle" ? colors.accentCyan
                        : colors.darkBody;
            return { ...object, color };
        }
        if (object.role === "title") return { ...object, color: colors.title };
        return object;
    });

    if (dark) {
        const title = styledObjects.find((object) => object.kind === "text" && object.role === "title");
        if (title) {
            const spaciousInset = theme.spacing?.spaciousMinInches ?? 0.315;
            const accentWidth = 0.075;
            backgroundObjects.push(designShape(slide, "dark-title-accent", {
                x: Math.max(theme.safeArea.left, title.x - spaciousInset - accentWidth),
                y: title.y + 0.16,
                w: 0.075,
                h: Math.min(0.96, Math.max(0.58, title.h - 0.28)),
            }, colors.accentCyan, "#00000000", 0, "rect"));
        }
    }
    else {
        backgroundObjects.push(designShape(slide, "title-rule", {
            x: theme.safeArea.left + 0.1,
            y: 1.445,
            w: 1.12,
            h: 0.045,
        }, colors.accentCyan, "#00000000", 0, "rect"));
    }

    if (slide.layout === "bullets") {
        for (const object of styledObjects) {
            if (object.kind === "text" && object.role === "bullet") {
                backgroundObjects.push(designShape(slide, `bullet-card:${object.id}`, {
                    x: 0.57,
                    y: object.y - (theme.spacing?.compact?.inches ?? 0.1),
                    w: 12.24,
                    h: Math.max(0.3, object.h + (theme.spacing?.compact?.inches ?? 0.1) * 2),
                }, colors.surface, colors.border, 0.55));
            }
        }
    }
    else if (slide.layout === "image-text") {
        backgroundObjects.push(designShape(slide, "image-text-copy-panel", {
            x: 0.52, y: 1.49, w: 5.52, h: 5.12,
        }, colors.surface, colors.border, 0.55));
        backgroundObjects.push(designShape(slide, "image-text-image-panel", {
            x: 6.24, y: 1.49, w: 6.56, h: 5.12,
        }, colors.surface, colors.border, 0.55));
    }
    else if (slide.layout === "chart" || slide.layout === "table") {
        backgroundObjects.push(designShape(slide, `${slide.layout}-panel`, {
            x: 0.50, y: 1.49, w: 12.32, h: 5.15,
        }, colors.surface, colors.border, 0.55));
    }

    const result = [];
    const nodeFills = [colors.accentSoft, colors.cyanSoft, colors.violetSoft, colors.warmSoft];
    let nodeIndex = 0;
    for (const object of styledObjects) {
        if (object.kind === "shape" && object.id.endsWith(":card")) {
            const card = { ...object, fill: colors.surface, stroke: colors.border, strokeWidth: 0.7 };
            result.push(card);
            result.push(designShape(slide, `comparison-accent:${object.id}`, {
                x: object.x + 0.3,
                y: object.y + 0.23,
                w: 0.72,
                h: 0.06,
            }, colors.accentCyan, "#00000000", 0, "rect"));
            continue;
        }
        if (object.kind === "shape" && object.id.endsWith(":takeaway-card")) {
            result.push({ ...object, fill: colors.cyanSoft, stroke: colors.border, strokeWidth: 0.65 });
            result.push(designShape(slide, "takeaway-accent", {
                x: object.x,
                y: object.y,
                w: 0.10,
                h: object.h,
            }, colors.accentCyan, "#00000000", 0, "rect"));
            continue;
        }
        if (object.kind === "shape" && object.id.includes(":node:")) {
            result.push({ ...object, fill: nodeFills[nodeIndex++ % nodeFills.length], stroke: colors.accent, strokeWidth: 0.85 });
            continue;
        }
        if (object.kind === "line" && object.id.includes(":edge:")) {
            result.push({ ...object, stroke: colors.muted, strokeWidth: 1.25 });
            continue;
        }
        result.push(object);
    }
    return [...backgroundObjects, ...result];
}
