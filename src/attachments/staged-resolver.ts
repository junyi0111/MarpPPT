import type { ProbeResolver } from "./attachment-reference.js";
import { readStagedAttachment } from "./local-attachment-stage.js";

export function createStagedAttachmentResolver(options: { now?: () => number } = {}): ProbeResolver {
  return {
    read: async (ref) => {
      if (typeof ref.assetId !== "string" || !ref.assetId.startsWith("stage:")) {
        throw new Error("Host-authorized attachment access is unavailable");
      }
      return readStagedAttachment(ref, options.now?.() ?? Date.now());
    },
  };
}
