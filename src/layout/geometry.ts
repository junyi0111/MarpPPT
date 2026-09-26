export interface SafeArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Theme {
  id: string;
  name: string;
  canvas: { width: number; height: number };
  safeArea: SafeArea;
  grid: { columns: number; gutter: number };
  typography: {
    fontFace: string;
    title: number;
    coverTitle: number;
    sectionTitle: number;
    body: number;
    takeaway: number;
    note: number;
    minBody: number;
    minNote: number;
    lineHeight: number;
  };
  colors: {
    background: string;
    title: string;
    body: string;
    muted: string;
    accent: string;
    accentSoft: string;
    surface: string;
    border: string;
    white: string;
  };
  imageFit: "contain" | "cover";
  footer: { showSlideNumber: boolean; sourcePrefix: string };
}

export interface Canvas {
  width: number;
  height: number;
  safe: SafeArea;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TextBoxKind = "title" | "content" | "image" | "footer";

export function getCanvas(theme: Theme): Canvas {
  return { width: theme.canvas.width, height: theme.canvas.height, safe: { ...theme.safeArea } };
}

export function getTextBox(kind: TextBoxKind, layout: string, theme: Theme): Box {
  const { left, right, top, bottom } = theme.safeArea;
  const width = theme.canvas.width - left - right;
  const height = theme.canvas.height - top - bottom;
  const base = { x: left, y: top, w: width, h: height };

  if (kind === "footer") return { x: left + 0.1, y: theme.canvas.height - bottom - 0.3, w: width - 0.2, h: 0.25 };
  if (kind === "image") return { x: left + 0.1, y: top + 1.18, w: width - 0.2, h: height - 1.52 };
  if (kind === "content") return { x: left + 0.1, y: top + 1.18, w: width - 0.2, h: height - 1.55 };

  if (layout === "cover") return { x: left + 0.45, y: 1.7, w: width - 0.9, h: 1.5 };
  if (layout === "section") return { x: left + 0.2, y: 2.2, w: width - 0.4, h: 1.25 };
  if (layout === "closing") return { x: left + 0.2, y: 2.25, w: width - 0.4, h: 1.25 };
  return { x: left + 0.1, y: top + 0.12, w: width - 0.2, h: 0.92 };
}
