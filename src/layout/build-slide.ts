import type {
  ChartData,
  ComparisonColumn,
  DiagramData,
  SlidePlan,
  TableData,
  TextBlock,
} from "../contracts/presentation-plan.js";
import { normalizeMathText } from "../content/math-text.js";
import { parseMetricComparison } from "../content/metric-comparison.js";
import { getTextBox, type Box, type Theme } from "./geometry.js";

export type TextRole = "title" | "subtitle" | "body" | "bullet" | "comparison-heading" | "diagram-node" | "diagram-edge-label" | "source" | "label" | "metric-before" | "metric-after" | "metric-arrow" | "metric-label";

interface LayoutBase extends Box {
  id: string;
  slideId: string;
}

export interface TextLayoutObject extends LayoutBase {
  kind: "text";
  role: TextRole;
  text: string;
  fontFace: string;
  fontSize: number;
  minFontSize: number;
  lineHeight: number;
  maxLines?: number;
  color: string;
  bold?: boolean;
  align?: "left" | "center" | "right";
}

export interface ImageLayoutObject extends LayoutBase {
  kind: "image";
  assetId: string;
  alt: string;
  fit: "contain" | "cover";
}

export interface ShapeLayoutObject extends LayoutBase {
  kind: "shape";
  shape: "rect" | "roundRect" | "ellipse" | "diamond";
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface TableLayoutObject extends LayoutBase {
  kind: "table";
  columns: string[];
  rows: string[][];
  fontFace: string;
  fontSize: number;
  minFontSize: number;
  color: string;
  headerFill: string;
  headerColor?: string;
  numericColor?: string;
  numericColumns?: number[];
  columnWidths?: number[];
  rowHeights?: number[];
  headerCellMargin?: [number, number, number, number];
  bodyCellMargin?: [number, number, number, number];
  lineHeight?: number;
}

export interface ChartLayoutObject extends LayoutBase, Omit<ChartData, "kind"> {
  kind: "chart";
  chartKind: ChartData["kind"];
}

export interface LineLayoutObject extends LayoutBase {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  from: string;
  to: string;
  stroke: string;
  strokeWidth: number;
  endArrow: boolean;
}

export type LayoutObject = TextLayoutObject | ImageLayoutObject | ShapeLayoutObject | TableLayoutObject | ChartLayoutObject | LineLayoutObject;

function textObject(
  slide: SlidePlan,
  theme: Theme,
  id: string,
  role: TextRole,
  text: string,
  box: Box,
  options: { fontSize?: number; minFontSize?: number; maxLines?: number; color?: string; bold?: boolean; align?: TextLayoutObject["align"] } = {},
): TextLayoutObject {
  const note = role === "source";
  return {
    kind: "text",
    id,
    slideId: slide.id,
    ...box,
    role,
    text: normalizeMathText(text),
    fontFace: theme.typography.fontFace,
    fontSize: options.fontSize ?? (note ? theme.typography.note : theme.typography.body),
    minFontSize: options.minFontSize ?? (note ? theme.typography.minNote : theme.typography.minBody),
    lineHeight: theme.typography.lineHeight,
    ...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }),
    color: options.color ?? (note ? theme.colors.muted : theme.colors.body),
    ...(options.bold === undefined ? {} : { bold: options.bold }),
    ...(options.align === undefined ? {} : { align: options.align }),
  };
}

