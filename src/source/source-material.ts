import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { PageSelector, SourceFileReference, SourceMaterialInput, SourceFailure, MarkdownDraftOptions } from "./source-contracts.js";
import { SourceMaterialInputSchema } from "./source-contracts.js";
import { extractPdfText as extractPdfTextDefault, PdfTextError, MAX_PDF_BYTES } from "./pdf-text.js";

export const MAX_SOURCE_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_CONTEXT_BYTES = 2 * 1024 * 1024;
export const SOURCE_FETCH_TIMEOUT_MS = 15_000;
const PREPARED_CONTEXT_TTL_MS = 30 * 60 * 1_000;
const MAX_PREPARED_CONTEXTS = 256;

export interface SourceHttpResponse {
  status: number;
  finalUrl: string;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}

export type SourceFetcher = (url: URL, addresses: string[], signal: AbortSignal, maxBytes: number) => Promise<SourceHttpResponse>;

export interface SourceMaterialDependencies {
  resolveHostname?: (hostname: string) => Promise<string[]>;
  fetchSource?: SourceFetcher;
  readAttachment?: (file: SourceFileReference) => Promise<Uint8Array>;
  extractPdfText?: (bytes: Uint8Array, pageRange: PageSelector | undefined) => Promise<string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxContextBytes?: number;
}

export interface PreparedSource {
  id: string;
  kind: "url" | "pdf";
  title: string;
  locator: string;
  pageRange?: PageSelector;
  content: string;
  characterCount: number;
}

export interface PreparedSourceMaterial {
  status: "ready" | "partial" | "failed";
  jobId: string;
  options: MarkdownDraftOptions;
  sourceDigest: string | null;
  sources: PreparedSource[];
  failures: SourceFailure[];
  warnings: string[];
}

export interface PreparedSourceContext {
  sourceIds: ReadonlySet<string>;
  options: MarkdownDraftOptions;
  expiresAt: number;
}

const preparedContexts = new Map<string, PreparedSourceContext>();

