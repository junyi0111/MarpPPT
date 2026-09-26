import type { Box, Canvas } from "./geometry.js";
import type { LayoutObject, TextLayoutObject } from "./build-slide.js";

export interface TextTypography {
  fontSize: number;
  minFontSize: number;
  lineHeight: number;
}

export interface TextMeasure {
  lineCount: number;
  requiredHeight: number;
  availableLines: number;
  fits: boolean;
  fontSize: number;
}

export type LayoutIssueCode = "LAYOUT_OVERFLOW" | "SPLIT_REQUIRED" | "SUMMARY_REQUIRED";

export interface LayoutIssue {
  code: LayoutIssueCode;
  slideId: string;
  objectId: string;
  message: string;
  actionable: true;
  overlapsWith?: string[];
  relatedObjectId?: string;
  lineCount?: number;
  availableLines?: number;
}

function characterWidth(character: string): number {
  if (/\s/u.test(character)) return 0.28;
  if (/[\u2E80-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}\u{1F000}-\u{1FAFF}]/u.test(character)) return 1;
  if (/^[ilI.,:;'|!`]/u.test(character)) return 0.32;
  if (/^[MW@#%&]/u.test(character)) return 0.82;
  return 0.54;
}

export function measureTextBlock(text: string, box: Box, typography: TextTypography): TextMeasure {
  const fontSize = Math.max(typography.fontSize, typography.minFontSize);
  const lineCapacity = Math.max(1, (box.w * 72) / fontSize);
  let lineCount = 0;
  for (const paragraph of text.split("\n")) {
    lineCount += 1;
    let used = 0;
    for (const character of Array.from(paragraph)) {
      const width = characterWidth(character);
      if (used > 0 && used + width > lineCapacity) {
        lineCount += 1;
        used = width;
      } else {
        used += width;
      }
    }
  }
  const lineHeightPoints = fontSize * typography.lineHeight;
  const availableLines = Math.max(0, Math.floor((box.h * 72) / lineHeightPoints));
  return {
    lineCount,
    requiredHeight: (lineCount * lineHeightPoints) / 72,
    availableLines,
    fits: lineCount <= availableLines,
    fontSize,
  };
}

function inBounds(object: Pick<LayoutObject, "x" | "y" | "w" | "h">, canvas: Canvas): boolean {
  const line = "kind" in object && object.kind === "line";
  const dimensionsAreValid = line
    ? object.w >= 0 && object.h >= 0
    : object.w > 0 && object.h > 0;
  return Number.isFinite(object.x)
    && Number.isFinite(object.y)
    && Number.isFinite(object.w)
    && Number.isFinite(object.h)
    && object.x >= canvas.safe.left - 1e-6
    && object.y >= canvas.safe.top - 1e-6
    && dimensionsAreValid
    && object.x + object.w <= canvas.width - canvas.safe.right + 1e-6
    && object.y + object.h <= canvas.height - canvas.safe.bottom + 1e-6;
}

function overflowCode(measure: TextMeasure, text: string, role: TextLayoutObject["role"], maxLines?: number): LayoutIssueCode {
  const capacity = Math.min(measure.availableLines, maxLines ?? Number.POSITIVE_INFINITY);
  if (role === "title" || role === "subtitle" || role === "source") return "SUMMARY_REQUIRED";
  if (measure.lineCount > Math.max(1, capacity) * 2 || text.length > 1800) return "SUMMARY_REQUIRED";
  return "SPLIT_REQUIRED";
}

function textIssue(object: TextLayoutObject, box: Box): LayoutIssue | undefined {
  const measure = measureTextBlock(object.text, box, {
    fontSize: object.fontSize,
    minFontSize: object.minFontSize,
    lineHeight: object.lineHeight,
  });
  const capacity = Math.min(measure.availableLines, object.maxLines ?? Number.POSITIVE_INFINITY);
  if (measure.lineCount <= capacity) return undefined;
  const code = overflowCode(measure, object.text, object.role, object.maxLines);
  const message = code === "SPLIT_REQUIRED"
    ? `文字需要拆分成多頁；估計 ${measure.lineCount} 行，版面可容納 ${capacity} 行。`
    : `文字需要縮短或摘要；估計 ${measure.lineCount} 行，版面可容納 ${capacity} 行。`;
  return {
    code,
    slideId: object.slideId,
    objectId: object.id,
    message,
    actionable: true,
    lineCount: measure.lineCount,
    availableLines: capacity,
  };
}

function tableIssues(object: Extract<LayoutObject, { kind: "table" }>): LayoutIssue[] {
  const columnWidth = object.w / Math.max(object.columns.length, 1);
  const rowHeight = object.h / Math.max(object.rows.length + 1, 1);
  const issues: LayoutIssue[] = [];
  const cells = [object.columns, ...object.rows];
  cells.forEach((row, rowIndex) => row.forEach((text, columnIndex) => {
    const result = measureTextBlock(text, { x: 0, y: 0, w: columnWidth - 0.12, h: rowHeight - 0.06 }, {
      fontSize: object.fontSize,
      minFontSize: object.minFontSize,
      lineHeight: 1.15,
    });
    if (!result.fits) {
      issues.push({
        code: result.lineCount > Math.max(1, result.availableLines) * 2 ? "SUMMARY_REQUIRED" : "SPLIT_REQUIRED",
        slideId: object.slideId,
        objectId: `${object.id}:row:${rowIndex}:column:${columnIndex}`,
        message: `表格第 ${rowIndex + 1} 列、第 ${columnIndex + 1} 欄需要縮短內容或拆分表格。`,
        actionable: true,
        lineCount: result.lineCount,
        availableLines: result.availableLines,
      });
    }
  }));
  return issues;
}

function diagramLabelOverlapIssues(objects: LayoutObject[]): LayoutIssue[] {
  const labels = objects.filter((object): object is TextLayoutObject => object.kind === "text" && object.role === "diagram-edge-label");
  const nodes = objects.filter((object) => object.kind === "shape" && object.id.includes(`${object.slideId}:node:`));
  const overlaps = new Map(labels.map((label) => [label.id, new Set<string>()]));
  const intersects = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index]!;
    for (const other of labels.slice(index + 1)) {
      if (!intersects(label, other)) continue;
      overlaps.get(label.id)!.add(other.id);
      overlaps.get(other.id)!.add(label.id);
    }
    for (const node of nodes) {
      if (intersects(label, node)) overlaps.get(label.id)!.add(node.id);
    }
  }

  return labels.flatMap((label) => {
    const overlapsWith = [...overlaps.get(label.id)!].sort();
    if (overlapsWith.length === 0) return [];
    return [{
      code: "SUMMARY_REQUIRED" as const,
      slideId: label.slideId,
      objectId: label.id,
      overlapsWith,
      message: `流程圖邊標籤與 ${overlapsWith.length} 個節點或其他邊標籤重疊；請刪減邊標籤、拆分流程圖後重新排版。`,
      actionable: true as const,
    }];
  });
}

function diagramLabelAssociationIssues(objects: LayoutObject[]): LayoutIssue[] {
  const labels = objects.filter((object): object is TextLayoutObject => object.kind === "text" && object.role === "diagram-edge-label");
  return labels.flatMap((label) => {
    const match = /:edge-label:(\d+)$/.exec(label.id);
    if (!match) return [];
    const connectorId = `${label.slideId}:edge:${match[1]}`;
    const connector = objects.find((object) => object.kind === "line" && object.id === connectorId);
    if (!connector || connector.kind !== "line") return [];
    const distance = Math.hypot(
      label.x + label.w / 2 - (connector.x1 + connector.x2) / 2,
      label.y + label.h / 2 - (connector.y1 + connector.y2) / 2,
    );
    if (distance <= 2.3) return [];
    return [{
      code: "SUMMARY_REQUIRED" as const,
      slideId: label.slideId,
      objectId: label.id,
      relatedObjectId: connector.id,
      message: `流程圖邊標籤與其連線相距 ${distance.toFixed(1)} 英吋，難以辨認所屬關係；請簡化或拆分流程圖後重新排版。`,
      actionable: true as const,
    }];
  });
}

function diagramDuplicateConnectorIssues(objects: LayoutObject[]): LayoutIssue[] {
  const connectors = objects.filter((object): object is Extract<LayoutObject, { kind: "line" }> =>
    object.kind === "line" && /:edge:\d+$/.test(object.id));
  const conflicts = new Map(connectors.map((connector) => [connector.id, new Set<string>()]));
  const samePoint = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) <= 1e-6 && Math.abs(ay - by) <= 1e-6;
  const sameSegment = (a: typeof connectors[number], b: typeof connectors[number]) =>
    (samePoint(a.x1, a.y1, b.x1, b.y1) && samePoint(a.x2, a.y2, b.x2, b.y2))
    || (samePoint(a.x1, a.y1, b.x2, b.y2) && samePoint(a.x2, a.y2, b.x1, b.y1));

  for (let index = 0; index < connectors.length; index += 1) {
    const connector = connectors[index]!;
    for (const other of connectors.slice(index + 1)) {
      if (connector.slideId !== other.slideId || !sameSegment(connector, other)) continue;
      conflicts.get(connector.id)!.add(other.id);
      conflicts.get(other.id)!.add(connector.id);
    }
  }

  return connectors.flatMap((connector) => {
    const overlapsWith = [...conflicts.get(connector.id)!].sort();
    if (overlapsWith.length === 0) return [];
    const match = /:edge:(\d+)$/.exec(connector.id);
    const label = match && objects.find((object): object is TextLayoutObject =>
      object.kind === "text" && object.id === `${connector.slideId}:edge-label:${match[1]}`);
    const connectorIssue: LayoutIssue = {
      code: "SUMMARY_REQUIRED",
      slideId: connector.slideId,
      objectId: connector.id,
      overlapsWith,
      message: `流程圖連線與 ${overlapsWith.length} 條其他連線重疊；請合併重複關係或簡化流程圖後再匯出。`,
      actionable: true,
    };
    const labelIssue: LayoutIssue[] = label ? [{
      code: "SUMMARY_REQUIRED",
      slideId: connector.slideId,
      objectId: label.id,
      relatedObjectId: connector.id,
      overlapsWith,
      message: `此邊標籤所屬連線與 ${overlapsWith.length} 條其他連線重疊，無法在簡報中辨識關係；請合併重複關係或簡化流程圖。`,
      actionable: true,
    }] : [];
    return [connectorIssue, ...labelIssue];
  });
}