function titleObject(slide: SlidePlan, theme: Theme): TextLayoutObject {
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

function sourceObject(slide: SlidePlan, theme: Theme): TextLayoutObject | undefined {
  if (!slide.sourceRefs?.length) return undefined;
  const prefix = theme.footer.sourcePrefix || "來源：";
  const references = slide.sourceRefs
    .map((reference) => reference.replace(/^\s*#{1,6}\s*/u, "").replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  if (references.length === 0) return undefined;
  return textObject(slide, theme, `${slide.id}:source`, "source", `${prefix}${references.join("；")}`, getTextBox("footer", slide.layout, theme), {
    maxLines: 2,
  });
}

function blockObjects(
  slide: SlidePlan,
  theme: Theme,
  blocks: TextBlock[],
  box: Box,
  role: "body" | "bullet" = "body",
  options: { gap?: number; fontSize?: number } = {},
): LayoutObject[] {
  if (blocks.length === 0) return [];
  const requestedGap = options.gap ?? 0.12;
  const gap = blocks.length > 1 ? Math.min(requestedGap, box.h / (2 * (blocks.length - 1))) : 0;
  const itemHeight = box.h > 0 ? (box.h - gap * (blocks.length - 1)) / blocks.length : 0;
  return blocks.flatMap((block, index) => {
    const blockBox = {
      x: box.x,
      y: box.y + index * (itemHeight + gap),
      w: box.w,
      h: itemHeight,
    };
    const metric = metricComparisonObjects(slide, theme, block.id, block.text, blockBox, options.fontSize);
    return metric ?? [textObject(slide, theme, `${slide.id}:text:${block.id}`, role, block.text, blockBox, { fontSize: options.fontSize })];
  });
}

function metricComparisonObjects(
  slide: SlidePlan,
  theme: Theme,
  blockId: string,
  text: string,
  box: Box,
  requestedFontSize?: number,
): LayoutObject[] | undefined {
  // Short captions do not have enough vertical room for the visual treatment.
  if (box.w < 4 || box.h < 0.85) return undefined;
  const metric = parseMetricComparison(text);
  if (!metric) return undefined;

  const baseFontSize = requestedFontSize ?? theme.typography.body;
  const labelHeight = Math.min(0.34, Math.max(0.24, box.h * 0.24));
  const valueY = box.y + labelHeight + 0.04;
  const valueH = Math.max(0.42, box.h - labelHeight - 0.04);
  const gap = Math.min(0.22, Math.max(0.12, box.w * 0.015));
  const arrowW = Math.min(0.72, Math.max(0.5, box.w * 0.07));
  const valueW = Math.max(1.4, box.w - arrowW - gap * 2);
  const beforeW = valueW * 0.36;
  const afterW = valueW - beforeW;
  const beforeBox = { x: box.x, y: valueY, w: beforeW, h: valueH };
  const arrowBox = { x: beforeBox.x + beforeBox.w + gap, y: valueY, w: arrowW, h: valueH };
  const afterBox = { x: arrowBox.x + arrowBox.w + gap, y: valueY, w: afterW, h: valueH };
  const labelFontSize = Math.max(theme.typography.minBody, Math.round(baseFontSize * 0.75));
  const idPrefix = `${slide.id}:metric:${blockId}`;

  return [
    textObject(slide, theme, `${idPrefix}:label`, "metric-label", metric.context, {
      x: box.x, y: box.y, w: box.w, h: labelHeight,
    }, { fontSize: labelFontSize, minFontSize: labelFontSize, color: theme.colors.muted, bold: true, align: "center", maxLines: 1 }),
    textObject(slide, theme, `${idPrefix}:before`, "metric-before", metric.before, beforeBox, {
      fontSize: baseFontSize, minFontSize: baseFontSize, color: theme.colors.muted, bold: true, align: "center", maxLines: 1,
    }),
    textObject(slide, theme, `${idPrefix}:arrow`, "metric-arrow", "→", arrowBox, {
      fontSize: Math.max(theme.typography.minBody, Math.round(baseFontSize * 0.9)),
      minFontSize: theme.typography.minBody,
      color: theme.colors.accent,
      bold: true,
      align: "center",
      maxLines: 1,
    }),
    textObject(slide, theme, `${idPrefix}:after`, "metric-after", metric.after, afterBox, {
      fontSize: baseFontSize * metric.scale,
      minFontSize: baseFontSize * metric.scale,
      color: theme.colors.accent,
      bold: true,
      align: "center",
      maxLines: 1,
    }),
  ];
}

function imageObjects(slide: SlidePlan, theme: Theme, assetIds: string[], box: Box): ImageLayoutObject[] {
  if (assetIds.length === 0) return [];
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

function shape(
  slide: SlidePlan,
  id: string,
  box: Box,
  options: { shape?: ShapeLayoutObject["shape"]; fill: string; stroke?: string; strokeWidth?: number },
): ShapeLayoutObject {
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

function comparisonObjects(slide: Extract<SlidePlan, { layout: "comparison" }>, theme: Theme): LayoutObject[] {
  const content = getTextBox("content", slide.layout, theme);
  const gap = 0.28;
  const columnW = (content.w - gap) / 2;
  return slide.columns.flatMap((column, index) => {
    const x = content.x + index * (columnW + gap);
    const card = { x, y: content.y + 0.12, w: columnW, h: content.h - 0.18 };
    const columnTitle = textObject(slide, theme, `${slide.id}:${column.id}:title`, "comparison-heading", column.title, {
      x: x + 0.28, y: card.y + 0.24, w: card.w - 0.56, h: 0.72,
    }, { fontSize: theme.typography.title, minFontSize: theme.typography.minBody, color: theme.colors.title, bold: true, maxLines: 2 });
    const rows = blockObjects(slide, theme, column.blocks, {
      x: x + 0.34, y: card.y + 1.12, w: card.w - 0.68, h: card.h - 1.35,
    }, "body", { gap: 0.15 });
    return [shape(slide, `${column.id}:card`, card, { fill: theme.colors.surface, stroke: theme.colors.border, strokeWidth: 0.8 }), columnTitle, ...rows];
  });
}

function diagramObjects(slide: Extract<SlidePlan, { layout: "diagram" }>, theme: Theme, diagram: DiagramData): LayoutObject[] {
  const area = getTextBox("content", slide.layout, theme);
  // Short flows need to read left-to-right. The old square-root grid placed a
  // two-node flow in one narrow vertical column, leaving most of the slide
  // empty and making its connector look like a stray line.
  const rows = diagram.nodes.length <= 3 ? 1 : Math.ceil(Math.sqrt(diagram.nodes.length / 1.7));
  const columns = Math.ceil(diagram.nodes.length / rows);
  const gapX = rows === 1
    ? (diagram.nodes.length === 2 ? 1.65 : 0.8)
    : columns <= 2 ? 0.9 : 0.55;
  const gapY = rows === 1 ? 0 : rows <= 2 ? 0.55 : 0.45;
  const maxNodeW = rows === 1 ? (diagram.nodes.length === 2 ? 5.2 : 4.4) : columns <= 2 ? 4.6 : 3.2;
  const nodeW = Math.min(maxNodeW, (area.w - gapX * (columns - 1)) / columns);
  const maxNodeH = rows === 1 ? 1.15 : rows <= 2 ? 1.0 : 0.86;
  const nodeH = Math.min(maxNodeH, (area.h - gapY * (rows - 1)) / rows);
  const gridW = columns * nodeW + (columns - 1) * gapX;
  const gridH = rows * nodeH + (rows - 1) * gapY;
  const left = area.x + (area.w - gridW) / 2;
  const top = area.y + (area.h - gridH) / 2;
  const positions = new Map<string, Box>();
  diagram.nodes.forEach((node, index) => {
    positions.set(node.id, {
      x: left + (index % columns) * (nodeW + gapX),
      y: top + Math.floor(index / columns) * (nodeH + gapY),
      w: nodeW,
      h: nodeH,
    });
  });

  const connectors: LineLayoutObject[] = diagram.edges.map((edge, index) => {
    const from = positions.get(edge.from)!;
    const to = positions.get(edge.to)!;
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
        strokeWidth: 1.8,
        endArrow: true,
      };
    }
    const unitX = length === 0 ? 0 : deltaX / length;
    const unitY = length === 0 ? 0 : deltaY / length;
    const borderDistance = (box: Box, directionX: number, directionY: number) => Math.min(
      directionX === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(directionX),
      directionY === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(directionY),
    );
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
      strokeWidth: 1.8,
      endArrow: true,
    };
  });

  const edgeLabels: TextLayoutObject[] = [];
  const placedEdgeLabelBoxes: Box[] = [];
  diagram.edges.forEach((edge, index) => {
    if (!edge.label) return;
    const from = positions.get(edge.from)!;
    const to = positions.get(edge.to)!;
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
      if (/[\u2E80-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}\u{1F000}-\u{1FAFF}]/u.test(character)) return width + 1;
      return width + (/\s/u.test(character) ? 0.28 : 0.54);
    }, 0);
    const labelW = Math.min(2.6, area.w, Math.max(0.75, labelEm * theme.typography.minBody / 72 + 0.16));
    const labelH = 0.38;
    const offset = (nodeW * Math.abs(normalX) + nodeH * Math.abs(normalY) + labelW * Math.abs(normalX) + labelH * Math.abs(normalY)) / 2 + 0.08;
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const labelBoxAt = (centerX: number, centerY: number): Box => ({ x: centerX - labelW / 2, y: centerY - labelH / 2, w: labelW, h: labelH });
    const intersects = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const fits = (box: Box) => box.x >= area.x - 1e-6
      && box.y >= area.y - 1e-6
      && box.x + box.w <= area.x + area.w + 1e-6
      && box.y + box.h <= area.y + area.h + 1e-6
      && !Array.from(positions.values()).some((nodeBox) => intersects(box, nodeBox))
      && !placedEdgeLabelBoxes.some((placed) => intersects(box, placed));
    const candidates: Box[] = [];
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
    const fallback = labelBoxAt(
      clamp(midX + normalX * offset, area.x + labelW / 2, area.x + area.w - labelW / 2),
      clamp(midY + normalY * offset, area.y + labelH / 2, area.y + area.h - labelH / 2),
    );
    const box = chosen ?? fallback;
    placedEdgeLabelBoxes.push(box);
    edgeLabels.push(textObject(slide, theme, `${slide.id}:edge-label:${index + 1}`, "diagram-edge-label", edge.label, {
      ...box,
    }, { fontSize: theme.typography.minBody, minFontSize: theme.typography.minBody, color: theme.colors.body }));
  });

  const nodes: LayoutObject[] = diagram.nodes.flatMap((node) => {
    const box = positions.get(node.id)!;
    const label = textObject(slide, theme, `${slide.id}:node-label:${node.id}`, "diagram-node", node.label, {
      x: box.x + 0.08, y: box.y + 0.08, w: box.w - 0.16, h: box.h - 0.16,
    }, { fontSize: theme.typography.body, minFontSize: theme.typography.minBody, color: theme.colors.title, bold: true, maxLines: 3 });
    return [shape(slide, `node:${node.id}`, box, { shape: "roundRect", fill: theme.colors.accentSoft, stroke: theme.colors.accent, strokeWidth: 1 }), label];
  });
  return [...connectors, ...edgeLabels, ...nodes];
}

