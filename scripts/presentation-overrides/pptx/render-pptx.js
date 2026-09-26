import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import pptxgen from "pptxgenjs";
import { PresentationPlanSchema, validatePresentationPlan, } from "../contracts/presentation-plan.js";
import { buildSlideLayout } from "../layout/build-slide.js";
import { getCanvas } from "../layout/geometry.js";
import { findOverflow } from "../layout/overflow.js";
import { addLayoutObject } from "./add-layout-object.js";
import { repairPptxGenJsSlideMasterOverrides } from "./pptxgenjs-compat.js";
import { PptxValidationError, validatePptx } from "./validate-pptx.js";
export { PptxValidationError } from "./validate-pptx.js";
export class PptxRenderError extends Error {
    code;
    constructor(message, code, options = {}) {
        super(message);
        this.code = code;
        this.name = "PptxRenderError";
        this.assetId = options.assetId;
        this.issues = options.issues;
    }
    assetId;
    issues;
}
const CANVAS_WIDTH = 13.333;
const CANVAS_HEIGHT = 7.5;
const MAX_RENDERED_IMAGE_BYTES = 50 * 1024 * 1024;
function createPptx() {
    // PptxGenJS 4's ESM runtime is constructable, but its published NodeNext type is a namespace.
    // @ts-expect-error upstream ESM declaration mismatch
    const instance = new pptxgen();
    return instance;
}
function fontFace(theme) {
    const families = theme.typography.fontFace.split(",").map((family) => family.trim()).filter(Boolean);
    return families.find((family) => family.toLowerCase() === "noto sans cjk tc") ?? families[0] ?? "Noto Sans CJK TC";
}
function planIssues(plan, assetIds) {
    return validatePresentationPlan(plan, assetIds).filter((issue) => issue.severity === "error");
}
function layoutsForPlan(plan, theme) {
    const canvas = getCanvas(theme);
    return plan.slides.map((slide) => {
        const objects = buildSlideLayout(slide, theme);
        return { slide, objects, issues: findOverflow(objects, canvas) };
    });
}
function hasValidSignature(bytes, mimeType) {
    if (mimeType === "image/png") {
        return bytes.length >= 8
            && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
            && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    }
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
async function validateResolvedAssets(plan, assets) {
    if (!Array.isArray(assets) || assets.length !== plan.assetManifest.length) {
        throw new PptxRenderError("Resolved image assets do not match the presentation manifest.", "PPTX_ASSET_INVALID");
    }
    const manifestById = new Map(plan.assetManifest.map((asset) => [asset.assetId, asset]));
    const byId = new Map();
    let totalBytes = 0;
    for (const asset of assets) {
        if (!asset || typeof asset !== "object" || typeof asset.assetId !== "string" || typeof asset.sha256 !== "string") {
            throw new PptxRenderError("Resolved image asset metadata is malformed.", "PPTX_ASSET_INVALID");
        }
        const manifest = manifestById.get(asset.assetId);
        if (!manifest || byId.has(asset.assetId)) {
            throw new PptxRenderError("Resolved image asset IDs are missing, extra, or duplicated.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
        }
        if (asset.fileName !== manifest.fileName || asset.mimeType !== manifest.mimeType
            || asset.byteLength !== manifest.byteLength || asset.sha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
            throw new PptxRenderError("Resolved image metadata differs from the canonical asset manifest.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
        }
        if (typeof asset.path !== "string" || !isAbsolute(asset.path) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(asset.path)) {
            throw new PptxRenderError("Only absolute local paths returned by the authorized attachment resolver can be rendered.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
        }
        let stat;
        let content;
        try {
            stat = await lstat(asset.path);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new PptxRenderError("Resolved image path is not a regular file.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
            }
            content = await readFile(asset.path);
        }
        catch (error) {
            if (error instanceof PptxRenderError)
                throw error;
            if (error.code === "ENOENT") {
                throw new PptxRenderError("Resolved image file is missing.", "PPTX_ASSET_MISSING", { assetId: asset.assetId });
            }
            throw new PptxRenderError("Resolved image file cannot be read.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
        }
        const digest = createHash("sha256").update(content).digest("hex");
        if (content.byteLength !== manifest.byteLength || digest !== manifest.sha256.toLowerCase()
            || !hasValidSignature(content, manifest.mimeType)) {
            throw new PptxRenderError("Resolved image bytes do not match the validated image manifest.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
        }
        totalBytes += content.byteLength;
        if (totalBytes > MAX_RENDERED_IMAGE_BYTES) {
            throw new PptxRenderError("Resolved image assets exceed the 50 MiB package limit.", "PPTX_ASSET_INVALID", { assetId: asset.assetId });
        }
        byId.set(asset.assetId, asset);
    }
    return byId;
}
export async function renderPptx(plan, assets, theme) {
    if (!Array.isArray(assets)) {
        throw new PptxRenderError("Resolved image assets must be supplied by the attachment resolver.", "PPTX_ASSET_INVALID");
    }
    const parsed = PresentationPlanSchema.safeParse(plan);
    if (!parsed.success) {
        throw new PptxRenderError("Presentation plan failed contract validation.", "PLAN_INVALID", {
            issues: planIssues(plan, assets.flatMap((asset) => asset && typeof asset.assetId === "string" ? [asset.assetId] : [])),
        });
    }
    const checkedPlan = parsed.data;
    if (checkedPlan.themeId !== theme.id) {
        throw new PptxRenderError("Presentation plan theme does not match the selected theme.", "THEME_MISMATCH");
    }
    if (assets.some((asset) => !asset || typeof asset !== "object")) {
        throw new PptxRenderError("Resolved image asset metadata is malformed.", "PPTX_ASSET_INVALID");
    }
    if (theme.canvas.width !== CANVAS_WIDTH || theme.canvas.height !== CANVAS_HEIGHT) {
        throw new PptxRenderError("PowerPoint export requires the fixed 13.333 × 7.5 in canvas.", "PPTX_LAYOUT_INVALID", {
            issues: [{
                    code: "LAYOUT_OVERFLOW",
                    slideId: "theme",
                    objectId: "theme:canvas",
                    message: "Theme canvas dimensions must be exactly 13.333 × 7.5 in.",
                    actionable: true,
                }],
        });
    }
    const validationIssues = validatePresentationPlan(checkedPlan, assets.map((asset) => asset.assetId));
    const issues = validationIssues.filter((issue) => issue.severity === "error");
    if (issues.length > 0) {
        throw new PptxRenderError("Presentation plan references invalid or unavailable image assets.", "PLAN_INVALID", { issues });
    }
    const unusedImages = validationIssues.filter((issue) => issue.code === "UNUSED_IMAGE_ID");
    if (unusedImages.length > 0) {
        throw new PptxRenderError("Every received image must be placed on a planned slide or appendix before export.", "PLAN_INVALID", {
            issues: unusedImages,
        });
    }
    const layouts = layoutsForPlan(checkedPlan, theme);
    const layoutIssues = layouts.flatMap((layout) => layout.issues);
    if (layoutIssues.length > 0) {
        throw new PptxRenderError("PowerPoint export is blocked until every layout issue is resolved.", "PPTX_LAYOUT_INVALID", { issues: layoutIssues });
    }
    const resolvedAssets = await validateResolvedAssets(checkedPlan, assets);
    const selectedFont = fontFace(theme);
    const pptx = createPptx();
    const layoutName = "MARPPPT_13_333x7_5";
    pptx.defineLayout({ name: layoutName, width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
    pptx.layout = layoutName;
    pptx.title = checkedPlan.title;
    pptx.author = "MarpPPT";
    pptx.theme = { headFontFace: selectedFont, bodyFontFace: selectedFont };
    for (const slideLayout of layouts) {
        const slide = pptx.addSlide();
        const darkBackground = ["cover", "section", "closing"].includes(slideLayout.slide.layout);
        const backgroundColor = darkBackground ? theme.colors.darkBackground : theme.colors.background;
        slide.background = { color: backgroundColor.replace(/^#/u, "") };
        const context = {
            pptx,
            slide,
            assets: resolvedAssets,
            theme,
        };
        slideLayout.objects.forEach((object) => addLayoutObject(object, context));
    }
    try {
        const generated = await pptx.write({ outputType: "uint8array" });
        const serialized = generated instanceof Uint8Array ? generated
            : generated instanceof ArrayBuffer ? new Uint8Array(generated)
                : undefined;
        if (!serialized)
            throw new Error("PptxGenJS returned a non-binary output");
        const bytes = repairPptxGenJsSlideMasterOverrides(serialized);
        await validatePptx(bytes);
        return bytes;
    }
    catch (error) {
        if (error instanceof PptxRenderError)
            throw error;
        const message = error instanceof PptxValidationError ? error.message : "PPTX could not be serialized or validated.";
        throw new PptxRenderError(message, "PPTX_INVALID");
    }
}
export async function inspectPptx(bytes) {
    return validatePptx(bytes);
}
