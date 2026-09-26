import { describe, expect, it } from "vitest";
import { createProbeResolver } from "../../src/probe/probe-resolver.js";

const markdownRef = {
  fileName: "source.md",
  mimeType: "text/markdown",
  assetId: "fixture:source-md",
};

describe("probe resolver authorization", () => {
  it("refuses attachment reads when no host authorization adapter is available", async () => {
    const resolver = createProbeResolver();
    await expect(resolver.read(markdownRef)).rejects.toThrow("Host-authorized attachment access is unavailable");
    await expect(resolver.read({ ...markdownRef, path: "/etc/passwd" } as typeof markdownRef)).rejects.toThrow(
      "Host-authorized attachment access is unavailable",
    );
  });

  it("allows only the fixed development fixtures in fixture mode", async () => {
    const resolver = createProbeResolver({ fixtureMode: true });
    expect(await resolver.read(markdownRef)).toEqual(new TextEncoder().encode("title: Deck\n"));
    expect(await resolver.read({
      fileName: "photo.png",
      mimeType: "image/png",
      assetId: "fixture:photo-png",
    })).toEqual(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await expect(resolver.read({ ...markdownRef, assetId: "other" })).rejects.toThrow("Unknown probe fixture");
    await expect(resolver.read({ ...markdownRef, path: "/etc/passwd" } as typeof markdownRef)).rejects.toThrow("Unknown probe fixture");
    await expect(resolver.read({ ...markdownRef, url: "https://example.com/file" } as typeof markdownRef)).rejects.toThrow("Unknown probe fixture");
  });
});
