/** Math spans retain their original TeX for Marp's math renderer. */
export type MathSegment =
  | { kind: "text"; value: string; display: false }
  | { kind: "math"; value: string; display: boolean };

export class UnsupportedMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMathError";
  }
}

const MAX_EXPRESSION_LENGTH = 4096;
const MAX_GROUP_DEPTH = 64;

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ",
  sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "ϕ", chi: "χ",
  psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
  Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤",
  ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", infty: "∞",
  sum: "∑", prod: "∏", int: "∫", partial: "∂", nabla: "∇", to: "→",
  rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", in: "∈", notin: "∉",
  subset: "⊂", subseteq: "⊆", forall: "∀", exists: "∃", top: "ᵀ",
  bot: "⊥", mid: "∣", vert: "|", langle: "⟨", rangle: "⟩",
};

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ",
  l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ",
  x: "ˣ", y: "ʸ", z: "ᶻ", T: "ᵀ", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "ᵀ": "ᵀ",
};

const SUBSCRIPT: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ",
  r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
};

/** Recognize explicit TeX delimiters without changing the formula source. */
export function splitMathSegments(value: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let textStart = 0;
  let index = 0;
  while (index < value.length) {
    if (value.startsWith("\\$", index)) {
      index += 2;
      continue;
    }
    let open = "";
    let close = "";
    let display = false;
    if (value.startsWith("\\[", index)) {
      open = "\\["; close = "\\]"; display = true;
    } else if (value.startsWith("\\(", index)) {
      open = "\\("; close = "\\)";
    } else if (value.startsWith("$$", index)) {
      open = "$$"; close = "$$"; display = true;
    } else if (value[index] === "$") {
      open = "$"; close = "$";
    }
    if (!open) {
      index += 1;
      continue;
    }
    const contentStart = index + open.length;
    let contentEnd = -1;
    for (let cursor = contentStart; cursor < value.length; cursor += 1) {
      if (!display && value[cursor] === "\n") break;
      if (value.startsWith("\\$", cursor)) {
        cursor += 1;
        continue;
      }
      if (value.startsWith(close, cursor)) {
        contentEnd = cursor;
        break;
      }
    }
    if (contentEnd < 0) {
      if (open === "$") {
        index += 1; // An unmatched dollar is commonly currency in prose.
        continue;
      }
      throw new UnsupportedMathError(`MATH_DELIMITER_UNCLOSED: ${open}`);
    }
    const tex = value.slice(contentStart, contentEnd);
    if (open === "$" && (/^\s/u.test(tex) || /\s$/u.test(tex))) {
      index += 1; // Currency pairs commonly contain a separating space.
      continue;
    }
    if (!tex.trim()) throw new UnsupportedMathError(`EMPTY_MATH_EXPRESSION: ${open}`);
    if (tex.length > MAX_EXPRESSION_LENGTH) {
      throw new UnsupportedMathError(`MATH_EXPRESSION_TOO_LONG: limit ${MAX_EXPRESSION_LENGTH} characters`);
    }
    if (textStart < index) segments.push({ kind: "text", value: value.slice(textStart, index), display: false });
    segments.push({ kind: "math", value: tex, display });
    index = contentEnd + close.length;
    textStart = index;
  }
  if (textStart < value.length) segments.push({ kind: "text", value: value.slice(textStart), display: false });
  return segments;
}

class LinearTexReader {
  private index = 0;
  private groupDepth = 0;

  constructor(private readonly tex: string) {}

  parse(inGroup = false): string {
    if (inGroup && ++this.groupDepth > MAX_GROUP_DEPTH) {
      throw new UnsupportedMathError(`MATH_NESTING_LIMIT: at most ${MAX_GROUP_DEPTH} groups`);
    }
    let output = "";
    let lastAtomStart = -1;
    while (this.index < this.tex.length) {
      const character = this.tex[this.index]!;
      if (character === "}") {
        if (!inGroup) throw new UnsupportedMathError("MATH_BRACE_UNEXPECTED: }");
        this.index += 1;
        this.groupDepth -= 1;
        return output;
      }
      if (character === "{") {
        this.index += 1;
        lastAtomStart = output.length;
        output += this.parse(true);
      } else if (character === "\\") {
        const atom = this.command();
        if (atom) {
          lastAtomStart = output.length;
          output += atom;
        }
      } else if (character === "^" || character === "_") {
        this.index += 1;
        if (lastAtomStart < 0 || !output.slice(lastAtomStart).trim()) {
          throw new UnsupportedMathError(`MATH_SCRIPT_WITHOUT_BASE: ${character}`);
        }
        const argument = this.argument();
        if (!argument) throw new UnsupportedMathError("MATH_ARGUMENT_REQUIRED: empty script argument");
        const alphabet = character === "^" ? SUPERSCRIPT : SUBSCRIPT;
        const characters = Array.from(argument);
        const mapped = characters.map((symbol) => alphabet[symbol]);
        const base = output.slice(lastAtomStart);
        const wholeBase = /[+\-*/=]/u.test(base) ? `(${base})` : base;
        output = output.slice(0, lastAtomStart) + wholeBase + (characters.length <= 3 && mapped.every(Boolean)
          ? mapped.join("")
          : `${character}(${argument})`);
      } else {
        lastAtomStart = /\s/u.test(character) ? -1 : output.length;
        output += character;
        this.index += 1;
      }
    }
    if (inGroup) throw new UnsupportedMathError("MATH_BRACE_UNCLOSED: {");
    return output;
  }

