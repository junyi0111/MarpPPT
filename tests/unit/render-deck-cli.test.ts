import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/render-deck.js";

describe("render-deck CLI arguments", () => {
  it("parses render options and resolves paths", () => {
    const args = parseArgs(["render", "--source", "a.md", "--plan", "p.json", "--image", "x.png", "--image", "y.jpg"]);
    expect(args.command).toBe("render");
    expect(args.images).toHaveLength(2);
    expect(args.source.endsWith("a.md")).toBe(true);
  });

  it("rejects render without a plan and unknown flags", () => {
    expect(() => parseArgs(["render", "--source", "a.md"])).toThrow(/Usage/);
    expect(() => parseArgs(["inspect", "--source", "a.md", "--bogus", "x"])).toThrow(/Usage/);
    expect(() => parseArgs(["nope"])).toThrow(/Usage/);
  });
});
