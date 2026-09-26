import type { ProbeFileRef, ProbeResolver } from "./attachment-probe.js";
import { readStagedAttachment } from "./local-attachment-stage.js";

const fixtureFiles = [
  {
    ref: { fileName: "source.md", mimeType: "text/markdown", assetId: "fixture:source-md" },
    bytes: new TextEncoder().encode("title: Deck\n"),
  },
  {
    ref: { fileName: "photo.png", mimeType: "image/png", assetId: "fixture:photo-png" },
    bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
  },
] as const;

function isExactFixtureRef(ref: ProbeFileRef, fixture: (typeof fixtureFiles)[number]): boolean {
  return Object.keys(ref).every((key) => ["fileName", "mimeType", "assetId"].includes(key))
    && ref.fileName === fixture.ref.fileName
    && ref.mimeType === fixture.ref.mimeType
    && ref.assetId === fixture.ref.assetId;
}

export function createProbeResolver(options: { fixtureMode?: boolean; now?: () => number } = {}): ProbeResolver {
  if (!options.fixtureMode) {
    return {
      read: async (ref) => {
        if (typeof ref.assetId === "string" && ref.assetId.startsWith("stage:")) {
          return readStagedAttachment(ref, options.now?.() ?? Date.now());
        }
        throw new Error("Host-authorized attachment access is unavailable");
      },
    };
  }
  return {
    read: async (ref) => {
      const fixture = fixtureFiles.find((candidate) => isExactFixtureRef(ref, candidate));
      if (!fixture) throw new Error("Unknown probe fixture");
      return fixture.bytes.slice();
    },
  };
}