function segmentCrossesNodeInterior(connector: Extract<LayoutObject, { kind: "line" }>, node: Box): boolean {
  const inset = 1e-6;
  let enter = 0;
  let exit = 1;
  const clip = (start: number, change: number, minimum: number, maximum: number): boolean => {
    if (Math.abs(change) < 1e-12) return start > minimum && start < maximum;
    const first = (minimum - start) / change;
    const second = (maximum - start) / change;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    return enter < exit;
  };
  return clip(connector.x1, connector.x2 - connector.x1, node.x + inset, node.x + node.w - inset)
    && clip(connector.y1, connector.y2 - connector.y1, node.y + inset, node.y + node.h - inset);
}

function diagramConnectorNodeIntersectionIssues(objects: LayoutObject[]): LayoutIssue[] {
  const connectors = objects.filter((object): object is Extract<LayoutObject, { kind: "line" }> =>
    object.kind === "line" && /:edge:\d+$/.test(object.id));
  const nodes = objects.filter((object): object is Extract<LayoutObject, { kind: "shape" }> =>
    object.kind === "shape" && object.id.includes(`${object.slideId}:node:`));
  return connectors.flatMap((connector) => {
    const overlapsWith = nodes.filter((node) => node.slideId === connector.slideId
      && node.id !== `${connector.slideId}:node:${connector.from}`
      && node.id !== `${connector.slideId}:node:${connector.to}`
      && segmentCrossesNodeInterior(connector, node)).map((node) => node.id);
    if (overlapsWith.length === 0) return [];
    return [{
      code: "SUMMARY_REQUIRED" as const,
      slideId: connector.slideId,
      objectId: connector.id,
      overlapsWith,
      message: `流程圖連線穿越 ${overlapsWith.length} 個非端點節點；請重新排列節點、刪減連線或拆分流程圖。`,
      actionable: true as const,
    }];
  });
}

