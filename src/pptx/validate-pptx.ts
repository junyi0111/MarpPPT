import { posix as path } from "node:path";
import type { PptxInspection } from "./render-pptx.js";
import { PptxValidationError, parseOfficeXml, assertOfficeSemantics, decodeOfficeXml, unzipOfficeArchive, validateEmbeddedWorkbooks } from "./office-xml.js";
export { PptxValidationError } from "./office-xml.js";

const EMU_PER_INCH = 914_400;
const BOUNDS_TOLERANCE_EMU = 0.02 * EMU_PER_INCH;

function fail(message: string, cause?: unknown): never {
  throw new PptxValidationError(message, undefined, cause === undefined ? undefined : { cause });
}

function assertEntities(value: string, fileName: string): void {
  if (/&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[\da-f]+);)/iu.test(value)) {
    fail(`Invalid XML entity in ${fileName}`);
  }
}

function findTagEnd(xml: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index]!;
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function assertWellFormedXml(xml: string, fileName: string): void {
  const stack: string[] = [];
  let offset = 0;
  let rootCount = 0;
  while (offset < xml.length) {
    const start = xml.indexOf("<", offset);
    const textEnd = start < 0 ? xml.length : start;
    const text = xml.slice(offset, textEnd);
    assertEntities(text, fileName);
    if (stack.length === 0 && text.trim().length > 0) {
      fail(`Non-whitespace text outside the XML root in ${fileName}`);
    }
    if (start < 0) break;

    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0) fail(`Unclosed XML comment in ${fileName}`);
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      if (stack.length === 0) fail(`CDATA section outside the XML root in ${fileName}`);
      const end = xml.indexOf("]]>", start + 9);
      if (end < 0) fail(`Unclosed CDATA section in ${fileName}`);
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end < 0) fail(`Unclosed processing instruction in ${fileName}`);
      offset = end + 2;
      continue;
    }
    if (xml.startsWith("<!", start)) fail(`Unsupported XML declaration in ${fileName}`);

    const end = findTagEnd(xml, start);
    if (end < 0) fail(`Unclosed XML tag in ${fileName}`);
    const token = xml.slice(start, end + 1);
    const closing = /^<\/([A-Za-z_][\w:.-]*)\s*>$/u.exec(token);
    if (closing) {
      const name = closing[1]!;
      if (stack.pop() !== name) fail(`Mismatched XML closing tag ${name} in ${fileName}`);
      offset = end + 1;
      continue;
    }

    const opening = /^<([A-Za-z_][\w:.-]*)([\s\S]*?)>$/u.exec(token);
    if (!opening) fail(`Malformed XML tag in ${fileName}`);
    const name = opening[1]!;
    if (stack.length === 0) {
      rootCount += 1;
      if (rootCount > 1) fail(`Multiple XML root elements in ${fileName}`);
    }
    let attributes = opening[2]!;
    const selfClosing = /\/\s*$/u.test(attributes);
    if (selfClosing) attributes = attributes.replace(/\/\s*$/u, "");
    let cursor = 0;
    const attributeNames = new Set<string>();
    while (cursor < attributes.length) {
      while (/\s/u.test(attributes[cursor] ?? "")) cursor += 1;
      if (cursor >= attributes.length) break;
      const attribute = /^[A-Za-z_][\w:.-]*/u.exec(attributes.slice(cursor));
      if (!attribute) fail(`Malformed XML attribute in ${fileName}`);
      if (attributeNames.has(attribute[0])) fail(`Duplicate XML attribute ${attribute[0]} in ${fileName}`);
      attributeNames.add(attribute[0]);
      cursor += attribute[0].length;
      while (/\s/u.test(attributes[cursor] ?? "")) cursor += 1;
      if (attributes[cursor] !== "=") fail(`XML attribute missing value in ${fileName}`);
      cursor += 1;
      while (/\s/u.test(attributes[cursor] ?? "")) cursor += 1;
      const quote = attributes[cursor];
      if (quote !== "\"" && quote !== "'") fail(`Unquoted XML attribute in ${fileName}`);
      const valueStart = ++cursor;
      const valueEnd = attributes.indexOf(quote, valueStart);
      if (valueEnd < 0) fail(`Unclosed XML attribute in ${fileName}`);
      assertEntities(attributes.slice(valueStart, valueEnd), fileName);
      cursor = valueEnd + 1;
    }
    if (!selfClosing) stack.push(name);
    offset = end + 1;
  }
  if (stack.length) fail(`Unclosed XML element ${stack.at(-1)} in ${fileName}`);
  if (rootCount !== 1) fail(`Expected exactly one XML root element in ${fileName}`);
}

