import { PresentationPlanSchema, type PresentationPlan, type SlidePlan, type TextBlock } from "../contracts/presentation-plan.js";
import { normalizeMathText, splitMathSegments } from "../content/math-text.js";
import { parseMetricComparison } from "../content/metric-comparison.js";
import type { Theme } from "../layout/geometry.js";

const HTML_OR_COMMENT_PATTERN = /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?\/?>|<!--|-->|<![A-Z][^>]*>/i;
const EXTERNAL_URL_PATTERN = /(?:https?:\/\/|ftp:\/\/|\/\/|\bwww\.)[^\s<>()]+/i;
const MARKDOWN_SPECIAL = /([\\`*_{}\[\]()#+.!|<>~-])/g;

function assertSafeText(value: string, location: string, allowUrlText = false): void {
  if (HTML_OR_COMMENT_PATTERN.test(value)) {
    throw new Error(`UNSUPPORTED_MARKUP: raw HTML or Marp directives are not supported in ${location}.`);
  }
  if (!allowUrlText && EXTERNAL_URL_PATTERN.test(value)) {
    throw new Error(`EXTERNAL_URL: external URLs are not accepted in ${location}; attach the image or remove the URL.`);
  }
}

function escapeMarkdown(value: string): string {
  normalizeMathText(value); // Reject unsupported or incomplete TeX before writing Marp.
  return splitMathSegments(value).map((segment) => segment.kind === "math"
    ? `${segment.display ? "$$" : "$"}${segment.value}${segment.display ? "$$" : "$"}`
    : normalizeMathText(segment.value).replace(MARKDOWN_SPECIAL, "\\$1").replace(/\r?\n/g, "  \n")).join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

const STYLED_MARKDOWN_PUNCTUATION = new Set(Array.from("\\`*_{}[]()#+.!|~-$"));

function escapeStyledText(value: string): string {
  return Array.from(value.replace(/\r\n?/gu, "\n")).map((character) => {
    if (character === "\n") return "<br>";
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    if (character === "'") return "&#39;";
    if (STYLED_MARKDOWN_PUNCTUATION.has(character)) return `&#${character.codePointAt(0)};`;
    return character;
  }).join("");
}

function renderBlockText(block: TextBlock, slide: SlidePlan, theme: Theme, inList = false): string {
  const mathSegments = splitMathSegments(block.text.trim());
  if (!block.runs && mathSegments.length === 1 && mathSegments[0]?.kind === "math") {
    const expression = mathSegments[0];
    return expression.display && !inList ? `$$\n${expression.value}\n$$` : `$${expression.value}$`;
  }
  if (block.runs) {
    const dark = slide.layout === "cover" || slide.layout === "section" || slide.layout === "closing";
    return block.runs.map((run) => {
      if (!run.bold && !run.color) return escapeMarkdown(run.text);
      const classes = [
        ...(run.bold ? ["marpppt-strong"] : []),
        ...(run.color === "accent" ? [dark ? "marpppt-accent-dark" : "marpppt-accent"] : []),
      ];
      return `<span class="${classes.join(" ")}">${escapeStyledText(normalizeMathText(run.text))}</span>`;
    }).join("");
  }
  const metric = splitMathSegments(block.text).some((segment) => segment.kind === "math")
    ? undefined
    : parseMetricComparison(block.text);
  if (!metric) return escapeMarkdown(block.text);
  const context = escapeHtml(metric.context);
  const before = escapeHtml(metric.before);
  const after = escapeHtml(metric.after);
  return `<span class="marpppt-metric-context">${context}</span> <span>${before}</span> <span class="marpppt-metric-arrow">→</span> <span class="marpppt-metric-after">${after}</span>`;
}

function escapeSourceReference(value: string): string {
  return escapeMarkdown(value).replace(/:/g, "\\:");
}

function escapeCell(value: string): string {
  return escapeMarkdown(value).replace(/\r?\n/g, " ");
}

function allPlanText(plan: PresentationPlan): Array<{ value: string; location: string; allowUrlText?: boolean }> {
  const values: Array<{ value: string; location: string; allowUrlText?: boolean }> = [{ value: plan.title, location: "presentation title" }];
  plan.assetManifest.forEach((asset) => values.push({ value: asset.fileName, location: `asset filename ${asset.assetId}` }));
  plan.slides.forEach((slide, slideIndex) => {
    const prefix = `slide ${slideIndex + 1}`;
    values.push({ value: slide.title, location: `${prefix} title` });
    if (slide.subtitle) values.push({ value: slide.subtitle, location: `${prefix} subtitle` });
    slide.sourceRefs?.forEach((sourceRef) => values.push({
      value: sourceRef,
      location: `${prefix} source reference`,
      allowUrlText: true,
    }));
    if ("blocks" in slide) slide.blocks?.forEach((block) => values.push({ value: block.text, location: `${prefix} text block ${block.id}` }));
    if (slide.layout === "comparison") slide.columns.forEach((column) => {
      values.push({ value: column.title, location: `${prefix} comparison column` });
      column.blocks.forEach((block) => values.push({ value: block.text, location: `${prefix} comparison text` }));
    });
    if (slide.layout === "table") {
      slide.table.columns.forEach((cell) => values.push({ value: cell, location: `${prefix} table heading` }));
      slide.table.rows.forEach((row) => row.forEach((cell) => values.push({ value: cell, location: `${prefix} table cell` })));
    }
    if (slide.layout === "chart") {
      slide.chart.labels.forEach((label) => values.push({ value: label, location: `${prefix} chart label` }));
      slide.chart.series.forEach((series) => {
        values.push({ value: series.name, location: `${prefix} chart series name` });
      });
    }
    if (slide.layout === "diagram") {
      slide.diagram.nodes.forEach((node) => values.push({ value: node.label, location: `${prefix} diagram node` }));
      slide.diagram.edges.forEach((edge) => {
        if (edge.label) values.push({ value: edge.label, location: `${prefix} diagram edge` });
      });
    }
  });
  return values;
}

function assetPath(assetId: string, mimeType: "image/png" | "image/jpeg"): string {
  const extension = mimeType === "image/png" ? "png" : "jpg";
  return `assets/${encodeURIComponent(assetId)}.${extension}`;
}

function slideImages(slide: SlidePlan, plan: PresentationPlan): string[] {
  return slide.imageIds.map((assetId) => {
    const asset = plan.assetManifest.find((item) => item.assetId === assetId);
    if (!asset) throw new Error(`MISSING_IMAGE_ID: no manifest entry for ${assetId}.`);
    return `![${escapeMarkdown(asset.fileName)}](${assetPath(assetId, asset.mimeType)})`;
  });
}

function renderTable(slide: Extract<SlidePlan, { layout: "table" }>): string[] {
  const header = `| ${slide.table.columns.map(escapeCell).join(" | ")} |`;
  const separator = `| ${slide.table.columns.map(() => "---").join(" | ")} |`;
  return [header, separator, ...slide.table.rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`)];
}

function renderChart(slide: Extract<SlidePlan, { layout: "chart" }>): string[] {
  const chart = slide.chart;
  const header = `| 系列 | ${chart.labels.map(escapeCell).join(" | ")} |`;
  const separator = `| --- | ${chart.labels.map(() => "---").join(" | ")} |`;
  const rows = chart.series.map((series) => `| ${escapeCell(series.name)} | ${series.values.map((value) => String(value)).join(" | ")} |`);
  return [`圖表類型：${chart.kind}`, header, separator, ...rows];
}

function renderDiagram(slide: Extract<SlidePlan, { layout: "diagram" }>): string[] {
  const labels = new Map(slide.diagram.nodes.map((node) => [node.id, node.label]));
  const nodes = slide.diagram.nodes.map((node) => `- node ${escapeMarkdown(node.id)}: ${escapeMarkdown(node.label)}`);
  const edges = slide.diagram.edges.map((edge, index) => {
    const title = edge.label ? `（${escapeMarkdown(edge.label)}）` : "";
    const fromLabel = labels.get(edge.from);
    const toLabel = labels.get(edge.to);
    const from = `from ${escapeMarkdown(edge.from)}${fromLabel ? ` (${escapeMarkdown(fromLabel)})` : ""}`;
    const to = `to ${escapeMarkdown(edge.to)}${toLabel ? ` (${escapeMarkdown(toLabel)})` : ""}`;
    const edgeId = `${slide.id}:edge:${index + 1}`;
    return `- edge ${escapeMarkdown(edgeId)}: ${from} → ${to}${title}`;
  });
  return ["節點：", ...nodes, "", "關係：", ...edges];
}

function renderSlide(slide: SlidePlan, plan: PresentationPlan, theme: Theme): string {
  const lines = [`# ${escapeMarkdown(slide.title)}`];
  if (slide.subtitle) lines.push("", escapeMarkdown(slide.subtitle));

  switch (slide.layout) {
    case "bullets":
      lines.push("", ...slide.blocks.map((block) => `- ${renderBlockText(block, slide, theme, true)}`));
      break;
    case "comparison":
      lines.push("", `### ${escapeMarkdown(slide.columns[0].title)}`);
      lines.push(...slide.columns[0].blocks.map((block) => `- ${renderBlockText(block, slide, theme, true)}`));
      lines.push("", `### ${escapeMarkdown(slide.columns[1].title)}`);
      lines.push(...slide.columns[1].blocks.map((block) => `- ${renderBlockText(block, slide, theme, true)}`));
      break;
    case "table":
      lines.push("", ...renderTable(slide));
      if (slide.blocks?.length) lines.push("", ...slide.blocks.map((block) => renderBlockText(block, slide, theme)));
      break;
    case "chart":
      lines.push("", ...renderChart(slide));
      if (slide.blocks?.length) lines.push("", ...slide.blocks.map((block) => renderBlockText(block, slide, theme)));
      break;
    case "diagram":
      lines.push("", ...renderDiagram(slide));
      if (slide.blocks?.length) lines.push("", ...slide.blocks.map((block) => renderBlockText(block, slide, theme)));
      break;
    default:
      if ("blocks" in slide && slide.blocks?.length) lines.push("", ...slide.blocks.map((block) => renderBlockText(block, slide, theme)));
  }

  const images = slideImages(slide, plan);
  if (images.length) lines.push("", ...images);
  if (slide.sourceRefs?.length) lines.push("", `> 來源：${slide.sourceRefs.map(escapeSourceReference).join("；")}`);
  return lines.join("\n");
}

export function serializeMarp(plan: PresentationPlan, theme: Theme): string {
  const parsed = PresentationPlanSchema.parse(plan);
  if (parsed.themeId !== theme.id) {
    throw new Error(`THEME_MISMATCH: plan requests ${parsed.themeId}, but ${theme.id} was provided.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(theme.id)) throw new Error("INVALID_THEME_ID: theme IDs must be safe Marp tokens.");
  for (const [name, color] of Object.entries({ accent: theme.colors.accent, accentCyan: theme.colors.accentCyan ?? theme.colors.accent, muted: theme.colors.muted })) {
    if (!/^#[0-9A-Fa-f]{6}$/u.test(color)) throw new Error(`INVALID_THEME_COLOR: ${name} must be a six-digit hex color.`);
  }
  for (const text of allPlanText(parsed)) assertSafeText(text.value, text.location, text.allowUrlText);

  const frontMatter = [
    "---",
    "marp: true",
    "size: 16:9",
    "theme: default",
    "math: mathjax",
    `title: ${JSON.stringify(parsed.title)}`,
    "style: |",
    "  section {",
    `    font-family: ${JSON.stringify(theme.typography.fontFace)};`,
    "  }",
    "  section .marpppt-strong { font-weight: 700; }",
    `  section .marpppt-accent { color: ${theme.colors.accent}; }`,
    `  section .marpppt-accent-dark { color: ${theme.colors.accentCyan ?? theme.colors.accent}; }`,
    `  section .marpppt-metric-context { font-size: .8em; font-weight: 700; color: ${theme.colors.muted}; }`,
    `  section .marpppt-metric-arrow { font-weight: 700; color: ${theme.colors.accent}; }`,
    `  section .marpppt-metric-after { font-size: 1.5em; font-weight: 700; color: ${theme.colors.accent}; }`,
    "---",
  ].join("\n");
  return `${frontMatter}\n${parsed.slides.map((slide, index) => `${index === 0 ? "" : "---\n"}${renderSlide(slide, parsed, theme)}`).join("\n")}`;
}
