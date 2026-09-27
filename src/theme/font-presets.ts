import type { Theme } from "../layout/geometry.js";

export interface FontPreset {
  id: string;
  label: string;
  family: string;
  use: string;
  license: "OFL-1.1";
  sourceUrl: string;
  licenseUrl: string;
  downloads: readonly FontDownload[];
}

export interface FontDownload {
  url: string;
  kind: "font" | "zip";
  fileName?: string;
  entryPattern?: string;
}

const PRESETS = [
  {
    id: "default",
    label: "Noto Sans TC",
    family: "Noto Sans CJK TC",
    use: "通用預設、教材與資料型簡報",
    license: "OFL-1.1",
    sourceUrl: "https://fonts.google.com/specimen/Noto+Sans+TC",
    licenseUrl: "https://github.com/google/fonts/blob/main/ofl/notosanstc/OFL.txt",
    downloads: [{
      url: "https://raw.githubusercontent.com/google/fonts/523d033d6cb47f4a80c58a35753646f5c3608a78/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf",
      kind: "font",
      fileName: "NotoSansTC-variable.ttf",
    }],
  },
  {
    id: "default-serif",
    label: "Noto Serif TC",
    family: "Noto Serif CJK TC",
    use: "研究摘要、文章式敘事與較正式的封面",
    license: "OFL-1.1",
    sourceUrl: "https://fonts.google.com/specimen/Noto+Serif+TC",
    licenseUrl: "https://github.com/google/fonts/blob/main/ofl/notoseriftc/OFL.txt",
    downloads: [{
      url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf",
      kind: "font",
      fileName: "NotoSerifTC-variable.ttf",
    }],
  },
  {
    id: "default-source-serif",
    label: "Source Han Serif TC",
    family: "Source Han Serif TC",
    use: "編輯感、長文摘錄與人文內容",
    license: "OFL-1.1",
    sourceUrl: "https://github.com/adobe-fonts/source-han-serif",
    licenseUrl: "https://github.com/adobe-fonts/source-han-serif/blob/master/LICENSE.txt",
    downloads: [{
      url: "https://github.com/adobe-fonts/source-han-serif/releases/latest/download/10_SourceHanSerifTC.zip",
      kind: "zip",
      entryPattern: "SourceHanSerifTC-.*\\.(?:otf|ttf)$",
    }],
  },
  {
    id: "default-plex",
    label: "IBM Plex Sans TC",
    family: "IBM Plex Sans TC",
    use: "技術報告、產品指標與工程資料",
    license: "OFL-1.1",
    sourceUrl: "https://github.com/IBM/plex/tree/master/packages/plex-sans-tc",
    licenseUrl: "https://github.com/IBM/plex/blob/master/LICENSE.txt",
    downloads: [
      {
        url: "https://raw.githubusercontent.com/IBM/plex/master/packages/plex-sans-tc/fonts/complete/otf/hinted/IBMPlexSansTC-Regular.otf",
        kind: "font",
        fileName: "IBMPlexSansTC-Regular.otf",
      },
      {
        url: "https://raw.githubusercontent.com/IBM/plex/master/packages/plex-sans-tc/fonts/complete/otf/hinted/IBMPlexSansTC-Bold.otf",
        kind: "font",
        fileName: "IBMPlexSansTC-Bold.otf",
      },
    ],
  },
] as const satisfies readonly FontPreset[];

const PRESETS_BY_ID: ReadonlyMap<string, FontPreset> = new Map(PRESETS.map((preset) => [preset.id, preset]));

export function listFontPresets(): FontPreset[] {
  return PRESETS.map((preset) => ({ ...preset }));
}

export function getFontPreset(id: string): FontPreset {
  const preset = PRESETS_BY_ID.get(id);
  if (!preset) throw new Error(`UNSUPPORTED_FONT_PRESET: ${id}`);
  return { ...preset };
}

export function createFontThemeCatalog(baseTheme: Theme): Map<string, Theme> {
  return new Map(PRESETS.map((preset) => [preset.id, {
    ...baseTheme,
    id: preset.id,
    name: `${baseTheme.name} · ${preset.label}`,
    typography: { ...baseTheme.typography, fontFace: preset.family },
  }]));
}
