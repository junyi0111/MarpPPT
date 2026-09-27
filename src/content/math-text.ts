/**
 * Converts the small, common subset of Markdown/LaTeX math used in source
 * notes into readable text.  PPTX text runs do not have a math renderer, so
 * leaving the original control strings in the deck produces visibly broken
 * slides.  This deliberately favours an honest plain-text downgrade over a
 * pretend typeset equation.
 */
export function normalizeMathText(value: string): string {
  const hasMath = /\\\[|\\\]|\\\(|\\\)|\$\$|\$[^$\n]+\$/u.test(value)
    || /\\(?:mathrm|operatorname|text|frac|sqrt|left|right|cdot|times|top|to|rightarrow)\b/u.test(value);
  if (!hasMath) return value;

  let normalized = value
    .replaceAll("\\[", "")
    .replaceAll("\\]", "")
    .replaceAll("\\(", "")
    .replaceAll("\\)", "")
    .replace(/\$\$/gu, "")
    .replace(/\$([^$\n]+)\$/gu, "$1");

  // Inner constructs are simplified first so the outer fraction has no
  // nested braces left to confuse the intentionally small parser.
  normalized = normalized
    .replace(/\\sqrt\s*\{([^{}]*)\}/gu, "√($1)")
    .replace(/\\(?:mathrm|operatorname|text)\s*\{([^{}]*)\}/gu, "$1")
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/gu, "($1) / ($2)")
    .replace(/\\left|\\right/gu, "")
    .replace(/\\cdot/gu, "·")
    .replace(/\\times/gu, "×")
    .replace(/\\top\b/gu, "ᵀ")
    .replace(/\\(?:rightarrow|to)\b/gu, "→");

  // Keep the visible command name for an unknown command instead of leaking
  // a backslash sequence into the deck.  This makes unsupported notation
  // readable and easy for a user to refine later.
  normalized = normalized
    .replace(/\\([A-Za-z]+)\b/gu, "$1")
    .replace(/\^ᵀ/gu, "ᵀ")
    .replace(/[{}]/gu, "")
    .replace(/[ \t]+/gu, " ")
    .trim();
  return normalized;
}
