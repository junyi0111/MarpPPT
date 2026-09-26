import { PresentationPlanSchema, type PresentationPlan, type SlidePlan } from "../contracts/presentation-plan.js";
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
  return value.replace(MARKDOWN_SPECIAL, "\\$1").replace(/\r?\n/g, "  \n");
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

function renderSlide(slide: SlidePlan, plan: PresentationPlan): string {
  const lines = [`# ${escapeMarkdown(slide.title)}`];
  if (slide.subtitle) lines.push("", escapeMarkdown(slide.subtitle));

  switch (slide.layout) {
    case "bullets":
      lines.push("", ...slide.blocks.map((block) => `- ${escapeMarkdown(block.text)}`));
      break;
    case "comparison":
      lines.push("", `### ${escapeMarkdown(slide.columns[0].title)}`);
      lines.push(...slide.columns[0].blocks.map((block) => `- ${escapeMarkdown(block.text)}`));
      lines.push("", `### ${escapeMarkdown(slide.columns[1].title)}`);
      lines.push(...slide.columns[1].blocks.map((block) => `- ${escapeMarkdown(block.text)}`));
      break;
    case "table":
      lines.push("", ...renderTable(slide));
      if (slide.blocks?.length) lines.push("", ...slide.blocks.map((block) => escapeMarkdown(block.text)));
      break;
    case "chart":
      lines.push("", ...renderChart(slide));
      if (slide.blocks?.length) lines.push("", ...slide.blocks.map((block) => escapeMarkdown(block.text)));
      break;
    case "diagram":
      lines.push("", ...renderDiagram(slide));
      if (slide.blocks?.length) lines.push("", ...slide.blocks.map((block) => escapeMarkdown(block.text)));
      break;
    default:
      if ("blocks" in slide && slide.blocks?.length) lines.push("", ...slide.blocks.map((block) => escapeMarkdown(block.text)));
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
  for (const text of allPlanText(parsed)) assertSafeText(text.value, text.location, text.allowUrlText);

  const frontMatter = [
    "---",
    "marp: true",
    "size: 16:9",
    `theme: ${theme.id}`,
    `title: ${JSON.stringify(parsed.title)}`,
    "---",
  ].join("\n");
  return `${frontMatter}\n${parsed.slides.map((slide, index) => `${index === 0 ? "" : "---\n"}${renderSlide(slide, parsed)}`).join("\n")}`;
}
