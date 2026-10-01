import { describe, expect, it } from "vitest";
import { extractPdfText, PdfTextError } from "../../src/source/pdf-text.js";

const pdfBytes = Buffer.from("%PDF-1.7\nminimal test bytes", "ascii");

describe("bounded PDF text extraction", () => {
  it("passes layout and one-based page selectors to the injected extractor", async () => {
    let filePath = "";
    let args: string[] = [];
    const text = await extractPdfText(pdfBytes, { from: 2, to: 4 }, {
      run: async (path, commandArgs) => {
        filePath = path;
        args = commandArgs;
        return Buffer.from("Page 2\nPage 4\n", "utf8");
      },
    });
    expect(filePath).toMatch(/\.pdf$/u);
    expect(args).toEqual(["-layout", "-f", "2", "-l", "4", filePath, "-"]);
    expect(text).toBe("Page 2\nPage 4\n");
  });

  it("rejects non-PDF bytes before invoking the extractor", async () => {
    let invoked = false;
    await expect(extractPdfText(Buffer.from("not pdf"), undefined, {
      run: async () => {
        invoked = true;
        return Buffer.from("unexpected");
      },
    })).rejects.toMatchObject<PdfTextError>({ code: "PDF_INVALID" });
    expect(invoked).toBe(false);
  });

  it("maps output overflows and runner failures to typed errors", async () => {
    await expect(extractPdfText(pdfBytes, undefined, {
      maxOutputBytes: 4,
      run: async () => Buffer.from("too long", "utf8"),
    })).rejects.toMatchObject<PdfTextError>({ code: "PDF_EXTRACT_OUTPUT_LIMIT" });
    await expect(extractPdfText(pdfBytes, undefined, {
      run: async () => { throw new PdfTextError("PDF_EXTRACTOR_UNAVAILABLE", "pdftotext missing"); },
    })).rejects.toMatchObject<PdfTextError>({ code: "PDF_EXTRACTOR_UNAVAILABLE" });
  });
});
