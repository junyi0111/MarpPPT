import { isAbsolute, resolve } from "node:path";

const DEFAULT_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 128;
const MAX_ACTIVE_JOBS = 32;

export interface HttpRuntimeConfig {
  port: number;
  outputRoot: string;
  publicBaseUrl: string;
  requestBodyLimitBytes: number;
  maxActiveRequests: number;
  maxActiveJobs: number;
}

type Environment = Record<string, string | undefined>;

function boundedInteger(value: string | undefined, fallback: number, key: string, minimum: number, maximum: number): number {
  const candidate = value ?? String(fallback);
  if (!/^\d+$/u.test(candidate)) throw new Error(`${key} must be a whole number between ${minimum} and ${maximum}.`);
  const number = Number(candidate);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${key} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return number;
}

function required(env: Environment, key: string): string {
  const value = env[key];
  if (!value?.trim() || value !== value.trim()) throw new Error(`${key} must be configured without surrounding whitespace.`);
  return value;
}

function httpsOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("MARPPPT_PUBLIC_BASE_URL must be a valid HTTPS origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin === "null") {
    throw new Error("MARPPPT_PUBLIC_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

export function parseHttpRuntimeConfig(env: Environment = process.env): HttpRuntimeConfig {
  const port = boundedInteger(env.PORT, 8080, "PORT", 1, 65_535);
  const configuredRoot = required(env, "PPTX_OUTPUT_ROOT");
  if (!isAbsolute(configuredRoot) || configuredRoot === "/" || configuredRoot.includes("\0")) {
    throw new Error("PPTX_OUTPUT_ROOT must be a private absolute directory below the filesystem root.");
  }
  const outputRoot = resolve(configuredRoot);
  const publicBaseUrl = httpsOrigin(required(env, "MARPPPT_PUBLIC_BASE_URL"));
  const requestBodyLimitBytes = boundedInteger(env.MARPPPT_MAX_REQUEST_BYTES, DEFAULT_REQUEST_BYTES, "MARPPPT_MAX_REQUEST_BYTES", 1024, MAX_REQUEST_BYTES);
  const maxActiveRequests = boundedInteger(env.MARPPPT_MAX_ACTIVE_REQUESTS, 8, "MARPPPT_MAX_ACTIVE_REQUESTS", 1, MAX_ACTIVE_REQUESTS);
  const maxActiveJobs = boundedInteger(env.MARPPPT_MAX_ACTIVE_JOBS, 2, "MARPPPT_MAX_ACTIVE_JOBS", 1, MAX_ACTIVE_JOBS);
  if (maxActiveJobs > maxActiveRequests) throw new Error("MARPPPT_MAX_ACTIVE_JOBS cannot exceed MARPPPT_MAX_ACTIVE_REQUESTS.");
  return { port, outputRoot, publicBaseUrl, requestBodyLimitBytes, maxActiveRequests, maxActiveJobs };
}