function attributesFromTag(xml: string, tagName: string): Array<Record<string, string>> {
  const expression = new RegExp(`<${tagName}\\b([^>]*)/?>`, "gu");
  const result: Array<Record<string, string>> = [];
  for (const match of xml.matchAll(expression)) {
    const attributes: Record<string, string> = {};
    const expressionAttrs = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/gu;
    for (const attribute of match[1]!.matchAll(expressionAttrs)) attributes[attribute[1]!] = attribute[3]!;
    result.push(attributes);
  }
  return result;
}

function decodeXmlAttribute(value: string, fileName: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|apos|quot);/giu, (_entity, token: string) => {
    if (token === "amp") return "&";
    if (token === "lt") return "<";
    if (token === "gt") return ">";
    if (token === "apos") return "'";
    if (token === "quot") return '"';
    const codePoint = token[1]!.toLowerCase() === "x"
      ? Number.parseInt(token.slice(2), 16)
      : Number.parseInt(token.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      fail(`Invalid XML character reference in ${fileName}`);
    }
    return String.fromCodePoint(codePoint);
  });
}

function resolveOverridePartName(rawPartName: string): string {
  const decoded = decodeXmlAttribute(rawPartName, "[Content_Types].xml");
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\") || decoded.includes("\0")
      || decoded.includes("?") || decoded.includes("#")) {
    fail(`Invalid Content Types Override PartName: ${rawPartName}`);
  }
  const rawSegments = decoded.slice(1).split("/");
  if (rawSegments.length === 0 || rawSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`Invalid Content Types Override PartName: ${rawPartName}`);
  }
  let segments: string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch (error) {
    return fail(`Invalid escaped Content Types Override PartName: ${rawPartName}`, error);
  }
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("/")
      || segment.includes("\\") || segment.includes("\0") || segment.includes("?") || segment.includes("#"))) {
    fail(`Invalid Content Types Override PartName: ${rawPartName}`);
  }
  const partName = segments.join("/");
  if (path.normalize(partName) !== partName || partName.startsWith("../") || partName === "..") {
    fail(`Content Types Override escapes the package root: ${rawPartName}`);
  }
  return partName;
}

function assertContentTypeOverrides(contentTypesXml: string, entries: Map<string, Uint8Array>): number {
  const parts = new Set<string>();
  let count = 0;
  for (const attributes of attributesFromTag(contentTypesXml, "Override")) {
    const rawPartName = attributes.PartName;
    const contentType = attributes.ContentType
      ? decodeXmlAttribute(attributes.ContentType, "[Content_Types].xml")
      : "";
    if (!rawPartName || !contentType) {
      fail("Malformed Content Types Override: PartName and ContentType are required");
    }
    const partName = resolveOverridePartName(rawPartName);
    if (parts.has(partName)) fail(`Duplicate Content Types Override for ${partName}`);
    parts.add(partName);
    count += 1;
    if (!entries.has(partName)) fail(`Content Types Override points to a missing package part: ${partName}`);
  }
  return count;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  targetPart?: string;
  external: boolean;
}

