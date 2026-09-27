import { describe, expect, it } from "vitest";
import { createFontThemeCatalog, getFontPreset, listFontPresets } from "../../src/theme/font-presets.js";
import { loadDefaultTheme } from "../helpers/layout-fixtures.js";

describe("font preset catalog", () => {
  it("offers a safe sans default and three Traditional Chinese alternatives", () => {
    expect(listFontPresets().map((preset) => preset.id)).toEqual([
      "default",
      "default-serif",
      "default-source-serif",
      "default-plex",
    ]);
    expect(getFontPreset("default").family).toBe("Noto Sans CJK TC");
    expect(getFontPreset("default-serif").family).toBe("Noto Serif CJK TC");
  });

  it("creates theme clones without mutating the default theme", () => {
    const base = loadDefaultTheme();
    const catalog = createFontThemeCatalog(base);
    expect(catalog.get("default-serif")).toMatchObject({ id: "default-serif", typography: { fontFace: "Noto Serif CJK TC" } });
    expect(catalog.get("default-plex")).toMatchObject({ id: "default-plex", typography: { fontFace: "IBM Plex Sans TC" } });
    expect(base.id).toBe("default");
    expect(base.typography.fontFace).toBe("Noto Sans CJK TC");
  });

  it("rejects unknown theme IDs instead of inventing a font family", () => {
    expect(() => getFontPreset("default-unknown")).toThrow(/UNSUPPORTED_FONT_PRESET/u);
  });
});