function diagramSelfEdgeIssues(objects: LayoutObject[]): LayoutIssue[] {
  const connectors = objects.filter((object): object is Extract<LayoutObject, { kind: "line" }> =>
    object.kind === "line" && /:edge:\d+$/.test(object.id) && object.from === object.to);
  return connectors.flatMap((connector) => {
    const match = /:edge:(\d+)$/.exec(connector.id);
    const label = match && objects.find((object): object is TextLayoutObject =>
      object.kind === "text" && object.id === `${connector.slideId}:edge-label:${match[1]}`);
    const connectorIssue: LayoutIssue = {
      code: "SUMMARY_REQUIRED",
      slideId: connector.slideId,
      objectId: connector.id,
      message: "流程圖包含指向自身的連線，目前版型不支援循環線路；請改寫成明確的循環步驟或拆分流程圖。",
      actionable: true,
    };
    const labelIssue: LayoutIssue[] = label ? [{
      code: "SUMMARY_REQUIRED",
      slideId: connector.slideId,
      objectId: label.id,
      relatedObjectId: connector.id,
      message: "此標籤屬於尚未支援的自我連線；請改寫成明確的循環步驟或拆分流程圖。",
      actionable: true,
    }] : [];
    return [connectorIssue, ...labelIssue];
  });
}

export function findOverflow(objects: LayoutObject[], canvas: Canvas): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  for (const object of objects) {
    if (!inBounds(object, canvas)) {
      issues.push({
        code: "LAYOUT_OVERFLOW",
        slideId: object.slideId,
        objectId: object.id,
        message: "物件超出安全版面；請調整受控版型或重新排版。",
        actionable: true,
      });
      continue;
    }
    if (object.kind === "text") {
      const issue = textIssue(object, object);
      if (issue) issues.push(issue);
    } else if (object.kind === "table") {
      issues.push(...tableIssues(object));
    }
  }
  issues.push(...diagramLabelOverlapIssues(objects));
  issues.push(...diagramLabelAssociationIssues(objects));
  issues.push(...diagramDuplicateConnectorIssues(objects));
  issues.push(...diagramConnectorNodeIntersectionIssues(objects));
  issues.push(...diagramSelfEdgeIssues(objects));
  return issues;
}
