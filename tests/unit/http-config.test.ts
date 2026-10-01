import { describe, expect, it } from "vitest";
import { parseHttpRuntimeConfig } from "../../src/mcp/http-config.js";

const validEnvironment = {
  PORT: "8080",
  PPTX_OUTPUT_ROOT: "/private/tmp/marpppt-output",
  MARPPPT_PUBLIC_BASE_URL: "https://slides.example.test",
  MARPPPT_MAX_REQUEST_BYTES: "2097152",
  MARPPPT_MAX_ACTIVE_REQUESTS: "8",
  MARPPPT_MAX_ACTIVE_JOBS: "2",
};

describe("hosted HTTP configuration", () => {
  it("parses a bounded configuration with a private absolute output root and HTTPS artifact origin", () => {
    expect(parseHttpRuntimeConfig(validEnvironment)).toEqual({
      port: 8080,
      outputRoot: "/private/tmp/marpppt-output",
      publicBaseUrl: "https://slides.example.test",
      requestBodyLimitBytes: 2 * 1024 * 1024,
      maxActiveRequests: 8,
      maxActiveJobs: 2,
    });
  });

  it("allows enough JSON envelope for a maximum-size Markdown draft", () => {
    expect(parseHttpRuntimeConfig({ ...validEnvironment, MARPPPT_MAX_REQUEST_BYTES: String(4 * 1024 * 1024) }).requestBodyLimitBytes)
      .toBe(4 * 1024 * 1024);
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "not-a-port"],
    ["PPTX_OUTPUT_ROOT", "relative/output"],
    ["MARPPPT_PUBLIC_BASE_URL", "http://slides.example.test"],
    ["MARPPPT_PUBLIC_BASE_URL", "https://user:secret@slides.example.test"],
    ["MARPPPT_PUBLIC_BASE_URL", "https://slides.example.test/path"],
    ["MARPPPT_MAX_REQUEST_BYTES", "52428800"],
    ["MARPPPT_MAX_REQUEST_BYTES", "0"],
    ["MARPPPT_MAX_ACTIVE_REQUESTS", "0"],
    ["MARPPPT_MAX_ACTIVE_JOBS", "9"],
  ])("rejects invalid startup setting %s=%s before listening", (key, value) => {
    expect(() => parseHttpRuntimeConfig({ ...validEnvironment, [key]: value })).toThrow();
  });
});