function sourcePartForRelationshipPath(relationshipPath: string): string {
  if (relationshipPath === "_rels/.rels") return "";
  return relationshipPath.replace(/\/_rels\//u, "/").replace(/\.rels$/u, "");
}

function resolveTargetPart(relationshipPath: string, target: string): string {
  let resolved = target.startsWith("/")
    ? path.normalize(target.slice(1))
    : path.normalize(path.join(path.dirname(sourcePartForRelationshipPath(relationshipPath)), target));
  if (resolved === ".") resolved = "";
  if (resolved.startsWith("../") || resolved === ".." || resolved.startsWith("/")) {
    fail(`Relationship escapes the package root: ${relationshipPath}`);
  }
  return resolved;
}

function readRelationships(xml: string, relationshipPath: string): Relationship[] {
  return attributesFromTag(xml, "Relationship").map((attributes) => {
    if (!attributes.Id || !attributes.Target || !attributes.Type) fail(`Malformed relationship in ${relationshipPath}`);
    const external = attributes.TargetMode === "External";
    return {
      id: attributes.Id,
      type: attributes.Type,
      target: attributes.Target,
      external,
      ...(external ? {} : { targetPart: resolveTargetPart(relationshipPath, attributes.Target) }),
    };
  });
}

function contentTypeForPart(contentTypesXml: string, partName: string): string | undefined {
  const override = attributesFromTag(contentTypesXml, "Override")
    .find((attributes) => attributes.PartName === `/${partName}`)?.ContentType;
  if (override) return override;
  const extension = path.extname(partName).slice(1).toLowerCase();
  return attributesFromTag(contentTypesXml, "Default")
    .find((attributes) => attributes.Extension?.toLowerCase() === extension)?.ContentType;
}

function assertValidImagePart(partName: string, contentType: string | undefined, bytes: Uint8Array | undefined): void {
  if (!bytes || bytes.byteLength === 0) fail(`Embedded image data is empty or missing: ${partName}`);
  const extension = path.extname(partName).toLowerCase();
  const isPng = extension === ".png"
    && contentType === "image/png"
    && bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isJpeg = (extension === ".jpg" || extension === ".jpeg")
    && contentType === "image/jpeg"
    && bytes.length >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) {
    fail(`Embedded image content does not match its PNG/JPEG extension and MIME type: ${partName} (${contentType ?? "missing content type"})`);
  }
}

function tagCount(xml: string, qualifiedName: string): number {
  return [...xml.matchAll(new RegExp(`<${qualifiedName}\\b`, "gu"))].length;
}

function fragments(xml: string, qualifiedName: string): string[] {
  const expression = new RegExp(`<${qualifiedName}\\b[^>]*>[\\s\\S]*?<\\/${qualifiedName}>`, "gu");
  return [...xml.matchAll(expression)].map((match) => match[0]);
}

function transformBounds(fragment: string): { x: number; y: number; cx: number; cy: number } | undefined {
  const transform = /<(?:a|p):xfrm\b[^>]*>([\s\S]*?)<\/(?:a|p):xfrm>/u.exec(fragment)?.[1];
  if (!transform) return undefined;
  const off = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/u.exec(transform);
  const ext = /<a:ext\b[^>]*\bcx="(-?\d+)"[^>]*\bcy="(-?\d+)"/u.exec(transform);
  if (!off || !ext) return undefined;
  return { x: Number(off[1]), y: Number(off[2]), cx: Number(ext[1]), cy: Number(ext[2]) };
}

function bytesAsXml(bytes: Uint8Array, name: string): string {
  return decodeOfficeXml(bytes, name);
}

function assertReferencesExist(slideXml: string, relationships: Relationship[], slidePart: string): void {
  const relationshipsById = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  const referenced = [...slideXml.matchAll(/\br:(?:id|embed|link)="([^"]+)"/gu)].map((match) => match[1]!);
  if (referenced.some((id) => !relationshipsById.has(id))) fail(`Slide has a dangling relationship reference: ${slidePart}`);
  for (const picture of fragments(slideXml, "p:pic")) {
    const embeddedId = /<a:blip\b[^>]*\br:embed="([^"]+)"/u.exec(picture)?.[1];
    const relationship = embeddedId ? relationshipsById.get(embeddedId) : undefined;
    if (!relationship || relationship.external || !relationship.type.endsWith("/image")
        || !relationship.targetPart?.startsWith("ppt/media/")) {
      fail(`Picture object has no valid embedded media relationship: ${slidePart}`);
    }
  }
  for (const chart of fragments(slideXml, "c:chart")) {
    const chartId = /\br:id="([^"]+)"/u.exec(chart)?.[1];
    const relationship = chartId ? relationshipsById.get(chartId) : undefined;
    if (!relationship || relationship.external || !relationship.type.endsWith("/chart")
        || !relationship.targetPart?.startsWith("ppt/charts/")) {
      fail(`Chart object has no valid embedded chart relationship: ${slidePart}`);
    }
  }
}

