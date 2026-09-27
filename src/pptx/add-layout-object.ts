import type { AssetManifestEntry } from "../contracts/presentation-plan.js";
import type {
  ChartLayoutObject,
  ImageLayoutObject,
  LayoutObject,
  LineLayoutObject,
  ShapeLayoutObject,
  TableLayoutObject,
  TextLayoutObject,
} from "../layout/build-slide.js";
import type { Theme } from "../layout/geometry.js";

export interface ResolvedPptxAsset extends AssetManifestEntry {
  path: string;
}

export interface PptxApi {
  ShapeType: { rect: string; roundRect: string; ellipse: string; diamond: string; line: string };
  ChartType: { bar: string; line: string; pie: string };
}

export interface PptxSlideApi {
  addText(text: string, options: Record<string, unknown>): unknown;
  addShape(shapeName: string, options: Record<string, unknown>): unknown;
  addImage(options: Record<string, unknown>): unknown;
  addTable(rows: unknown[], options: Record<string, unknown>): unknown;
  addChart(chartType: string, data: unknown[], options: Record<string, unknown>): unknown;
}

export interface LayoutObjectContext {
  pptx: PptxApi;
  slide: PptxSlideApi;
  assets: ReadonlyMap<string, ResolvedPptxAsset>;
  theme: Theme;
}

function fontFaceForTheme(theme: Theme): string {
  const faces = theme.typography.fontFace.split(",").map((face) => face.trim()).filter(Boolean);
  return faces.find((face) => face.toLowerCase() === "noto sans cjk tc") ?? faces[0] ?? "Noto Sans CJK TC";
}

function colorStyle(value: string): { color: string; transparency?: number } {
  const color = value.replace(/^#/u, "").toUpperCase();
  if (/^[\da-f]{8}$/u.test(color)) {
    const alpha = Number.parseInt(color.slice(6), 16);
    return { color: color.slice(0, 6), transparency: Math.round((1 - alpha / 255) * 100) };
  }
  return { color };
}

function objectName(id: string): { objectName: string } {
  return { objectName: id.slice(0, 250) };
}

function addText(object: TextLayoutObject, context: LayoutObjectContext): void {
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
    align: object.align ?? (object.role === "diagram-node" || object.role === "diagram-edge-label" ? "center" : "left"),
    margin: 0,
    breakLine: false,
    valign: "mid",
    wrap: true,
    fit: "none",
    paraSpaceAfterPt: 0,
    ...objectName(object.id),
  });
}

function shapeType(pptx: PptxApi, name: ShapeLayoutObject["shape"]): string {
  const types: Record<ShapeLayoutObject["shape"], string> = {
    rect: pptx.ShapeType.rect,
    roundRect: pptx.ShapeType.roundRect,
    ellipse: pptx.ShapeType.ellipse,
    diamond: pptx.ShapeType.diamond,
  };
  return types[name];
}

function addShape(object: ShapeLayoutObject, context: LayoutObjectContext): void {
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

function addLine(object: LineLayoutObject, context: LayoutObjectContext): void {
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

function addImage(object: ImageLayoutObject, context: LayoutObjectContext): void {
  const asset = context.assets.get(object.assetId);
  if (!asset) throw new Error(`Resolved image path is missing for asset ${object.assetId}`);
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

function addTable(object: TableLayoutObject, context: LayoutObjectContext): void {
  const fontSize = Math.max(object.fontSize, object.minFontSize);
  const borderColor = colorStyle(context.theme.colors.border).color;
  const numericColumns = new Set(object.numericColumns ?? []);
  const headerMargin = object.headerCellMargin ?? [0.079, 0.197, 0.079, 0.197];
  const bodyMargin = object.bodyCellMargin ?? [0.098, 0.197, 0.098, 0.197];
  const rows = [object.columns, ...object.rows].map((row, rowIndex) => row.map((text, columnIndex) => ({
    text,
    options: {
      fontFace: fontFaceForTheme(context.theme),
      fontSize,
      color: colorStyle(rowIndex === 0 ? (object.headerColor ?? "#FFFFFF") : numericColumns.has(columnIndex) ? (object.numericColor ?? context.theme.colors.title) : object.color).color,
      bold: rowIndex === 0 || columnIndex === 0 || numericColumns.has(columnIndex),
      ...(rowIndex === 0 ? { fill: colorStyle(object.headerFill) } : {}),
      align: rowIndex === 0 ? "center" : numericColumns.has(columnIndex) ? "right" : "left",
      margin: rowIndex === 0 ? headerMargin : bodyMargin,
      valign: "mid",
      lineSpacingMultiple: object.lineHeight ?? 1.2,
    },
  })));
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

function addChart(object: ChartLayoutObject, context: LayoutObjectContext): void {
  const type = context.pptx.ChartType[object.chartKind];
  const axisLabelFontSize = Math.max(context.theme.typography.minBody, 18);
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
    chartColors: (context.theme.colors.chartSeries ?? [context.theme.colors.accent, context.theme.colors.accentCyan ?? context.theme.colors.accent, context.theme.colors.title, context.theme.colors.muted])
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

export function addLayoutObject(object: LayoutObject, context: LayoutObjectContext): void {
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

function assertNever(value: never): never {
  throw new Error(`Unsupported layout object: ${JSON.stringify(value)}`);
}

export type { ChartLayoutObject, TableLayoutObject };
