import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const DEFAULT_SLIDE_MASTER = "ppt/slideMasters/slideMaster1.xml";

/**
 * PptxGenJS 4.0.1 emits one slideMaster Override per slide even though this
 * renderer writes only the single default slide master. Remove only those
 * nonexistent extra slideMaster entries; validatePptx still checks every
 * remaining Override and relationship strictly.
 *
 * Upstream tracking: https://github.com/gitbrent/PptxGenJS/issues/1444
 */
export function repairPptxGenJsSlideMasterOverrides(bytes: Uint8Array): Uint8Array {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    return bytes;
  }

  const masterParts = Object.keys(archive).filter((path) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/u.test(path));
  if (masterParts.length !== 1 || masterParts[0] !== DEFAULT_SLIDE_MASTER || !archive["[Content_Types].xml"]) {
    return bytes;
  }

  let removed = false;
  const contentTypes = strFromU8(archive["[Content_Types].xml"]!).replace(/<Override\b[^>]*\/>/gu, (tag) => {
    const partName = /\bPartName\s*=\s*(["'])(.*?)\1/u.exec(tag)?.[2];
    if (!partName || !/^\/ppt\/slideMasters\/slideMaster\d+\.xml$/u.test(partName)) return tag;
    if (archive[partName.slice(1)]) return tag;
    removed = true;
    return "";
  });

  if (!removed) return bytes;
  archive["[Content_Types].xml"] = strToU8(contentTypes);
  return zipSync(archive, { level: 6 });
}