export async function validatePptx(bytes: Uint8Array): Promise<PptxInspection> {
  const archive = unzipOfficeArchive(bytes);
  const entries = new Map(Object.entries(archive).filter(([name]) => !name.endsWith("/")));
  const requiredParts = ["[Content_Types].xml", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "_rels/.rels"];
  for (const part of requiredParts) if (!entries.has(part)) fail(`PPTX is missing required part ${part}`);

  const xmlParts = [...entries].filter(([name]) => name.endsWith(".xml") || name.endsWith(".rels"));
  const xml = new Map<string, string>();
  for (const [name, content] of xmlParts) {
    const value = bytesAsXml(content, name);
    assertOfficeSemantics(parseOfficeXml(value, name), name);
    assertWellFormedXml(value, name);
    xml.set(name, value);
  }
  validateEmbeddedWorkbooks(archive);

  const contentTypesXml = xml.get("[Content_Types].xml");
  if (!contentTypesXml) fail("PPTX has no readable [Content_Types].xml part");
  const contentTypeOverrideCount = assertContentTypeOverrides(contentTypesXml, entries);

  const rels = new Map<string, Relationship[]>();
  for (const [name, content] of entries) {
    if (!name.endsWith(".rels")) continue;
    const relationships = readRelationships(xml.get(name)!, name);
    rels.set(name, relationships);
    for (const relationship of relationships) {
      if (!relationship.external && !entries.has(relationship.targetPart!)) {
        fail(`Relationship target is missing: ${relationship.targetPart}`);
      }
    }
  }

  for (const relationships of rels.values()) {
    for (const relationship of relationships) {
      if (!relationship.type.endsWith("/image")) continue;
      if (relationship.external || !relationship.targetPart?.startsWith("ppt/media/")) {
        fail("Image relationship must point to an embedded media part");
      }
      assertValidImagePart(
        relationship.targetPart,
        contentTypeForPart(contentTypesXml, relationship.targetPart),
        entries.get(relationship.targetPart),
      );
    }
  }

  const rootRelationships = rels.get("_rels/.rels") ?? [];
  if (!rootRelationships.some((relationship) => relationship.targetPart === "ppt/presentation.xml")) {
    fail("PPTX root relationship does not point to the presentation part");
  }

  const presentationXml = xml.get("ppt/presentation.xml")!;
  const slideRefs = attributesFromTag(presentationXml, "p:sldId");
  const presentationRels = rels.get("ppt/_rels/presentation.xml.rels") ?? [];
  const slideRelationships = presentationRels.filter((relationship) => relationship.type.endsWith("/slide"));
  const slideParts = [...entries.keys()].filter((name) => /^ppt\/slides\/[^/]+\.xml$/u.test(name));
  const referencedSlideIds = new Set(slideRefs.map((slide) => slide["r:id"]));
  const slideRelationshipIds = new Set(slideRelationships.map((relationship) => relationship.id));
  const slideRelationshipTargets = new Set(slideRelationships.map((relationship) => relationship.targetPart));
  if (slideRefs.length === 0 || slideRefs.length !== slideRelationships.length || slideRefs.length !== slideParts.length
      || referencedSlideIds.size !== slideRefs.length
      || slideRelationshipIds.size !== slideRelationships.length
      || slideRelationshipTargets.size !== slideRelationships.length
      || slideParts.some((slidePart) => !slideRelationshipTargets.has(slidePart))
      || slideRelationships.some((relationship) => !referencedSlideIds.has(relationship.id))) {
    fail("PPTX slide list and slide relationships do not match");
  }
  const slideSize = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/u.exec(presentationXml);
  if (!slideSize) fail("PPTX presentation has no valid slide dimensions");
  const canvasCx = Number(slideSize[1]);
  const canvasCy = Number(slideSize[2]);

  let shapeCount = 0;
  let textShapeCount = 0;
  let pictureCount = 0;
  let graphicFrameCount = 0;
  let tableCount = 0;
  let chartCount = 0;
  let fullSlidePictureCount = 0;
  let slideBoundsValid = true;

  for (const slidePart of slideParts) {
    const slideXml = xml.get(slidePart);
    if (!slideXml) fail(`PPTX slide XML part is missing: ${slidePart}`);
    const relationshipPath = path.join(path.dirname(slidePart), "_rels", `${path.basename(slidePart)}.rels`);
    const relationships = rels.get(relationshipPath);
    if (!relationships) fail(`PPTX slide relationship part is missing: ${relationshipPath}`);
    if (!relationships.some((relationship) => relationship.type.endsWith("/slideLayout")
        && relationship.targetPart?.startsWith("ppt/slideLayouts/"))) {
      fail(`PPTX slide has no valid slide-layout relationship: ${slidePart}`);
    }
    assertReferencesExist(slideXml, relationships, slidePart);

    const shapeFragments = fragments(slideXml, "p:sp");
    const pictureFragments = fragments(slideXml, "p:pic");
    const graphicFrames = fragments(slideXml, "p:graphicFrame");
    shapeCount += shapeFragments.length;
    textShapeCount += shapeFragments.filter((fragment) => /<a:t\b/u.test(fragment)).length;
    pictureCount += pictureFragments.length;
    graphicFrameCount += graphicFrames.length;
    tableCount += graphicFrames.reduce((count, fragment) => count + tagCount(fragment, "a:tbl"), 0);
    chartCount += graphicFrames.reduce((count, fragment) => count + tagCount(fragment, "c:chart"), 0);

    for (const fragment of [...shapeFragments, ...pictureFragments, ...graphicFrames]) {
      const bounds = transformBounds(fragment);
      if (!bounds || bounds.x < -BOUNDS_TOLERANCE_EMU || bounds.y < -BOUNDS_TOLERANCE_EMU
          || bounds.cx < 0 || bounds.cy < 0
          || bounds.x + bounds.cx > canvasCx + BOUNDS_TOLERANCE_EMU
          || bounds.y + bounds.cy > canvasCy + BOUNDS_TOLERANCE_EMU) {
        if (!bounds) fail(`PPTX object has no parseable transform in ${slidePart}: ${fragment.slice(0, 180)}`);
        fail(`PPTX object is outside slide bounds in ${slidePart}: ${JSON.stringify(bounds)} / ${canvasCx}x${canvasCy}`);
        slideBoundsValid = false;
      }
      if (fragment.startsWith("<p:pic") && bounds
          && Math.abs(bounds.x) <= BOUNDS_TOLERANCE_EMU
          && Math.abs(bounds.y) <= BOUNDS_TOLERANCE_EMU
          && Math.abs(bounds.cx - canvasCx) <= BOUNDS_TOLERANCE_EMU
          && Math.abs(bounds.cy - canvasCy) <= BOUNDS_TOLERANCE_EMU) {
        fullSlidePictureCount += 1;
      }
    }
    const imageTargets = relationships.filter((relationship) => relationship.type.endsWith("/image"));
    if (imageTargets.some((relationship) => !relationship.targetPart || !entries.has(relationship.targetPart))) {
      fail(`PPTX slide references missing embedded image data: ${slidePart}`);
    }
  }

  const embeddedMediaCount = [...entries.keys()].filter((name) => /^ppt\/media\/[^/]+$/u.test(name)).length;
  const chartParts = [...entries.keys()].filter((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name)).length;
  if (!slideBoundsValid) fail("PPTX contains an object outside the declared slide bounds");
  if (fullSlidePictureCount > 0) fail("PPTX contains a full-slide picture in place of editable objects");
  if (pictureCount > 0 && embeddedMediaCount === 0) {
    fail("PPTX is missing embedded media for one or more picture objects");
  }
  if (chartCount > 0 && chartParts === 0) fail("PPTX chart frames have no embedded chart parts");

  return {
    slideCount: slideRefs.length,
    textShapeCount,
    pictureCount,
    tableCount,
    chartCount,
    fullSlidePictureCount,
    slideBoundsValid,
    shapeCount,
    graphicFrameCount,
    embeddedMediaCount,
    contentTypeOverrideCount,
    contentTypeOverridesValid: true,
    relationshipsValid: true,
  };
}
