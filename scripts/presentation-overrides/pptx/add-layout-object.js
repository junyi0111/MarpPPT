function fontFaceForTheme(theme) {
    const faces = theme.typography.fontFace.split(",").map((face) => face.trim()).filter(Boolean);
    return faces.find((face) => face.toLowerCase() === "noto sans cjk tc") ?? faces[0] ?? "Noto Sans CJK TC";
}
function colorStyle(value) {
    const color = value.replace(/^#/u, "").toUpperCase();
    if (/^[\da-f]{8}$/u.test(color)) {
        const alpha = Number.parseInt(color.slice(6), 16);
        return { color: color.slice(0, 6), transparency: Math.round((1 - alpha / 255) * 100) };
    }
    return { color };
}
function objectName(id) {
    return { objectName: id.slice(0, 250) };
}
function addText(object, context) {
    const fontSize = Math.max(object.fontSize, object.minFontSize);
    context.slide.addText(object.text, {
        x: object.x,
        y: object.y,
        w: object.w,
        h: object.h,
        fontFace: fontFaceForTheme(context.theme),
        fontSize,
        color: colorStyle(object.color).color,
        bold: object.bold ?? false,
        margin: 0,
        breakLine: false,
        valign: "mid",
        wrap: true,
        fit: "none",
        paraSpaceAfterPt: 0,
        ...objectName(object.id),
    });
}
function shapeType(pptx, name) {
    const types = {
        rect: pptx.ShapeType.rect,
        roundRect: pptx.ShapeType.roundRect,
        ellipse: pptx.ShapeType.ellipse,
        diamond: pptx.ShapeType.diamond,
    };
    return types[name];
}
function addShape(object, context) {
    context.slide.addShape(shapeType(context.pptx, object.shape), {
        x: object.x,
        y: object.y,
        w: object.w,
        h: object.h,
        fill: colorStyle(object.fill),
        line: { ...colorStyle(object.stroke), width: object.strokeWidth },
        ...objectName(object.id),
    });
}
function addLine(object, context) {
    const x = Math.min(object.x1, object.x2);
    const y = Math.min(object.y1, object.y2);
    const w = Math.abs(object.x2 - object.x1);
    const h = Math.abs(object.y2 - object.y1);
    context.slide.addShape(context.pptx.ShapeType.line, {
        x,
        y,
        w,
        h,
        flipH: object.x1 > object.x2,
        flipV: object.y1 > object.y2,
        line: {
            ...colorStyle(object.stroke),
            width: object.strokeWidth,
            endArrowType: object.endArrow ? "triangle" : "none",
        },
        ...objectName(object.id),
    });
}
function addImage(object, context) {
    const asset = context.assets.get(object.assetId);
    if (!asset)
        throw new Error(`Resolved image path is missing for asset ${object.assetId}`);
    context.slide.addImage({
        path: asset.path,
        x: object.x,
        y: object.y,
        w: object.w,
        h: object.h,
        sizing: { type: object.fit, w: object.w, h: object.h },
        altText: object.alt,
        ...objectName(object.id),
    });
}
function addTable(object, context) {
    const fontSize = Math.max(object.fontSize, object.minFontSize);
    const borderColor = colorStyle(context.theme.colors.border).color;
    const numericColumns = new Set(object.numericColumns ?? []);
    const headerMargin = object.headerCellMargin ?? [0.079, 0.197, 0.079, 0.197];
    const bodyMargin = object.bodyCellMargin ?? [0.098, 0.197, 0.098, 0.197];
    const rows = [object.columns, ...object.rows].map((row, rowIndex) => row.map((text, columnIndex) => {
        const header = rowIndex === 0;
        const numeric = numericColumns.has(columnIndex);
        return {
            text,
            options: {
                fontFace: fontFaceForTheme(context.theme),
                fontSize,
                color: colorStyle(header ? object.headerColor : numeric ? object.numericColor : object.color).color,
                bold: header || columnIndex === 0 || numeric,
                ...(header ? { fill: colorStyle(object.headerFill) } : {}),
                align: header ? "center" : numeric ? "right" : "left",
                margin: header ? headerMargin : bodyMargin,
                valign: "mid",
                lineSpacingMultiple: object.lineHeight ?? 1.2,
            },
        };
    }));
    context.slide.addTable(rows, {
        x: object.x,
        y: object.y,
        w: object.w,
        h: object.h,
        colW: object.columnWidths ?? Array.from({ length: object.columns.length }, () => object.w / object.columns.length),
        rowH: object.rowHeights ?? object.h / (object.rows.length + 1),
        fontFace: fontFaceForTheme(context.theme),
        fontSize,
        color: colorStyle(object.color).color,
        border: { type: "solid", color: borderColor, pt: 0.7 },
        margin: bodyMargin,
        valign: "mid",
        autoPage: false,
        ...objectName(object.id),
    });
}
function addChart(object, context) {
    const type = context.pptx.ChartType[object.chartKind];
    const axisLabelFontSize = Math.max(context.theme.typography.minNote, 12);
    const data = object.series.map((series) => ({
        name: series.name,
        labels: object.labels,
        values: series.values,
    }));
    context.slide.addChart(type, data, {
        x: object.x,
        y: object.y,
        w: object.w,
        h: object.h,
        showLegend: object.series.length > 1,
        showTitle: false,
        showValue: object.chartKind === "pie",
        showLabel: object.chartKind === "pie",
        chartColors: (context.theme.colors.chartSeries ?? [context.theme.colors.accent, context.theme.colors.accentCyan, context.theme.colors.title, context.theme.colors.muted])
            .map((color) => colorStyle(color).color),
        catAxisLabelFontFace: fontFaceForTheme(context.theme),
        valAxisLabelFontFace: fontFaceForTheme(context.theme),
        catAxisLabelFontSize: axisLabelFontSize,
        valAxisLabelFontSize: axisLabelFontSize,
        valGridLine: { color: colorStyle(context.theme.colors.border).color, width: 0.6 },
        showCatName: false,
        showSerName: false,
        showPercent: object.chartKind === "pie",
        ...objectName(object.id),
    });
}
export function addLayoutObject(object, context) {
    switch (object.kind) {
        case "text":
            addText(object, context);
            return;
        case "shape":
            addShape(object, context);
            return;
        case "line":
            addLine(object, context);
            return;
        case "image":
            addImage(object, context);
            return;
        case "table":
            addTable(object, context);
            return;
        case "chart":
            addChart(object, context);
            return;
        default:
            return assertNever(object);
    }
}
function assertNever(value) {
    throw new Error(`Unsupported layout object: ${JSON.stringify(value)}`);
}