export function createPinnedLookup(address: string): LookupFunction {
  const family = isIP(address) === 6 ? 6 : 4;
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options !== null && "all" in options && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

/** Keep only the opaque binding needed by the draft publisher, never source text. */
export function rememberPreparedSourceMaterial(output: PreparedSourceMaterial): void {
  if (output.sources.length === 0) return;
  while (preparedContexts.size >= MAX_PREPARED_CONTEXTS) {
    const oldest = preparedContexts.keys().next().value;
    if (typeof oldest !== "string") break;
    preparedContexts.delete(oldest);
  }
  preparedContexts.set(output.jobId, {
    sourceIds: new Set(output.sources.map((source) => source.id)),
    options: output.options,
    expiresAt: Date.now() + PREPARED_CONTEXT_TTL_MS,
  });
}

export function getPreparedSourceContext(jobId: string): PreparedSourceContext | undefined {
  const context = preparedContexts.get(jobId);
  if (!context) return undefined;
  if (context.expiresAt <= Date.now()) {
    preparedContexts.delete(jobId);
    return undefined;
  }
  return context;
}

function header(response: SourceHttpResponse, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()] ?? response.headers[name];
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function parseIPv6(address: string): bigint | undefined {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function inIPv6Range(value: bigint, base: string, prefix: number): boolean {
  const parsed = parseIPv6(base);
  if (parsed === undefined) return true;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (value & mask) === (parsed & mask);
}

function isPrivateIPv6(address: string): boolean {
  const value = parseIPv6(address);
  if (value === undefined || (value >> 125n) !== 1n) return true;
  const specialRanges: Array<[string, number]> = [
    ["::", 128], ["::1", 128], ["::ffff:0:0", 96],
    ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
    ["2001:0::", 32], ["2001::", 23], ["2001:1::", 48], ["2001:2::", 48],
    ["2001:3::", 32], ["2001:4:112::", 48], ["2001:10::", 28],
    ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16], ["3ffe::", 16], ["3fff::", 20],
  ];
  return specialRanges.some(([base, prefix]) => inIPv6Range(value, base, prefix));
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  return version === 4 ? isPrivateIPv4(address) : version === 6 ? isPrivateIPv6(address) : true;
}

async function publicAddresses(url: URL, resolveHostname: (hostname: string) => Promise<string[]>, timeoutMs: number): Promise<string[]> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const literal = isIP(hostname);
  let timeoutHandle: NodeJS.Timeout | undefined;
  const resolution = literal
    ? Promise.resolve([hostname])
    : resolveHostname(hostname);
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new SourceMaterialError("SOURCE_FETCH_TIMEOUT", "fetch", "The source host lookup exceeded its time limit.", true)), timeoutMs);
  });
  let addresses: string[];
  try {
    addresses = await Promise.race([resolution, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new SourceMaterialError("PRIVATE_ADDRESS_BLOCKED", "fetch", "The source host resolves to a private or non-public network address.", false);
  }
  return addresses;
}

async function fetchHttpsSource(url: URL, addresses: string[], signal: AbortSignal, maxBytes: number): Promise<SourceHttpResponse> {
  const address = addresses[0];
  if (!address) throw new SourceMaterialError("SOURCE_FETCH_FAILED", "fetch", "The source host has no usable public address.", true);
  return await new Promise<SourceHttpResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finish = (response: SourceHttpResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const request = httpsRequest({
      protocol: "https:",
      hostname: url.hostname.replace(/^\[|\]$/gu, ""),
      port: url.port || undefined,
      path: `${url.pathname || "/"}${url.search}`,
      servername: url.hostname,
      lookup: createPinnedLookup(address),
      headers: { accept: "text/html, text/plain, text/markdown, application/pdf" },
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > maxBytes) {
          request.destroy();
          fail(new SourceMaterialError("SOURCE_LIMIT_EXCEEDED", "fetch", "The source response exceeds the 8 MiB limit.", false));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", (error) => fail(new SourceMaterialError("SOURCE_FETCH_FAILED", "fetch", "The source response failed while reading.", true, error)));
      response.once("end", () => finish({
        status: response.statusCode ?? 0,
        finalUrl: url.href,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : value])),
        body: Buffer.concat(chunks, total),
      }));
    });
    request.once("error", (error) => fail(new SourceMaterialError("SOURCE_FETCH_FAILED", "fetch", "The source request failed.", true, error)));
    request.setTimeout(SOURCE_FETCH_TIMEOUT_MS, () => {
      request.destroy();
      fail(new SourceMaterialError("SOURCE_FETCH_TIMEOUT", "fetch", "The source request exceeded its time limit.", true));
    });
    const abort = () => {
      request.destroy();
      fail(new SourceMaterialError("SOURCE_FETCH_TIMEOUT", "fetch", "The source request was cancelled after its time limit.", true));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request.once("close", () => signal.removeEventListener("abort", abort));
    request.end();
  });
}

export class SourceMaterialError extends Error {
  readonly code: string;
  readonly stage: SourceFailure["stage"];
  readonly retryable: boolean;

  constructor(code: string, stage: SourceFailure["stage"], message: string, retryable: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SourceMaterialError";
    this.code = code;
    this.stage = stage;
    this.retryable = retryable;
  }
}

function failure(sourceId: string, error: unknown): SourceFailure {
  const safeMessage = (message: string, fallback: string): string => {
    const normalized = message.replace(/\s+/gu, " ").trim();
    return (normalized || fallback).slice(0, 500);
  };
  if (error instanceof SourceMaterialError) {
    return { code: error.code, stage: error.stage, sourceId, message: safeMessage(error.message, "The source could not be prepared."), retryable: error.retryable };
  }
  if (error instanceof PdfTextError) {
    return { code: error.code, stage: "extract", sourceId, message: safeMessage(error.message, "The PDF text extractor failed."), retryable: error.code === "PDF_EXTRACT_TIMEOUT" };
  }
  return { code: "SOURCE_FETCH_FAILED", stage: "fetch", sourceId, message: "The source could not be prepared.", retryable: true };
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SourceMaterialError("SOURCE_FETCH_FAILED", "extract", "The source did not contain valid UTF-8 text.", false, error);
  }
}

function decodeEntities(value: string): string {
  const codePoint = (raw: string, radix: number): string => {
    const code = Number.parseInt(raw, radix);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : "";
  };
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => codePoint(code, 16))
    .replace(/&#([0-9]+);/gu, (_match, code: string) => codePoint(code, 10))
    .replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"').replace(/&#39;|&apos;/gu, "'");
}

