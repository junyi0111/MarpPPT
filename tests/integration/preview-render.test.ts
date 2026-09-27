import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { makeTwoSlidePreviewFixture } from "../helpers/preview-fixtures.js";
import { renderPreview } from "../../src/preview/render-preview.js";

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirectories.length = 0;
});

describe("preview rendering", () => {
  it("returns one rendered page for each slide and builds a contact sheet", async () => {
    const fixture = await makeTwoSlidePreviewFixture();
    tempDirectories.push(fixture.tempDirectory);
    const allCjkCharacters = "process.stdout.write(String.fromCodePoint(...Array.from({ length: 0x9fff - 0x3400 + 1 }, (_, index) => 0x3400 + index)))";
    const report = await renderPreview(fixture.twoSlidePptxPath, fixture.tempDirectory, {
      commands: { pdftotext: { file: process.execPath, args: ["-e", allCjkCharacters, "--"] } },
    });

    expect(report.status).toBe("ready");
    expect(report.slideCount).toBe(2);
    expect(report.pdfPageCount).toBe(2);
    expect(report.pageCount).toBe(2);
    expect(report.pngPaths).toHaveLength(2);
    expect(report.contactSheetPath).toBeTruthy();
    expect(report.visualQaPassed).toBe(false);
    await Promise.all(report.pngPaths.map((path) => access(path)));
    await access(report.contactSheetPath!);
    expect(report.font.requested).toContain("Noto Sans CJK TC");
    expect(report.font.selected === null || typeof report.font.selected === "string").toBe(true);
    if (report.font.selected === null) {
      expect(report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "FONT_MATCHER_UNAVAILABLE" })]));
    }
  });

  it("returns a draft when the PDF text layer drops source CJK characters", async () => {
    const fixture = await makeTwoSlidePreviewFixture({ includeCjk: true });
    tempDirectories.push(fixture.tempDirectory);
    const report = await renderPreview(fixture.twoSlidePptxPath, fixture.tempDirectory, {
      commands: { pdftotext: { file: process.execPath, args: ["-e", "process.stdout.write('no cjk glyphs')", "--"] } },
    });

    expect(report.status).toBe("draft");
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "FONT_GLYPH_MISSING", stage: "pdftotext" })]));
    expect(report.visualQaPassed).toBe(false);
    expect(report.pdfPath).toBeNull();
  });

  it("returns a draft and a structured error for a malformed PPTX", async () => {
    const fixture = await makeTwoSlidePreviewFixture();
    tempDirectories.push(fixture.tempDirectory);
    const malformedPath = join(fixture.tempDirectory, "malformed.pptx");
    await writeFile(malformedPath, "not a PowerPoint archive");

    const report = await renderPreview(malformedPath, fixture.tempDirectory);

    expect(report.status).toBe("draft");
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PPTX_INVALID" })]));
    expect(report.visualQaPassed).toBe(false);
    expect(report.pngPaths).toEqual([]);
  });

  it("rejects a PPTX outside its temporary job directory", async () => {
    const fixture = await makeTwoSlidePreviewFixture();
    tempDirectories.push(fixture.tempDirectory);
    const jobDirectory = join(fixture.tempDirectory, "job");
    await mkdir(jobDirectory, { mode: 0o700 });

    const report = await renderPreview(fixture.twoSlidePptxPath, jobDirectory);

    expect(report.status).toBe("draft");
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PREVIEW_INVALID_INPUT" })]));
  });

  it("returns PREVIEW_UNAVAILABLE when LibreOffice is missing", async () => {
    const fixture = await makeTwoSlidePreviewFixture();
    tempDirectories.push(fixture.tempDirectory);

    const report = await renderPreview(fixture.twoSlidePptxPath, fixture.tempDirectory, {
      commands: { soffice: { file: join(fixture.tempDirectory, "missing soffice") } },
    });

    expect(report.status).toBe("draft");
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PREVIEW_UNAVAILABLE", stage: "soffice" })]));
    expect(report.visualQaPassed).toBe(false);
    expect((await readdir(fixture.tempDirectory)).some((name) => name.startsWith(".preview-"))).toBe(false);
    expect(report.pdfPath).toBeNull();
  });

  it("returns PREVIEW_TIMEOUT and kills the renderer and its child process", async () => {
    const fixture = await makeTwoSlidePreviewFixture();
    tempDirectories.push(fixture.tempDirectory);
    const markerPath = join(fixture.tempDirectory, "child.pid");
    const heartbeatPath = join(fixture.tempDirectory, "child.heartbeat");
    const hangingRendererPath = join(fixture.tempDirectory, "hanging-renderer.mjs");
    await writeFile(hangingRendererPath, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`setInterval(() => require("node:fs").writeFileSync(${JSON.stringify(heartbeatPath)}, String(Date.now())), 20)`)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(markerPath)}, String(child.pid));`,
      'setInterval(() => {}, 10000);',
    ].join("\n"), { mode: 0o600 });

    const report = await renderPreview(fixture.twoSlidePptxPath, fixture.tempDirectory, {
      timeoutMs: 150,
      commands: { soffice: { file: process.execPath, args: [hangingRendererPath] } },
    });

    expect(report.status).toBe("draft");
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PREVIEW_TIMEOUT", stage: "soffice" })]));
    const childPid = Number(await readFile(markerPath, "utf8"));
    expect(childPid).toBeGreaterThan(0);
    const firstHeartbeat = await readFile(heartbeatPath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(heartbeatPath, "utf8")).toBe(firstHeartbeat);
  });

  it("aborts detached renderer processes when the HTTP worker receives termination", async () => {
    const fixture = await makeTwoSlidePreviewFixture();
    tempDirectories.push(fixture.tempDirectory);
    const markerPath = join(fixture.tempDirectory, "abort-child.pid");
    const heartbeatPath = join(fixture.tempDirectory, "abort-child.heartbeat");
    const hangingRendererPath = join(fixture.tempDirectory, "abort-renderer.mjs");
    await writeFile(hangingRendererPath, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`setInterval(() => require("node:fs").writeFileSync(${JSON.stringify(heartbeatPath)}, String(Date.now())), 20)`)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(markerPath)}, String(child.pid));`,
      'setInterval(() => {}, 10000);',
    ].join("\n"), { mode: 0o600 });
    const controller = new AbortController();
    const rendering = renderPreview(fixture.twoSlidePptxPath, fixture.tempDirectory, {
      signal: controller.signal,
      timeoutMs: 5_000,
      commands: { soffice: { file: process.execPath, args: [hangingRendererPath] } },
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await access(heartbeatPath); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    const firstHeartbeat = await readFile(heartbeatPath, "utf8");
    const abortStartedAt = Date.now();
    controller.abort();
    const report = await rendering;
    const abortDurationMs = Date.now() - abortStartedAt;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(report.status).toBe("draft");
    expect(abortDurationMs).toBeLessThan(1_500);
    expect(await readFile(heartbeatPath, "utf8")).toBe(firstHeartbeat);
  }, 10_000);

  it("returns PAGE_COUNT_MISMATCH when Poppler produces fewer pages than the PPTX", async () => {
    const fixture = await makeTwoSlidePreviewFixture();
    tempDirectories.push(fixture.tempDirectory);
    const onePagePath = join(fixture.tempDirectory, "one page.png");
    const fakePopplerPath = join(fixture.tempDirectory, "one-page-poppler.mjs");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } }).png().toFile(onePagePath);
    await writeFile(fakePopplerPath, [
      'import { copyFileSync } from "node:fs";',
      `copyFileSync(${JSON.stringify(onePagePath)}, process.argv.at(-1) + "-1.png");`,
    ].join("\n"), { mode: 0o600 });

    const report = await renderPreview(fixture.twoSlidePptxPath, fixture.tempDirectory, {
      commands: { pdftoppm: { file: process.execPath, args: [fakePopplerPath] } },
    });

    expect(report.status).toBe("draft");
    expect(report.pdfPageCount).toBe(2);
    expect(report.pageCount).toBe(1);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "PAGE_COUNT_MISMATCH",
      expectedPages: 2,
      actualPages: 1,
    })]));
    expect(report.visualQaPassed).toBe(false);
    expect(report.pdfPath).toBeNull();
    expect(report.pngPaths).toEqual([]);
    expect(report.contactSheetPath).toBeNull();
    expect((await readdir(fixture.tempDirectory)).some((name) => name.startsWith(".preview-"))).toBe(false);
  });

  it("rejects a gap in Poppler page numbers even when the PNG count matches", async () => {
    const fixture = await makeTwoSlidePreviewFixture();
    tempDirectories.push(fixture.tempDirectory);
    const onePagePath = join(fixture.tempDirectory, "one page.png");
    const fakePopplerPath = join(fixture.tempDirectory, "gapped-poppler.mjs");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } }).png().toFile(onePagePath);
    await writeFile(fakePopplerPath, [
      'import { copyFileSync } from "node:fs";',
      `copyFileSync(${JSON.stringify(onePagePath)}, process.argv.at(-1) + "-1.png");`,
      `copyFileSync(${JSON.stringify(onePagePath)}, process.argv.at(-1) + "-3.png");`,
    ].join("\n"), { mode: 0o600 });

    const report = await renderPreview(fixture.twoSlidePptxPath, fixture.tempDirectory, {
      commands: { pdftoppm: { file: process.execPath, args: [fakePopplerPath] } },
    });

    expect(report.status).toBe("draft");
    expect(report.pdfPageCount).toBe(2);
    expect(report.pageCount).toBe(2);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "PAGE_SEQUENCE_INVALID",
      missingPageNumbers: [2],
      unexpectedPageNumbers: [3],
    })]));
    expect(report.pngPaths).toEqual([]);
    expect(report.contactSheetPath).toBeNull();
    expect((await readdir(fixture.tempDirectory)).some((name) => name.startsWith(".preview-"))).toBe(false);
  });

  it("caps stderr included in a structured renderer failure", async () => {
    const fixture = await makeTwoSlidePreviewFixture();
    tempDirectories.push(fixture.tempDirectory);
    const noisyRendererPath = join(fixture.tempDirectory, "noisy-renderer.mjs");
    await writeFile(noisyRendererPath, [
      'process.stderr.write("x".repeat(100000));',
      'process.exit(2);',
    ].join("\n"), { mode: 0o600 });

    const report = await renderPreview(fixture.twoSlidePptxPath, fixture.tempDirectory, {
      commands: { soffice: { file: process.execPath, args: [noisyRendererPath] } },
    });

    const renderError = report.errors.find((error) => error.stage === "soffice");
    expect(report.status).toBe("draft");
    expect(renderError).toBeDefined();
    expect(renderError!.stderr?.length ?? 0).toBeLessThanOrEqual(4096);
    expect(report.visualQaPassed).toBe(false);
  });
});
