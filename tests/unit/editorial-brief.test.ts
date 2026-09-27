import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EditorialBriefSchema, checkEditorial } from "../../src/contracts/editorial-brief.js";
import type { PresentationPlan } from "../../src/contracts/presentation-plan.js";

const markdown = "# 摘要\n\n平均回覆時間為 48 小時。\n\n# 方法\n\n流程分成三步。\n";
const digest = createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex");
const plan = {
  version: 1, title: "測試簡報", language: "zh-TW", themeId: "default", sourceDigest: digest,
  imageAssetIds: [], assetManifest: [],
  slides: [
    { id: "slide-1", title: "關鍵指標", layout: "bullets", blocks: [{ id: "fact", text: "平均回覆時間為 48 小時" }, { id: "method", text: "流程分成三步" }, { id: "limit", text: "仍需人工複核" }], imageIds: [], sourceRefs: ["# 摘要"] },
  ],
} as unknown as PresentationPlan;

function validBrief() {
  return EditorialBriefSchema.parse({
    version: 1, sourceDigest: digest, audience: "產品團隊", purpose: "說明流程", useCase: "presenting", requestedSlideCount: 1,
    mustKeepFacts: [{ id: "response-time", sourceSpan: { startLine: 3, endLine: 3 }, verbatim: "平均回覆時間為 48 小時", placement: "slide" }],
    assets: [],
    slides: [{ slideId: "slide-1", purpose: "讓觀眾記住指標", evidence: [{ startLine: 3, endLine: 3 }], factIds: ["response-time"], form: "metric", variant: "default", focus: { kind: "block", id: "fact" }, limitations: ["未含例外流程"], speakerNotes: [] }],
  });
}

describe("editorial brief", () => {
  it("validates a source-mapped brief and accepts a matching plan", () => {
    const brief = validBrief();
    expect(checkEditorial(brief, plan, markdown)).toEqual([]);
  });

  it("reports digest, source span, unknown IDs and unplaced must-keep facts", () => {
    const brief = EditorialBriefSchema.parse({ ...validBrief(), sourceDigest: "0".repeat(64), mustKeepFacts: [{ id: "missing", sourceSpan: { startLine: 99, endLine: 99 }, verbatim: "不存在", placement: "slide" }], slides: [{ ...validBrief().slides[0], slideId: "missing-slide", factIds: ["missing"] }] });
    const codes = checkEditorial(brief, plan, markdown).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(["EDITORIAL_SOURCE_DIGEST_MISMATCH", "EDITORIAL_PLAN_DIGEST_MISMATCH", "EDITORIAL_SOURCE_SPAN_OUT_OF_RANGE", "EDITORIAL_SLIDE_UNKNOWN"]));
  });

  it("rejects a requested page count that would require an unplanned appendix page", () => {
    const brief = EditorialBriefSchema.parse({ ...validBrief(), requestedSlideCount: 10 });
    expect(checkEditorial(brief, plan, markdown).map((entry) => entry.code)).toContain("EDITORIAL_SLIDE_COUNT_MISMATCH");
  });
});
