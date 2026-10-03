import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { inspectPptx, renderPptx } from "../../src/pptx/render-pptx.js";
import { loadDefaultTheme, makeMixedDeckFixture } from "../helpers/layout-fixtures.js";

const theme = loadDefaultTheme();
const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main";

async function tableDeck(position = 1) {
  const plan = makeMixedDeckFixture();
  const table = plan.slides.find((slide) => slide.layout === "table")!;
  plan.slides = [...Array.from({ length: position - 1 }, (_, i) => ({ ...plan.slides[0]!, id: `cover-${i}` })), table];
  plan.imageAssetIds = [];
  plan.assetManifest = [];
  return renderPptx(plan, [], theme);
}

async function textDeck() {
  const plan = makeMixedDeckFixture();
  plan.slides = plan.slides.slice(0, 2);
  plan.imageAssetIds = [];
  plan.assetManifest = [];
  return renderPptx(plan, [], theme);
}

function mutate(bytes: Uint8Array, part: string, edit: (xml: string) => string) {
  const archive = unzipSync(bytes);
  archive[part] = strToU8(edit(strFromU8(archive[part]!)));
  return zipSync(archive);
}

describe("PowerPoint repair prevention", () => {
  it.each([1, 2, 3, 5])("writes legal centered cells and unique drawing IDs for a table on slide %i", async (position) => {
    const bytes = await tableDeck(position);
    const xml = strFromU8(unzipSync(bytes)[`ppt/slides/slide${position}.xml`]!);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const cells = Array.from(doc.getElementsByTagNameNS(DRAWING, "tcPr"));
    expect(cells).toHaveLength(6);
    expect(cells.map((cell) => cell.getAttribute("anchor"))).toEqual(Array(6).fill("ctr"));
    const ids = Array.from(doc.getElementsByTagNameNS(PRESENTATION, "cNvPr")).map((node) => node.getAttribute("id"));
    expect(new Set(ids).size).toBe(ids.length);
    await expect(inspectPptx(bytes)).resolves.toMatchObject({ tableCount: 1 });
  });

  it.each([
    ['anchor="mid"', /anchor.*mid/u],
    ['horzOverflow="wrap"', /horzOverflow.*wrap/u],
  ])("rejects the reproduced table defect %s", async (attribute, error) => {
    const bytes = mutate(await tableDeck(), "ppt/slides/slide1.xml", (xml) => xml.replace(/<a:tcPr\b[^>]*>/u, (tag) => {
      return `${tag.replace(/\sanchor="[^"]*"/u, "").slice(0, -1)} ${attribute}>`;
    }));
    await expect(inspectPptx(bytes)).rejects.toThrow(error);
  });

  it("checks aliases and escaped values instead of depending on an XML prefix", async () => {
    const bytes = mutate(await tableDeck(), "ppt/slides/slide1.xml", (xml) => xml
      .replace(/xmlns:a=/gu, "xmlns:draw=").replace(/(<\/?)(a:)/gu, "$1draw:")
      .replace(/<draw:tcPr\b[^>]*>/u, (tag) => `${tag.slice(0, -1)} horzOverflow='wr&#97;p'>`));
    await expect(inspectPptx(bytes)).rejects.toThrow(/horzOverflow.*wrap/u);
  });

  it.each(["overflow", "clip"])("accepts legal table overflow %s", async (overflow) => {
    const bytes = mutate(await tableDeck(), "ppt/slides/slide1.xml", (xml) => xml.replace(/<a:tcPr\b/gu, `<a:tcPr horzOverflow="${overflow}"`));
    await expect(inspectPptx(bytes)).resolves.toMatchObject({ tableCount: 1 });
  });

  it("rejects duplicate drawing IDs before publishing", async () => {
    const bytes = mutate(await textDeck(), "ppt/slides/slide1.xml", (xml) => xml.replace(/(<p:cNvPr\b[^>]*\bid=")[^"]+/gu, "$11"));
    await expect(inspectPptx(bytes)).rejects.toThrow(/duplicate.*drawing.*id/iu);
  });

  it.each(["\u0000", "\u0001", "\u000b", "&#11;", "&#x0;", "&#xD800;"])("rejects illegal XML characters/references %j", async (value) => {
    const bytes = mutate(await textDeck(), "ppt/slides/slide1.xml", (xml) => xml.replace(/(<a:t>)[^<]*/u, `$1A${value}B`));
    await expect(inspectPptx(bytes)).rejects.toThrow(/XML.*character|character.*XML/iu);
  });

  it("rejects an unpaired surrogate before the XML writer can silently replace it", async () => {
    const plan = makeMixedDeckFixture();
    plan.slides = [plan.slides[0]!]; plan.imageAssetIds = []; plan.assetManifest = [];
    plan.slides[0]!.title = "Invalid \ud800";
    await expect(renderPptx(plan, [], theme)).rejects.toThrow(/XML.*character/iu);
  });

  it("preserves legal CJK, emoji and XML whitespace", async () => {
    const bytes = mutate(await textDeck(), "ppt/slides/slide1.xml", (xml) => xml.replace(/(<a:t>)[^<]*/u, "$1中文 English 😀\t\n&#13;"));
    await expect(inspectPptx(bytes)).resolves.toMatchObject({ slideCount: 2 });
  });

  it("rejects DTD declarations even when no external entity is referenced", async () => {
    const bytes = mutate(await textDeck(), "ppt/slides/slide1.xml", (xml) => xml.replace(/(<p:sld\b)/u, '<!DOCTYPE p:sld SYSTEM "https://example.invalid/entity">$1'));
    await expect(inspectPptx(bytes)).rejects.toThrow(/DTD|DOCTYPE/u);
  });

  it.each(["bar", "line", "pie"] as const)("writes a valid editable %s chart workbook and rejects a corrupted range", async (kind) => {
    const plan = makeMixedDeckFixture();
    const slide = plan.slides.find((item) => item.layout === "chart")!;
    if (slide.layout !== "chart") throw new Error("chart fixture required");
    slide.chart.kind = kind;
    plan.slides = [slide]; plan.imageAssetIds = []; plan.assetManifest = [];
    const bytes = await renderPptx(plan, [], theme);
    const archive = unzipSync(bytes);
    const embedded = Object.keys(archive).find((name) => name.endsWith(".xlsx"))!;
    const workbook = unzipSync(archive[embedded]!);
    const table = strFromU8(workbook["xl/tables/table1.xml"]!);
    expect(table).toContain('ref="A1:B3"');
    workbook["xl/tables/table1.xml"] = strToU8(table.replace('ref="A1:B3"', 'ref="A1:B3\'"'));
    archive[embedded] = zipSync(workbook);
    await expect(inspectPptx(zipSync(archive))).rejects.toThrow(/range|ST_Ref/iu);
  });
});