  private group(): string {
    while (this.tex[this.index] === " ") this.index += 1;
    if (this.tex[this.index] !== "{") throw new UnsupportedMathError("MATH_ARGUMENT_REQUIRED: expected {...}");
    this.index += 1;
    return this.parse(true);
  }

  private argument(): string {
    while (this.tex[this.index] === " ") this.index += 1;
    if (this.index >= this.tex.length) throw new UnsupportedMathError("MATH_ARGUMENT_REQUIRED: missing script argument");
    if (this.tex[this.index] === "{") return this.group();
    if (this.tex[this.index] === "\\") return this.command();
    const result = this.tex[this.index]!;
    this.index += 1;
    return result;
  }

  private command(): string {
    this.index += 1;
    const start = this.index;
    while (/[A-Za-z]/u.test(this.tex[this.index] ?? "")) this.index += 1;
    if (this.index === start) {
      const escaped = this.tex[this.index];
      if (escaped && "{}$%&_#".includes(escaped)) {
        this.index += 1;
        return escaped;
      }
      if (escaped && ",;! ".includes(escaped)) {
        this.index += 1;
        return escaped === "!" ? "" : " ";
      }
      throw new UnsupportedMathError(`UNSUPPORTED_MATH_COMMAND: \\${escaped ?? ""}`);
    }
    const name = this.tex.slice(start, this.index);
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const numerator = this.group();
      const denominator = this.group();
      if (!numerator || !denominator) throw new UnsupportedMathError("MATH_ARGUMENT_REQUIRED: fraction numerator and denominator");
      return `(${numerator})/(${denominator})`;
    }
    if (name === "sqrt") {
      let index = "";
      if (this.tex[this.index] === "[") {
        const end = this.tex.indexOf("]", this.index + 1);
        if (end < 0) throw new UnsupportedMathError("MATH_ARGUMENT_REQUIRED: root index is unclosed");
        index = this.tex.slice(this.index + 1, end).trim();
        this.index = end + 1;
      }
      const radicand = this.group();
      if (!radicand) throw new UnsupportedMathError("MATH_ARGUMENT_REQUIRED: root radicand");
      return `${index === "3" ? "∛" : index === "4" ? "∜" : index ? `√[${index}]` : "√"}(${radicand})`;
    }
    if (["mathrm", "operatorname", "text", "mathbf", "mathit", "mathsf"].includes(name)) return this.group();
    if (name === "left" || name === "right") {
      if (this.tex[this.index] === ".") this.index += 1;
      return "";
    }
    if (name === "quad" || name === "qquad") return " ";
    if (Object.hasOwn(SYMBOLS, name)) return SYMBOLS[name]!;
    throw new UnsupportedMathError(`UNSUPPORTED_MATH_COMMAND: \\${name}`);
  }
}

const BARE_MATH_START = /^\\(?:frac|dfrac|tfrac|sqrt|mathrm|operatorname|text|mathbf|mathit|mathsf|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|phi|omega|cdot|times|top|sum|prod|int)\b/u;

function isBareMathSnippet(value: string): boolean {
  const trimmed = value.trim();
  if (!BARE_MATH_START.test(trimmed)) return false;
  let braceDepth = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (character === "\\" && "{}".includes(trimmed[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth -= 1;
    else if (braceDepth === 0 && /\s/u.test(character)) return false;
  }
  return true;
}

/** PPTX text remains editable; formula layout is represented linearly. */
export function normalizeMathText(value: string): string {
  return splitMathSegments(value).map((segment) => {
    if (segment.kind === "math") return new LinearTexReader(segment.value).parse().replace(/\s+/gu, " ").trim();
    // A complete bare expression is accepted for older source notes. Prose
    // that merely mentions a TeX command remains byte-for-byte unchanged.
    if (isBareMathSnippet(segment.value)) {
      if (segment.value.trim().length > MAX_EXPRESSION_LENGTH) {
        throw new UnsupportedMathError(`MATH_EXPRESSION_TOO_LONG: limit ${MAX_EXPRESSION_LENGTH} characters`);
      }
      return new LinearTexReader(segment.value).parse();
    }
    return segment.value;
  }).join("");
}
