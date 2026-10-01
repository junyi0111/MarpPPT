import sharp from "sharp";

interface MathJaxAdaptor {
  tags(node: unknown, name: string): unknown[];
  create(name: string): unknown;
  node(name: string, attributes: Record<string, string>, children: unknown[], namespace: string): unknown;
  text(value: string): unknown;
  append(parent: unknown, child: unknown): unknown;
  removeAttribute(node: unknown, name: string): void;
  setAttribute(node: unknown, name: string, value: string): void;
  serializeXML(node: unknown): string;
}

interface MathJaxRuntime {
  startup: { promise: Promise<void>; adaptor: MathJaxAdaptor };
  tex2svgPromise(math: string, options: Record<string, unknown>): Promise<unknown>;
}

interface RenderedMathImage {
  data: string;
  aspectRatio: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_CSS = [
  "[data-frame],[data-line]{stroke-width:70px;fill:none}",
  ".mjx-dashed{stroke-dasharray:140}",
  ".mjx-dotted{stroke-linecap:round;stroke-dasharray:0,140}",
  "use[data-c]{stroke-width:3px}",
].join("");

let mathJaxPromise: Promise<MathJaxRuntime> | undefined;

async function loadMathJax(): Promise<MathJaxRuntime> {
  mathJaxPromise ??= (async () => {
    // Components and fonts load from the installed package only. No CDN path.
    const scope = globalThis as typeof globalThis & { MathJax?: MathJaxRuntime | Record<string, unknown> };
    scope.MathJax = {
      loader: {
        paths: { mathjax: "@mathjax/src/bundle" },
        load: ["input/tex", "output/svg", "adaptors/liteDOM"],
        require: (file: string) => import(file),
      },
      output: { font: "mathjax-newcm" },
      svg: { fontCache: "local" },
    };
    const component: string = "@mathjax/src/bundle/startup.js";
    await import(component);
    const runtime = scope.MathJax as unknown as MathJaxRuntime;
    await runtime.startup.promise;
    return runtime;
  })();
  return mathJaxPromise;
}

function assertSafeMath(value: string): void {
  if (!value.trim() || value.length > 2048) throw new Error("UNSUPPORTED_MATH: equation must contain 1–2048 characters.");
  // MathJax supports hyperlinks and extension loading, neither of which is
  // needed in a presentation equation. Reject them before parsing.
  if (/\\(?:require|href|url|html\w*|class|style|cssId|includegraphics|unicode|color|textcolor|colorbox|fcolorbox|bbox|def|gdef|edef|xdef|let|global|newcommand|renewcommand|providecommand|DeclareMathOperator|newenvironment|renewenvironment|label|ref|eqref|tag)\b/iu.test(value)
    || /(?:https?:\/\/|ftp:\/\/|\/\/|<\/?[A-Za-z])/iu.test(value)) {
    throw new Error("UNSUPPORTED_MATH: external content or HTML-like TeX commands are not allowed.");
  }
}

function svgDimensions(svg: string): { width: number; height: number } {
  const match = /\bviewBox="[\d.+-]+\s+[\d.+-]+\s+([\d.]+)\s+([\d.]+)"/u.exec(svg);
  const viewWidth = Number(match?.[1]);
  const viewHeight = Number(match?.[2]);
  if (!(viewWidth > 0 && viewHeight > 0)) throw new Error("MATH_RENDER_FAILED: MathJax returned SVG without valid dimensions.");
  const aspectRatio = viewWidth / viewHeight;
  if (!Number.isFinite(aspectRatio) || aspectRatio < 0.05 || aspectRatio > 100) {
    throw new Error("MATH_RENDER_FAILED: equation aspect ratio is outside the supported range.");
  }
  // A fixed pixel viewport gives libvips a stable raster size. The viewBox
  // keeps the mathematical glyph geometry and aspect ratio unchanged.
  const width = Math.min(2400, Math.max(480, Math.round(viewWidth / 8)));
  return { width, height: Math.max(16, Math.round(width / aspectRatio)) };
}

export async function renderMathImage(latex: string, color: string): Promise<RenderedMathImage> {
  assertSafeMath(latex);
  if (!/^#[0-9a-f]{6}$/iu.test(color)) throw new Error("MATH_RENDER_FAILED: equation color must be a six-digit theme color.");
  const mathJax = await loadMathJax();
  let output: unknown;
  try {
    output = await mathJax.tex2svgPromise(latex, { display: true, em: 16, ex: 8, containerWidth: 1280 });
  } catch (error) {
    throw new Error(`UNSUPPORTED_MATH: ${error instanceof Error ? error.message : String(error)}`);
  }
  const adaptor = mathJax.startup.adaptor;
  const svg = adaptor.tags(output, "svg")[0];
  if (!svg) throw new Error("MATH_RENDER_FAILED: MathJax did not produce an SVG equation.");
  const defs = adaptor.tags(svg, "defs")[0] ?? adaptor.append(svg, adaptor.create("defs"));
  adaptor.append(defs, adaptor.node("style", {}, [adaptor.text(SVG_CSS)], SVG_NS));
  for (const attribute of ["role", "focusable", "aria-hidden"]) adaptor.removeAttribute(svg, attribute);
  const glyphs = adaptor.tags(svg, "g")[0];
  if (glyphs) {
    adaptor.setAttribute(glyphs, "stroke", color);
    adaptor.setAttribute(glyphs, "fill", color);
  }
  let serialized = adaptor.serializeXML(svg);
  if (/data-mml-node="merror"|\b(?:fill|stroke)="red"|<a\b|<script\b|<image\b|<foreignObject\b|\b(?:href|xlink:href)="(?:https?:|ftp:|\/\/)/iu.test(serialized)) {
    throw new Error("UNSUPPORTED_MATH: equation contains an unknown command or external content.");
  }
  const { width, height } = svgDimensions(serialized);
  serialized = serialized.replace(/\bwidth="[^"]+"/u, `width="${width}px"`)
    .replace(/\bheight="[^"]+"/u, `height="${height}px"`);
  try {
    const png = await sharp(Buffer.from(serialized, "utf8"), { limitInputPixels: 20_000_000 }).png().toBuffer();
    return { data: `image/png;base64,${png.toString("base64")}`, aspectRatio: width / height };
  } catch (error) {
    throw new Error(`MATH_RENDER_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}
