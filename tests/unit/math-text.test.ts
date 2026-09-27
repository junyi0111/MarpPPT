import { describe, expect, it } from "vitest";
import { normalizeMathText } from "../../src/content/math-text.js";

describe("normalizeMathText", () => {
  it("turns common block LaTeX into readable plain text", () => {
    const value = String.raw`\[\mathrm{Attention}(Q,K,V)=\mathrm{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V\]`;
    const normalized = normalizeMathText(value);
    expect(normalized).toContain("Attention(Q,K,V)");
    expect(normalized).toContain("QKᵀ");
    expect(normalized).toContain("√(d_k)");
    expect(normalized).not.toMatch(/\\\[|\\\]|\\(?:mathrm|frac|sqrt|top)/u);
  });

  it("handles inline delimiters and leaves ordinary prose unchanged", () => {
    expect(normalizeMathText("模型使用 \\(QK^\\top\\) 計算權重。"))
      .toBe("模型使用 QKᵀ 計算權重。");
    expect(normalizeMathText("一般中英文與 https://example.test 不應變更"))
      .toBe("一般中英文與 https://example.test 不應變更");
  });

  it("does not leak unknown command backslashes", () => {
    expect(normalizeMathText(String.raw`$$x + \unknown{y}$$`)).toBe("x + unknowny");
  });
});