function boundedTitle(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim() || fallback;
  return Array.from(normalized).slice(0, 160).join("");
}

function htmlText(html: string): { title: string; content: string } {
  const title = boundedTitle(decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1]?.trim() ?? ""), "Web source");
  const content = decodeEntities(html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ").trim();
  if (!content) throw new SourceMaterialError("SOURCE_EMPTY", "extract", "The source did not contain readable text.", false);
  return { title, content };
}

function safeUrlDisplay(url: URL): string {
  return `${url.origin}${url.pathname || "/"}`;
}

function isPdf(bytes: Uint8Array, contentType: string | undefined): boolean {
  return contentType === "application/pdf" || (bytes.byteLength >= 5 && Buffer.from(bytes.buffer, bytes.byteOffset, 5).equals(Buffer.from("%PDF-", "ascii")));
}

function contentType(response: SourceHttpResponse): string | undefined {
  return header(response, "content-type");
}

async function prepareUrlSource(
  source: Extract<SourceMaterialInput["sources"][number], { kind: "url" }>,
  sourceId: string,
  deps: Required<Pick<SourceMaterialDependencies, "resolveHostname" | "fetchSource" | "extractPdfText">> & { timeoutMs: number; maxResponseBytes: number },
): Promise<PreparedSource> {
  const url = new URL(source.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    const addresses = await publicAddresses(url, deps.resolveHostname, deps.timeoutMs);
    const responsePromise = deps.fetchSource(url, addresses, controller.signal, deps.maxResponseBytes);
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(new SourceMaterialError("SOURCE_FETCH_TIMEOUT", "fetch", "The source request exceeded its time limit.", true)), deps.timeoutMs);
    });
    const response = await Promise.race([responsePromise, timeout]);
    if (response.status >= 300 && response.status < 400) throw new SourceMaterialError("REDIRECT_BLOCKED", "fetch", "Source redirects are not followed.", false);
    if (new URL(response.finalUrl).href !== url.href) throw new SourceMaterialError("REDIRECT_BLOCKED", "fetch", "Source redirects are not followed.", false);
    if (response.status < 200 || response.status >= 300) throw new SourceMaterialError("SOURCE_FETCH_FAILED", "fetch", "The source request did not succeed.", response.status >= 500);
    if (response.body.byteLength > deps.maxResponseBytes) throw new SourceMaterialError("SOURCE_LIMIT_EXCEEDED", "fetch", "The source response exceeds the 8 MiB limit.", false);
    const type = contentType(response);
    if (isPdf(response.body, type)) {
      const content = (await deps.extractPdfText(response.body, undefined)).trim();
      if (!content) throw new SourceMaterialError("SOURCE_EMPTY", "extract", "The PDF did not contain readable text.", false);
      return { id: sourceId, kind: "url", title: boundedTitle(source.label ?? "PDF source", "PDF source"), locator: safeUrlDisplay(url), content, characterCount: content.length };
    }
    if (type === "text/html" || type === undefined) {
      const parsed = htmlText(decodeText(response.body));
      return { id: sourceId, kind: "url", title: boundedTitle(source.label ?? parsed.title, "Web source"), locator: safeUrlDisplay(url), content: parsed.content, characterCount: parsed.content.length };
    }
    if (type === "text/plain" || type === "text/markdown") {
      const content = decodeText(response.body).trim();
      if (!content) throw new SourceMaterialError("SOURCE_EMPTY", "extract", "The source did not contain readable text.", false);
      return { id: sourceId, kind: "url", title: boundedTitle(source.label ?? "Text source", "Text source"), locator: safeUrlDisplay(url), content, characterCount: content.length };
    }
    throw new SourceMaterialError("SOURCE_UNSUPPORTED_TYPE", "extract", "The URL did not return HTML, text, Markdown, or PDF content.", false);
  } finally {
    clearTimeout(timer);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    controller.abort();
  }
}

