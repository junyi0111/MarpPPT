import { describe, expect, it } from "vitest";
import pptxgen from "pptxgenjs";
import { strFromU8, unzipSync } from "fflate";
import { PresentationPlanSchema } from "../../src/contracts/presentation-plan.js";
import { buildSlideLayout } from "../../src/layout/build-slide.js";
import { serializeMarp } from "../../src/marp/serialize-marp.js";
import { addLayoutObject } from "../../src/pptx/add-layout-object.js";
import { inspectPptx } from "../../src/pptx/render-pptx.js";
import { loadDefaultTheme, makePresentationPlanFixture } from "../helpers/layout-fixtures.js";

const theme = loadDefaultTheme();

function planWithRuns(runs: Array<{ text: string; bold?: boolean; color?: string }>) {
  const fixture = makePresentationPlanFixture();
  return {
    ...fixture,
    slides: [{
      id: "result",
      title: "結果",
      layout: "takeaway",
      blocks: [{ id: "point", text: runs.map((run) => run.text).join(""), runs }],
      imageIds: [],
      sourceRefs: ["## 結果"],
    }],
    imageAssetIds: [],
    assetManifest: [],
  };
}

describe("editable inline emphasis", () => {
  it("accepts matching text runs and keeps their styles on the layout object", () => {
    const plan = PresentationPlanSchema.parse(planWithRuns([
      { text: "準確率由 " },
      { text: "32%", bold: true },
      { text: " 提升至 " },
      { text: "62%", bold: true, color: "accent" },
    ]));
    const object = buildSlideLayout(plan.slides[0]!, theme).find((item) => item.kind === "text" && item.id === "result:text:point");
    expect(object).toMatchObject({
      kind: "text",
      text: "準確率由 32% 提升至 62%",
      runs: [
        { text: "準確率由 " },
        { text: "32%", bold: true },
        { text: " 提升至 " },
        { text: "62%", bold: true, color: "#2F6FED" },
      ],
    });
  });

  it("rejects runs that change the underlying text or inject an arbitrary color", () => {
    const mismatched = planWithRuns([{ text: "數值", color: "accent" }]);
    mismatched.slides[0]!.blocks[0]!.text = "其他數值";
    expect(PresentationPlanSchema.safeParse(mismatched).success).toBe(false);
    expect(PresentationPlanSchema.safeParse(planWithRuns([{ text: "數值", color: "#ff0000" }])).success).toBe(false);
  });

  it("requires each LaTeX expression to stay inside one unstyled run", () => {
    expect(PresentationPlanSchema.safeParse(planWithRuns([
      { text: "值 " }, { text: "$x" }, { text: "+y$" },
    ])).success).toBe(false);
    expect(PresentationPlanSchema.safeParse(planWithRuns([
      { text: "值 " }, { text: "$x+y$" },
    ])).success).toBe(true);
    expect(PresentationPlanSchema.safeParse(planWithRuns([
      { text: "$x+y$", bold: true },
    ])).success).toBe(false);
  });

  it("serializes styled runs with a theme color and escapes their literal text", () => {
    const plan = PresentationPlanSchema.parse(planWithRuns([
      { text: "判斷 " },
      { text: "62% <目標>", bold: true, color: "accent" },
      { text: " [已達成]" },
    ]));
    const marp = serializeMarp(plan, theme);
    expect(marp).toContain('<span class="marpppt-strong marpppt-accent">62% &lt;目標&gt;</span>');
    expect(marp).toContain('section .marpppt-accent { color: #2F6FED; }');
    expect(marp).toContain("\\[已達成\\]");
    expect(marp).not.toContain("<目標>");
  });

  it("keeps Markdown punctuation literal inside a styled Marp run", () => {
    const plan = PresentationPlanSchema.parse(planWithRuns([
      { text: "a*b*c `[x]` | foo_bar", bold: true, color: "accent" },
    ]));
    const marp = serializeMarp(plan, theme);
    expect(marp).toContain('<span class="marpppt-strong marpppt-accent">a&#42;b&#42;c &#96;&#91;x&#93;&#96; &#124; foo&#95;bar</span>');
    expect(marp).not.toContain("<span class=\"marpppt-strong marpppt-accent\">a*b*c");
  });

  it("keeps an adjacent complete formula typeset in Marp", () => {
    const plan = PresentationPlanSchema.parse(planWithRuns([
      { text: "核心結論 " },
      { text: "$\\frac{x}{y}$" },
      { text: " 提升", bold: true, color: "accent" },
    ]));
    const marp = serializeMarp(plan, theme);
    expect(marp).toContain("$\\frac{x}{y}$");
    expect(marp).toContain('<span class="marpppt-strong marpppt-accent"> 提升</span>');
  });

  it("keeps bold accent text in native editable PowerPoint runs", async () => {
    const plan = PresentationPlanSchema.parse(planWithRuns([
      { text: "準確率 " },
      { text: "62%", bold: true, color: "accent" },
    ]));
    const object = buildSlideLayout(plan.slides[0]!, theme).find((item) => item.kind === "text" && item.id === "result:text:point");
    expect(object?.kind).toBe("text");
    if (!object || object.kind !== "text") throw new Error("Expected editable text object");

    // @ts-expect-error PptxGenJS 4's ESM runtime is constructable; its NodeNext declaration is not.
    const pptx = new pptxgen();
    pptx.defineLayout({ name: "emphasis-test", width: theme.canvas.width, height: theme.canvas.height });
    pptx.layout = "emphasis-test";
    addLayoutObject(object, { pptx, slide: pptx.addSlide(), assets: new Map(), theme });
    const bytes = await pptx.write({ outputType: "uint8array" }) as Uint8Array;
    expect((await inspectPptx(bytes)).textShapeCount).toBe(1);
    const xml = strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"]!);
    const accentRun = xml.match(/<a:r>[\s\S]*?<\/a:r>/gu)?.find((run) => run.includes("<a:t>62%</a:t>"));
    expect(accentRun).toMatch(/<a:rPr[^>]*\bb="1"/u);
    expect(accentRun).toContain('val="2F6FED"');
  });
});
