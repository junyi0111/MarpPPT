import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { XMLSerializer, type Element } from "@xmldom/xmldom";
import { DRAWING_NS, PRESENTATION_NS, PptxValidationError, decodeOfficeXml, parseOfficeXml, unzipOfficeArchive } from "./office-xml.js";

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

/** Only called on fresh PptxGenJS output, never by inspectPptx on user files.
 * PptxGenJS 4.0.1 uses a table counter as a drawing ID, and appends an
 * apostrophe to embedded chart table ranges. Keep these workarounds narrow:
 * other duplicate IDs or malformed ranges must fail strict validation.
 */
export function repairPptxGenJsCompatibility(bytes: Uint8Array): Uint8Array {
  // Bound expansion before the historical slide-master helper inflates again.
  unzipOfficeArchive(bytes);
  const archive = unzipOfficeArchive(repairPptxGenJsSlideMasterOverrides(bytes));
  const serializer = new XMLSerializer();
  let changed = false;
  for (const [part, content] of Object.entries(archive)) {
    if (/^ppt\/slides\/slide\d+\.xml$/u.test(part)) {
      const document = parseOfficeXml(decodeOfficeXml(content, part), part);
      const drawings = Array.from(document.getElementsByTagNameNS(PRESENTATION_NS, "cNvPr"));
      const groups = new Map<string, typeof drawings>();
      for (const drawing of drawings) {
        const id = drawing.getAttribute("id")!;
        groups.set(id, [...(groups.get(id) ?? []), drawing]);
      }
      let nextId = Math.max(0, ...drawings.map((node) => Number(node.getAttribute("id")))) + 1;
      let repaired = false;
      for (const [id, group] of groups) {
        if (group.length < 2) continue;
        const tables = group.filter((drawing) => {
          const frame = drawing.parentNode?.parentNode;
          return frame?.nodeType === 1
            && (frame as Element).getElementsByTagNameNS(DRAWING_NS, "tbl").length > 0;
        });
        const isConnected = ["stCxn", "endCxn"].some((name) => Array.from(document.getElementsByTagNameNS(DRAWING_NS, name))
          .some((connection) => connection.getAttribute("id") === id));
        if (group.length - tables.length > 1 || isConnected || !Number.isSafeInteger(nextId)) {
          throw new PptxValidationError(`Ambiguous duplicate drawing ID ${id} in ${part}`, part);
        }
        const toReassign = tables.length === group.length ? tables.slice(1) : tables;
        for (const table of toReassign) table.setAttribute("id", String(nextId++));
        repaired = true;
      }
      if (repaired) { archive[part] = strToU8(serializer.serializeToString(document)); changed = true; }
    }
    if (part.endsWith(".xlsx")) {
      const workbook = unzipOfficeArchive(content, part, 32 * 1024 * 1024);
      let repaired = false;
      for (const [name, data] of Object.entries(workbook)) {
        if (!/^xl\/tables\/table\d+\.xml$/u.test(name)) continue;
        const document = parseOfficeXml(decodeOfficeXml(data, `${part}!/${name}`), `${part}!/${name}`);
        for (const table of Array.from(document.getElementsByTagNameNS("http://schemas.openxmlformats.org/spreadsheetml/2006/main", "table"))) {
          const range = table.getAttribute("ref") ?? "";
          const match = /^([A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*)'$/u.exec(range);
          if (match) { table.setAttribute("ref", match[1]!); repaired = true; }
        }
        if (repaired) workbook[name] = strToU8(serializer.serializeToString(document));
      }
      if (repaired) { archive[part] = zipSync(workbook, { level: 6 }); changed = true; }
    }
  }
  return changed ? zipSync(archive, { level: 6 }) : repairPptxGenJsSlideMasterOverrides(bytes);
}