async function preparePdfSource(
  source: Extract<SourceMaterialInput["sources"][number], { kind: "pdf" }>,
  sourceId: string,
  deps: Required<Pick<SourceMaterialDependencies, "readAttachment" | "extractPdfText">>,
): Promise<PreparedSource> {
  const bytes = await deps.readAttachment(source.file);
  if (bytes.byteLength > MAX_PDF_BYTES || bytes.byteLength < 5 || !Buffer.from(bytes.buffer, bytes.byteOffset, 5).equals(Buffer.from("%PDF-", "ascii"))) {
    throw new SourceMaterialError("PDF_INVALID", "extract", "The staged attachment is not a valid PDF.", false);
  }
  const content = await deps.extractPdfText(bytes, source.pages);
  if (!content.trim()) throw new SourceMaterialError("SOURCE_EMPTY", "extract", "The PDF did not contain readable text.", false);
  return {
    id: sourceId,
    kind: "pdf",
    title: boundedTitle(source.file.fileName, "PDF source"),
    locator: `attachment:${source.file.fileName}`,
    ...(source.pages ? { pageRange: source.pages } : {}),
    content: content.trim(),
    characterCount: content.trim().length,
  };
}

export async function prepareSourceMaterial(input: unknown, dependencies: SourceMaterialDependencies = {}): Promise<PreparedSourceMaterial> {
  const parsed = SourceMaterialInputSchema.parse(input);
  const jobId = randomUUID();
  const resolveHostname = dependencies.resolveHostname ?? (async (hostname: string) => (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address));
  const fetchSource = dependencies.fetchSource ?? fetchHttpsSource;
  const extractPdfText = dependencies.extractPdfText ?? ((bytes, pages) => extractPdfTextDefault(bytes, pages));
  const timeoutMs = dependencies.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS;
  const maxResponseBytes = dependencies.maxResponseBytes ?? MAX_SOURCE_RESPONSE_BYTES;
  const maxContextBytes = dependencies.maxContextBytes ?? MAX_SOURCE_CONTEXT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SOURCE_FETCH_TIMEOUT_MS) throw new RangeError("Source fetch timeout is outside the supported range.");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_SOURCE_RESPONSE_BYTES) throw new RangeError("Source response limit is outside the supported range.");
  if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes < 1 || maxContextBytes > MAX_SOURCE_CONTEXT_BYTES) throw new RangeError("Source context limit is outside the supported range.");
  const sources: PreparedSource[] = [];
  const failures: SourceFailure[] = [];
  let contextBytes = 0;
  for (let index = 0; index < parsed.sources.length; index++) {
    const source = parsed.sources[index]!;
    const sourceId = `source-${jobId}-${index + 1}`;
    try {
      const prepared = source.kind === "url"
        ? await prepareUrlSource(source, sourceId, { resolveHostname, fetchSource, extractPdfText, timeoutMs, maxResponseBytes })
        : await preparePdfSource(source, sourceId, { readAttachment: dependencies.readAttachment ?? (() => Promise.reject(new SourceMaterialError("SOURCE_ATTACHMENT_UNAUTHORIZED", "input", "This MCP host cannot read the PDF attachment.", false))), extractPdfText });
      const bytes = Buffer.byteLength(prepared.content, "utf8");
      if (contextBytes + bytes > maxContextBytes) throw new SourceMaterialError("SOURCE_LIMIT_EXCEEDED", "extract", "The prepared source context exceeds the 2 MiB limit.", false);
      contextBytes += bytes;
      prepared.characterCount = prepared.content.length;
      sources.push(prepared);
    } catch (error) {
      failures.push(failure(sourceId, error));
    }
  }
  const sourceDigest = sources.length === 0 ? null : createHash("sha256")
    .update(JSON.stringify({ options: parsed.options, sources: sources.map(({ id, kind, title, locator, pageRange, content }) => ({ id, kind, title, locator, pageRange, content })) }))
    .digest("hex");
  const output: PreparedSourceMaterial = {
    status: sources.length === 0 ? "failed" : failures.length > 0 ? "partial" : "ready",
    jobId,
    options: parsed.options,
    sourceDigest,
    sources,
    failures,
    warnings: failures.length > 0 ? ["Some requested sources could not be prepared; do not infer their missing content."] : [],
  };
  rememberPreparedSourceMaterial(output);
  return output;
}
