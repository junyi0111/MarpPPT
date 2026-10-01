import { describe, expect, it } from "vitest";
import { normalizeMathText, splitMathSegments, UnsupportedMathError } from "../../src/content/math-text.js";

describe("normalizeMathText", () => {
  it("turns common block LaTeX into readable plain text", () => {
    const value = String.raw`\[\mathrm{Attention}(Q,K,V)=\mathrm{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V\]`;
    const normalized = normalizeMathText(value);
    expect(normalized).toContain("Attention(Q,K,V)");
    expect(normalized).toContain("QKᵀ");
    expect(normalized).toContain("√(dₖ)");
    expect(normalized).not.toMatch(/\\\[|\\\]|\\(?:mathrm|frac|sqrt|top)/u);
  });

  it("handles inline delimiters and leaves ordinary prose unchanged", () => {
    expect(normalizeMathText("模型使用 \\(QK^\\top\\) 計算權重。"))
      .toBe("模型使用 QKᵀ 計算權重。");
    expect(normalizeMathText("一般中英文與 https://example.test 不應變更"))
      .toBe("一般中英文與 https://example.test 不應變更");
    expect(normalizeMathText(String.raw`\frac{1}{2}`)).toBe("(1)/(2)");
  });

  it("keeps prose identifiers and Windows paths unchanged when they contain a TeX-looking command", () => {
    expect(normalizeMathText(String.raw`The model_name uses \frac{1}{2} in C:\math\frac{1}{2}.`))
      .toBe(String.raw`The model_name uses \frac{1}{2} in C:\math\frac{1}{2}.`);
    expect(normalizeMathText(String.raw`\frac{1}{2} model_name`))
      .toBe(String.raw`\frac{1}{2} model_name`);
  });

  it("preserves the original TeX content for Marp while identifying display and inline math", () => {
    expect(splitMathSegments(String.raw`Start $x^2$ and \[\frac{a}{b}\] end`)).toEqual([
      { kind: "text", value: "Start ", display: false },
      { kind: "math", value: "x^2", display: false },
      { kind: "text", value: " and ", display: false },
      { kind: "math", value: String.raw`\frac{a}{b}`, display: true },
      { kind: "text", value: " end", display: false },
    ]);
  });

  it("renders common scripts, Greek letters, nested fractions and roots as editable Unicode text", () => {
    expect(normalizeMathText(String.raw`$\alpha_i^2 + \frac{1}{\sqrt{x^2 + y^2}}$`))
      .toBe("αᵢ² + (1)/(√(x² + y²))");
  });

  it("retains a readable linear script when Unicode has no equivalent", () => {
    expect(normalizeMathText(String.raw`$x^{longname}_{subgroup}$`))
      .toBe("x^(longname)_(subgroup)");
  });

  it("applies a script after a fraction to the whole fraction", () => {
    expect(normalizeMathText(String.raw`$\frac{a}{b}^2$`)).toBe("((a)/(b))²");
    expect(normalizeMathText("${x+y}^2$")).toBe("(x+y)²");
  });

  it("rejects unsupported commands rather than silently changing mathematical meaning", () => {
    expect(() => normalizeMathText(String.raw`$$x + \unknown{y}$$`))
      .toThrow(UnsupportedMathError);
    expect(() => normalizeMathText(String.raw`$\href{https://example.test}{x}$`))
      .toThrow(/UNSUPPORTED_MATH_COMMAND.*href/u);
    expect(() => normalizeMathText(String.raw`$\frac{1}$`))
      .toThrow(/MATH_ARGUMENT_REQUIRED/u);
    expect(() => normalizeMathText(String.raw`$x^{}$`))
      .toThrow(/MATH_ARGUMENT_REQUIRED/u);
  });

  it("rejects unclosed math delimiters and escaped literal dollars stay as prose", () => {
    expect(() => splitMathSegments(String.raw`The term \[x^2`)).toThrow(/MATH_DELIMITER_UNCLOSED/u);
    expect(splitMathSegments(String.raw`Cost \$20 and $x^2$`)).toEqual([
      { kind: "text", value: String.raw`Cost \$20 and `, display: false },
      { kind: "math", value: "x^2", display: false },
    ]);
    expect(normalizeMathText("From $32 to $62 per month")).toBe("From $32 to $62 per month");
  });

  it("rejects oversized and excessively nested expressions before rendering", () => {
    expect(() => normalizeMathText(`$${"x".repeat(4097)}$`))
      .toThrow(/MATH_EXPRESSION_TOO_LONG/u);
    expect(() => normalizeMathText(`$${"{".repeat(65)}x${"}".repeat(65)}$`))
      .toThrow(/MATH_NESTING_LIMIT/u);
  });
});