function chartObject(slide: Extract<SlidePlan, { layout: "chart" }>, theme: Theme, chart: ChartData): ChartLayoutObject {
  const box = getTextBox("content", slide.layout, theme);
  const inset = theme.spacing?.comfortable?.inches ?? 0.2;
  const captionReserve = slide.blocks?.length ? 0.78 : 0;
  const { kind: chartKind, ...data } = chart;
  return {
    kind: "chart", id: `${slide.id}:chart`, slideId: slide.id,
    x: box.x + inset, y: box.y + inset, w: box.w - inset * 2, h: box.h - inset * 2 - captionReserve,
    ...data,
    labels: data.labels.map(normalizeMathText),
    series: data.series.map((series) => ({ ...series, name: normalizeMathText(series.name) })),
    chartKind,
  };
}

function tableObject(slide: Extract<SlidePlan, { layout: "table" }>, theme: Theme, table: TableData): TableLayoutObject {
  const box = getTextBox("content", slide.layout, theme);
  const footerGap = slide.blocks?.length ? 0.78 : 0;
  const tableBox = {
    x: box.x + 0.2,
    y: box.y + 0.2,
    w: box.w - 0.4,
    h: box.h - 0.4 - footerGap,
  };
  const columnCount = table.columns.length;
  const firstColumnShare = columnCount <= 1 ? 1 : columnCount === 2 ? 0.52 : 0.40;
  const otherColumnShare = columnCount <= 1 ? 0 : (1 - firstColumnShare) / Math.max(1, columnCount - 1);
  const columnWidths = table.columns.map((_, index) => tableBox.w * (index === 0 ? firstColumnShare : otherColumnShare));
  const isNumeric = (value: string): boolean => /^[-+]?\s*\d[\d,]*(?:\.\d+)?\s*(?:%|[A-Za-z°µμ¥€£元小時分秒天月年件公里公斤]+)?$/u.test(value.trim());
  const numericColumns = table.columns.map((_, columnIndex) => {
    const values = table.rows.map((row) => row[columnIndex]).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return values.length > 0 && values.every(isNumeric) ? columnIndex : -1;
  }).filter((index) => index >= 0);
  const headerVertical = theme.spacing?.table?.headerVerticalEachInches ?? 0.079;
  const bodyVertical = theme.spacing?.table?.bodyVerticalEachInches ?? 0.098;
  const horizontal = theme.spacing?.table?.horizontalEachInches ?? 0.197;
  const headerCellMargin: [number, number, number, number] = [headerVertical, horizontal, headerVertical, horizontal];
  const bodyCellMargin: [number, number, number, number] = [bodyVertical, horizontal, bodyVertical, horizontal];
  const estimateLines = (value: string, width: number, margin: [number, number, number, number]): number => {
    const capacity = Math.max(1, ((width - margin[1] - margin[3]) * 72) / theme.typography.body);
    let lines = 1;
    let used = 0;
    for (const character of Array.from(value)) {
      const weight = /[\u2E80-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u.test(character) ? 1 : 0.54;
      if (used > 0 && used + weight > capacity) {
        lines += 1;
        used = weight;
      } else {
        used += weight;
      }
    }
    return lines;
  };
  const lineHeightInches = Math.max(theme.typography.body, theme.typography.minBody) * theme.typography.lineHeight / 72;
  const rowWeights = [table.columns, ...table.rows].map((row, rowIndex) => {
    const margin = rowIndex === 0 ? headerCellMargin : bodyCellMargin;
    const maxLines = Math.max(1, ...row.map((value, columnIndex) => estimateLines(value, columnWidths[columnIndex] ?? tableBox.w, margin)));
    const verticalPaddingLines = (margin[0] + margin[2]) / lineHeightInches;
    return maxLines + verticalPaddingLines + (rowIndex === 0 ? 0.6 : 0);
  });
  const totalWeight = rowWeights.reduce((sum, weight) => sum + weight, 0);
  const rowHeights = rowWeights.map((weight) => tableBox.h * weight / totalWeight);
  return {
    kind: "table",
    id: `${slide.id}:table`,
    slideId: slide.id,
    ...tableBox,
    ...table,
    columns: table.columns.map(normalizeMathText),
    rows: table.rows.map((row) => row.map(normalizeMathText)),
    fontFace: theme.typography.fontFace,
    fontSize: theme.typography.body,
    minFontSize: theme.typography.minBody,
    color: theme.colors.body,
    headerFill: theme.colors.darkBackground ?? theme.colors.accentSoft,
    headerColor: theme.colors.white,
    numericColor: theme.colors.title,
    numericColumns,
    columnWidths,
    rowHeights,
    headerCellMargin,
    bodyCellMargin,
    lineHeight: 1.2,
  };
}

function optionalBlocks(slide: SlidePlan): TextBlock[] {
  return "blocks" in slide && slide.blocks ? slide.blocks : [];
}

export function buildSlideLayout(slide: SlidePlan, theme: Theme): LayoutObject[] {
  const objects: LayoutObject[] = [titleObject(slide, theme)];

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
      const area = { x: 0.92, y: 1.55, w: 11.85, h: 4.95 };
      const gap = 0.1;
      const compactInset = theme.spacing?.compact?.inches ?? 0.1;
      const itemH = (area.h - gap * (slide.blocks.length - 1)) / slide.blocks.length;
      slide.blocks.forEach((block, index) => {
        const y = area.y + index * (itemH + gap);
        objects.push(shape(slide, `bullet-marker:${block.id}`, { x: 0.68, y: y + 0.25, w: 0.14, h: 0.14 }, { shape: "ellipse", fill: theme.colors.accent }));
        objects.push(...blockObjects(slide, theme, [block], { x: area.x + compactInset, y: y + compactInset, w: area.w - compactInset * 2, h: itemH - compactInset * 2 }, "bullet", {
          fontSize: theme.typography.body,
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
      if (blocks.length) objects.push(...blockObjects(slide, theme, blocks, { x: content.x, y: content.y + content.h - 0.52, w: content.w, h: 0.44 }, "body", { fontSize: theme.typography.minBody }));
      break;
    }
    case "chart": {
      objects.push(chartObject(slide, theme, slide.chart));
      const blocks = optionalBlocks(slide);
      if (blocks.length) objects.push(...blockObjects(slide, theme, blocks, { x: 0.65, y: 6.1, w: 12.0, h: 0.55 }, "body", { fontSize: theme.typography.minBody }));
      break;
    }
    case "table": {
      objects.push(tableObject(slide, theme, slide.table));
      const blocks = optionalBlocks(slide);
      if (blocks.length) objects.push(...blockObjects(slide, theme, blocks, { x: 0.65, y: 6.1, w: 12.0, h: 0.55 }, "body", { fontSize: theme.typography.minBody }));
      break;
    }
    case "diagram":
      objects.push(...diagramObjects(slide, theme, slide.diagram));
      break;
  }

  const source = sourceObject(slide, theme);
  if (source) objects.push(source);
  return applyEditorialDesign(slide, theme, objects);
}

function designShape(slide: SlidePlan, id: string, box: Box, fill: string, stroke = "#00000000", strokeWidth = 0, shapeName: ShapeLayoutObject["shape"] = "roundRect"): ShapeLayoutObject {
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

function applyEditorialDesign(slide: SlidePlan, theme: Theme, sourceObjects: LayoutObject[]): LayoutObject[] {
  const colors = theme.colors;
  const dark = slide.layout === "cover" || slide.layout === "section" || slide.layout === "closing";
  const styledObjects = sourceObjects.map((object) => {
    if (object.kind !== "text") return object;
    if (dark) {
      const color = object.role === "title" ? colors.white
        : object.role === "source" ? (colors.darkMuted ?? colors.muted)
        : object.role === "subtitle" ? (colors.accentCyan ?? colors.accent)
          : object.role === "metric-after" || object.role === "metric-arrow" ? (colors.accentCyan ?? colors.accent)
            : object.role === "metric-before" || object.role === "metric-label" ? (colors.darkMuted ?? colors.muted)
        : (colors.darkBody ?? colors.white);
      return { ...object, color };
    }
    return object.role === "title" ? { ...object, color: colors.title } : object;
  });
  const backgroundObjects: LayoutObject[] = [];
  if (dark) {
    backgroundObjects.push(designShape(slide, "dark-background", {
      x: theme.safeArea.left,
      y: theme.safeArea.top,
      w: Math.round((theme.canvas.width - theme.safeArea.left - theme.safeArea.right) * 1000) / 1000,
      h: Math.round((theme.canvas.height - theme.safeArea.top - theme.safeArea.bottom) * 1000) / 1000,
    }, colors.darkBackground ?? colors.title, "#00000000", 0, "rect"));
    const title = styledObjects.find((object): object is TextLayoutObject => object.kind === "text" && object.role === "title");
    if (title) {
      const spaciousInset = theme.spacing?.spaciousMinInches ?? 0.315;
      backgroundObjects.push(designShape(slide, "dark-title-accent", {
        x: Math.max(theme.safeArea.left, title.x - spaciousInset - 0.075),
        y: title.y + 0.16,
        w: 0.075,
        h: Math.min(0.96, Math.max(0.58, title.h - 0.28)),
      }, colors.accentCyan ?? colors.accent, "#00000000", 0, "rect"));
    }
  } else {
    backgroundObjects.push(designShape(slide, "title-rule", {
      x: theme.safeArea.left + 0.1, y: 1.445, w: 1.12, h: 0.045,
    }, colors.accentCyan ?? colors.accent, "#00000000", 0, "rect"));
  }
  if (slide.layout === "bullets") {
    const area = { x: 0.92, y: 1.55, w: 11.85, h: 4.95 };
    const gap = 0.1;
    const compactInset = theme.spacing?.compact?.inches ?? 0.1;
    const itemH = (area.h - gap * (slide.blocks.length - 1)) / slide.blocks.length;
    slide.blocks.forEach((block, index) => {
      const y = area.y + index * (itemH + gap);
      backgroundObjects.push(designShape(slide, `bullet-card:${block.id}`, {
        x: 0.57, y: y - compactInset, w: 12.24, h: Math.max(0.3, itemH + compactInset * 2),
      }, colors.surface, colors.border, 0.55));
    });
  } else if (slide.layout === "image-text") {
    backgroundObjects.push(designShape(slide, "image-text-copy-panel", { x: 0.52, y: 1.49, w: 5.52, h: 5.12 }, colors.surface, colors.border, 0.55));
    backgroundObjects.push(designShape(slide, "image-text-image-panel", { x: 6.24, y: 1.49, w: 6.56, h: 5.12 }, colors.surface, colors.border, 0.55));
  } else if (slide.layout === "chart" || slide.layout === "table") {
    backgroundObjects.push(designShape(slide, `${slide.layout}-panel`, { x: 0.50, y: 1.49, w: 12.32, h: 5.15 }, colors.surface, colors.border, 0.55));
  }
  const result: LayoutObject[] = [];
  for (const object of styledObjects) {
    if (object.kind === "shape" && object.id.endsWith(":takeaway-card")) {
      result.push({ ...object, fill: colors.cyanSoft ?? colors.accentSoft, stroke: colors.border, strokeWidth: 0.65 });
      result.push(designShape(slide, "takeaway-accent", { x: object.x, y: object.y, w: 0.10, h: object.h }, colors.accentCyan ?? colors.accent, "#00000000", 0, "rect"));
      continue;
    }
    if (object.kind === "shape" && object.id.endsWith(":card")) {
      result.push({ ...object, fill: colors.surface, stroke: colors.border, strokeWidth: 0.7 });
      result.push(designShape(slide, `comparison-accent:${object.id}`, { x: object.x + 0.3, y: object.y + 0.23, w: 0.72, h: 0.06 }, colors.accentCyan ?? colors.accent, "#00000000", 0, "rect"));
      continue;
    }
    if (object.kind === "shape" && object.id.includes(":node:")) {
      const fills = [colors.accentSoft, colors.cyanSoft ?? colors.accentSoft, colors.violetSoft ?? colors.accentSoft, colors.warmSoft ?? colors.accentSoft];
      result.push({ ...object, fill: fills[result.length % fills.length]!, stroke: colors.accent, strokeWidth: 0.85 });
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
