import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { unzipSync } from "fflate";
import { posix as path } from "node:path";

export const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const OFFICE_RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

export class PptxValidationError extends Error {
  readonly code = "PPTX_INVALID" as const;
  constructor(message: string, readonly partName?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PptxValidationError";
  }
}

function invalid(message: string, part: string): never {
  throw new PptxValidationError(`${message} in ${part}`, part);
}

function legalXmlCharacter(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

export function assertOfficeText(text: string, part: string): void {
  for (const character of text) {
    if (!legalXmlCharacter(character.codePointAt(0)!)) invalid("Illegal XML character", part);
  }
}

/** No DTDs, external entities, parser recovery, or prefix-dependent checks. */
export function parseOfficeXml(xml: string, part: string): Document {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) invalid("DTD/DOCTYPE declarations are forbidden", part);
  assertOfficeText(xml, part);
  for (const reference of xml.matchAll(/&#(x[\da-f]+|\d+);/giu)) {
    const token = reference[1]!;
    const code = token[0]!.toLowerCase() === "x" ? Number.parseInt(token.slice(1), 16) : Number(token);
    if (!legalXmlCharacter(code)) invalid("Illegal XML character reference", part);
  }
  let document: Document;
  try {
    document = new DOMParser({ onError: (_level, message) => invalid(`Malformed XML: ${message}`, part) })
      .parseFromString(xml, "application/xml");
  } catch (cause) {
    if (cause instanceof PptxValidationError) throw cause;
    throw new PptxValidationError(`Malformed XML in ${part}: ${cause instanceof Error ? cause.message : "parse failed"}`, part, { cause });
  }
  // xmldom's DOM replaces attributes with the same expanded name. Compare
  // original start-tag attributes against the resolved DOM namespaces first.
  const elements = Array.from(document.getElementsByTagName("*"));
  const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/[^>]*>|<([A-Za-z_][\w:.-]*)((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gu;
  let elementIndex = 0;
  for (const token of xml.matchAll(markup)) {
    if (!token[1]) continue;
    const element = elements[elementIndex++];
    if (!element) invalid("Malformed XML element sequence", part);
    const names = new Set<string>();
    for (const attribute of token[2]!.matchAll(/([^\s=]+)\s*=\s*(["'])([\s\S]*?)\2/gu)) {
      const qualified = attribute[1]!; const pieces = qualified.split(":");
      const namespace = qualified === "xmlns" || pieces[0] === "xmlns"
        ? "http://www.w3.org/2000/xmlns/" : pieces.length === 2 ? element.lookupNamespaceURI(pieces[0]!) ?? "" : "";
      const key = `${namespace}|${pieces.at(-1)}`;
      if (names.has(key)) invalid(`Duplicate XML attribute ${key}`, part);
      names.add(key);
    }
  }
  for (const element of Array.from(document.getElementsByTagName("*"))) {
    if (element.prefix && !element.namespaceURI) invalid(`Unbound XML prefix ${element.prefix}`, part);
    const expandedAttributes = new Set<string>();
    for (const attribute of Array.from(element.attributes)) {
      const expandedName = `${attribute.namespaceURI ?? ""}|${attribute.localName}`;
      if (expandedAttributes.has(expandedName)) invalid(`Duplicate XML attribute ${expandedName}`, part);
      expandedAttributes.add(expandedName);
      if (attribute.prefix && !attribute.namespaceURI) invalid(`Unbound XML attribute prefix ${attribute.prefix}`, part);
    }
  }
  return document;
}

function enumAttribute(element: Element, name: string, allowed: string[], part: string): void {
  if (element.hasAttribute(name) && !allowed.includes(element.getAttribute(name)!)) {
    invalid(`Invalid ${element.localName}@${name}="${element.getAttribute(name)}"`, part);
  }
}

function assertRange(value: string, part: string): void {
  const match = /^([A-Z]{1,3})([1-9]\d*)(?::([A-Z]{1,3})([1-9]\d*))?$/u.exec(value);
  const column = (letters: string) => [...letters].reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0);
  if (!match) invalid(`Invalid spreadsheet range (ST_Ref): ${value}`, part);
  const firstColumn = column(match[1]!); const firstRow = Number(match[2]);
  const lastColumn = column(match[3] ?? match[1]!); const lastRow = Number(match[4] ?? match[2]);
  if (firstColumn > lastColumn || firstRow > lastRow || lastColumn > 16384 || lastRow > 1048576) {
    invalid(`Invalid spreadsheet range (ST_Ref): ${value}`, part);
  }
}

export function assertOfficeSemantics(document: Document, part: string): void {
  for (const cell of Array.from(document.getElementsByTagNameNS(DRAWING_NS, "tcPr"))) {
    enumAttribute(cell, "anchor", ["t", "ctr", "b", "just", "dist"], part);
    enumAttribute(cell, "horzOverflow", ["overflow", "clip"], part);
  }
  for (const body of Array.from(document.getElementsByTagNameNS(DRAWING_NS, "bodyPr"))) {
    enumAttribute(body, "anchor", ["t", "ctr", "b", "just", "dist"], part);
    enumAttribute(body, "wrap", ["none", "square"], part);
    enumAttribute(body, "horzOverflow", ["overflow", "clip"], part);
    enumAttribute(body, "vertOverflow", ["overflow", "ellipsis", "clip"], part);
  }
  const ids = new Set<string>();
  for (const drawing of Array.from(document.getElementsByTagNameNS(PRESENTATION_NS, "cNvPr"))) {
    const id = drawing.getAttribute("id") ?? "";
    if (!/^\d+$/u.test(id) || Number(id) > 4294967295) invalid(`Invalid drawing ID ${id}`, part);
    const normalized = String(Number(id));
    if (ids.has(normalized)) invalid(`Duplicate drawing ID ${id}`, part);
    ids.add(normalized);
  }
  for (const name of ["stCxn", "endCxn"]) {
    for (const connection of Array.from(document.getElementsByTagNameNS(DRAWING_NS, name))) {
      if (!ids.has(String(Number(connection.getAttribute("id"))))) invalid("Dangling drawing connection ID", part);
    }
  }
  for (const name of ["table", "autoFilter", "dimension", "c"]) {
    for (const element of Array.from(document.getElementsByTagNameNS(SHEET_NS, name))) {
      const attr = name === "c" ? "r" : "ref";
      if (element.hasAttribute(attr)) assertRange(element.getAttribute(attr)!, part);
    }
  }
}

/** Limits are enforced from ZIP metadata before decompression. */
export function unzipOfficeArchive(bytes: Uint8Array, part = "PPTX", maxBytes = 256 * 1024 * 1024): Record<string, Uint8Array> {
  let total = 0; const names = new Set<string>();
  const sizes = new Map<string, number>();
  try {
    const archive = unzipSync(bytes, { filter: (file) => {
      if (names.has(file.name)) invalid("Duplicate ZIP entry", `${part}/${file.name}`);
      names.add(file.name);
      sizes.set(file.name, file.originalSize);
      if (file.compression === 0 && file.size !== file.originalSize) invalid("Inconsistent stored ZIP entry size", `${part}/${file.name}`);
      if (names.size > 4096 || (total += file.originalSize) > maxBytes) invalid("Office ZIP expansion limit exceeded", part);
      const segments = file.name.replace(/\/$/u, "").split("/");
      if (segments.some((s) => !s || s === "." || s === "..") || file.name.includes("\\")) invalid("Invalid ZIP part path", part);
      return !file.name.endsWith("/");
    } });
    let actualTotal = 0;
    for (const [name, data] of Object.entries(archive)) {
      if (data.byteLength !== sizes.get(name)) invalid("Inconsistent expanded ZIP entry size", `${part}/${name}`);
      if ((actualTotal += data.byteLength) > maxBytes) invalid("Office ZIP expansion limit exceeded", part);
    }
    return archive;
  } catch (cause) {
    if (cause instanceof PptxValidationError) throw cause;
    throw new PptxValidationError(`Office package is not a readable ZIP archive: ${part}`, part, { cause });
  }
}

export function decodeOfficeXml(bytes: Uint8Array, part: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { throw new PptxValidationError(`Non-UTF-8 XML part ${part}`, part, { cause }); }
}

export function validateEmbeddedWorkbooks(archive: Record<string, Uint8Array>): void {
  let count = 0; let total = 0;
  for (const [part, bytes] of Object.entries(archive)) {
    if (!part.endsWith(".xlsx")) continue;
    if (++count > 60) invalid("Too many embedded workbooks", part);
    const workbook = unzipOfficeArchive(bytes, part, 32 * 1024 * 1024);
    for (const content of Object.values(workbook)) total += content.byteLength;
    if (total > 64 * 1024 * 1024) invalid("Embedded workbooks expansion limit exceeded", part);
    for (const required of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"]) {
      if (!workbook[required]) invalid(`Missing embedded workbook part ${required}`, part);
    }
    validateOfficePackageGraph(workbook, part);
  }
}

/** Check package relationships by namespace, including every r:id/embed/link reference. */
export function validateOfficePackageGraph(archive: Record<string, Uint8Array>, packageName = ""): void {
  const label = (name: string) => packageName ? `${packageName}!/${name}` : name;
  const documents = new Map<string, Document>();
  const relationships = new Map<string, Map<string, { external: boolean; target: string }>>();
  const decodePartUri = (uri: string, part: string): string => {
    try {
      const value = decodeURIComponent(uri);
      if (/[\\\0?#]/u.test(value) || value.startsWith("//")) invalid("Invalid package part URI", part);
      return value;
    } catch (cause) {
      if (cause instanceof PptxValidationError) throw cause;
      return invalid("Invalid escaped package part URI", part);
    }
  };
  for (const [name, content] of Object.entries(archive)) {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    const fullPart = label(name);
    const document = parseOfficeXml(decodeOfficeXml(content, fullPart), fullPart);
    assertOfficeSemantics(document, fullPart);
    documents.set(name, document);
    const overridden = new Set<string>();
    for (const override of Array.from(document.getElementsByTagNameNS(TYPES_NS, "Override"))) {
      const raw = override.getAttribute("PartName") ?? "";
      const target = decodePartUri(raw, fullPart);
      if (!target.startsWith("/") || target.split("/").slice(1).some(s => !s || s === "." || s === "..") || !override.getAttribute("ContentType")) invalid("Invalid Content Types Override", fullPart);
      const entry = target.slice(1);
      if (overridden.has(entry)) invalid(`Duplicate Content Types Override for ${entry}`, fullPart);
      overridden.add(entry);
      if (!archive[entry]) invalid(`Content Types Override points to a missing package part: ${entry}`, fullPart);
    }
    if (!name.endsWith(".rels")) continue;
    const source = name === "_rels/.rels" ? "" : name.replace(/\/_rels\//u, "/").replace(/\.rels$/u, "");
    if (source && !archive[source]) invalid("Relationship source part is missing", fullPart);
    const byId = new Map<string, { external: boolean; target: string }>();
    relationships.set(source, byId);
    for (const relationship of Array.from(document.getElementsByTagNameNS(RELS_NS, "Relationship"))) {
      const id = relationship.getAttribute("Id"); const rawTarget = relationship.getAttribute("Target");
      if (!id || byId.has(id) || !rawTarget || !relationship.getAttribute("Type")) invalid("Malformed or duplicate relationship", fullPart);
      enumAttribute(relationship, "TargetMode", ["Internal", "External"], fullPart);
      const external = relationship.getAttribute("TargetMode") === "External";
      if (external) { byId.set(id, { external, target: rawTarget }); continue; }
      const target = decodePartUri(rawTarget, fullPart);
      const resolved = target.startsWith("/") ? path.normalize(target.slice(1)) : path.normalize(path.join(path.dirname(source), target));
      if (resolved.startsWith("../") || resolved === ".." || !archive[resolved]) invalid(`Relationship target is missing: ${resolved}`, fullPart);
      byId.set(id, { external, target: resolved });
    }
  }
  for (const [name, document] of documents) {
    if (name.endsWith(".rels")) continue;
    const byId = relationships.get(name);
    for (const element of Array.from(document.getElementsByTagName("*"))) {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.namespaceURI !== OFFICE_RELS_NS || !["id", "embed", "link"].includes(attribute.localName!)) continue;
        const relationship = byId?.get(attribute.value);
        if (!relationship) invalid(`Dangling relationship reference ${attribute.value}`, label(name));
        if (attribute.localName === "embed" && relationship.external) invalid("Embedded object references an external relationship", label(name));
      }
    }
  }
}
