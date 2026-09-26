import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalArtifactStore } from "../../src/artifacts/local-artifact-store.js";
import { classifyHttpRoute, createApp, createRenderTelemetryLogger, createRequestLogMiddleware } from "../../src/mcp/http.js";
import { createRendererReadiness } from "../../src/mcp/renderer-readiness.js";
import type { PresentationServerDependencies } from "../../src/mcp/server.js";

class CapturedResponse extends EventEmitter {
  statusCode = 200;
  locals: Record<string, unknown> = {};
  headers: Record<string, string> = {};
  body: unknown;

  setHeader(name: string, value: string): this { this.headers[name] = value; return this; }
  status(code: number): this { this.statusCode = code; return this; }
  json(body: unknown): this { this.body = body; return this; }
}

describe("HTTP service readiness and admission", () => {
  let outputRoot: string;
  let artifactStore: Awaited<ReturnType<typeof createLocalArtifactStore>>;

  beforeEach(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), "marpppt-health-"));
    artifactStore = await createLocalArtifactStore({ outputRoot });
  });

  afterEach(async () => {
    await artifactStore.close?.();
    await rm(outputRoot, { recursive: true, force: true });
  });

  function makeApp(options: { readinessCheck?: () => Promise<boolean> } = {}, validated = true) {
    const server = {
      attachmentResolver: { probeResolver: { read: async () => { throw new Error("not authorized"); } } },
      artifactStore,
      theme: { id: "default" },
    } as unknown as PresentationServerDependencies;
    return createApp({
      server,
      configurationValidated: validated,
      readinessCheck: options.readinessCheck ?? (async () => true),
      requestBodyLimitBytes: 2 * 1024 * 1024,
      maxActiveRequests: 8,
      maxActiveJobs: 2,
    });
  }

  function getHealthHandler(app: ReturnType<typeof createApp>) {
    const routes = (app as unknown as { router: { stack: Array<{ route?: { path: string; stack: Array<{ handle: (request: unknown, response: unknown, next: () => void) => unknown }> } }> } }).router.stack;
    const layer = routes.find((entry) => entry.route?.path === "/healthz");
    expect(layer).toBeDefined();
    return layer!.route!.stack[0]!.handle;
  }

  async function invokeHealth(app: ReturnType<typeof createApp>): Promise<CapturedResponse> {
    const response = new CapturedResponse();
    await getHealthHandler(app)({}, response, () => undefined);
    return response;
  }

  it("returns only status and version after validated configuration and cached renderer checks", async () => {
    const readinessCheck = vi.fn(async () => true);
    const app = makeApp({ readinessCheck });

    const first = await invokeHealth(app);
    const second = await invokeHealth(app);

    expect(first.statusCode).toBe(200);
    expect(first.body).toEqual({ status: "ready", version: expect.any(String) });
    expect(Object.keys(first.body as object).sort()).toEqual(["status", "version"]);
    expect(second.body).toEqual(first.body);
    expect(first.headers["Cache-Control"]).toBe("no-store");
    expect(readinessCheck).toHaveBeenCalledTimes(1);
  });

  it("keeps health unavailable when a required renderer is missing", async () => {
    const app = makeApp({
      readinessCheck: createRendererReadiness({
        commands: {
          soffice: { file: "/missing/marpppt-soffice", args: ["--version"] },
          pdfinfo: { file: process.execPath, args: ["--version"] },
          pdftoppm: { file: process.execPath, args: ["--version"] },
        },
        timeoutMs: 250,
      }),
    });

    const response = await invokeHealth(app);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ status: "not_ready", version: expect.any(String) });
    expect(Object.keys(response.body as object).sort()).toEqual(["status", "version"]);
  });

  it("does not report ready when startup configuration was not validated", async () => {
    const readinessCheck = vi.fn(async () => true);
    const response = await invokeHealth(makeApp({ readinessCheck }, false));

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ status: "not_ready", version: expect.any(String) });
    expect(readinessCheck).not.toHaveBeenCalled();
  });

  it("mounts health, MCP, and artifact routes without starting a listening server", async () => {
    const app = makeApp();
    const stack = (app as unknown as { router: { stack: Array<{ handle: { name: string }; route?: { path: string } }> } }).router.stack;
    const paths = stack
      .flatMap((layer) => layer.route ? [layer.route.path] : []);

    expect(paths).toContain("/healthz");
    expect(paths).toContain("/mcp");
    expect(paths).toContain("/artifacts/:token");
    const requestAdmissionIndex = stack.findIndex((layer) => layer.handle.name === "requestAdmissionMiddleware");
    const bodyParserIndex = stack.findIndex((layer) => layer.handle.name === "jsonParser");
    const jobAdmissionIndex = stack.findIndex((layer) => layer.handle.name === "renderJobAdmissionMiddleware");
    expect(requestAdmissionIndex).toBeGreaterThan(-1);
    expect(requestAdmissionIndex).toBeLessThan(bodyParserIndex);
    expect(bodyParserIndex).toBeLessThan(jobAdmissionIndex);
  });

  it("redacts artifact tokens from safe route logging", () => {
    const token = "sensitive-artifact-token-should-not-appear";
    const events: unknown[] = [];
    const middleware = createRequestLogMiddleware((event) => events.push(event));
    const response = new CapturedResponse();
    let continued = false;

    expect(classifyHttpRoute(`/artifacts/${token}`)).toBe("/artifacts/:token");
    middleware({ path: `/artifacts/${token}` } as never, response as never, () => { continued = true; });
    response.locals.errorCode = "ARTIFACT_NOT_FOUND";
    response.statusCode = 404;
    response.emit("finish");

    expect(continued).toBe(true);
    expect(response.headers["X-Request-ID"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(events).toMatchObject([{ routeClass: "/artifacts/:token", status: 404, errorCode: "ARTIFACT_NOT_FOUND" }]);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("joins render status to the request ID without logging content, refs, URLs, or paths", () => {
    const events: unknown[] = [];
    const record = createRenderTelemetryLogger("request-id-safe-test", (event) => events.push(event));
    record({
      jobId: "01234567-89ab-4cde-8f01-23456789abcd",
      status: "failed",
      errorCode: "ATTACHMENT_UNREADABLE",
      cleanupOutcome: "succeeded",
      durationMs: 12.5,
    });

    expect(events).toEqual([{
      event: "render_result",
      requestId: "request-id-safe-test",
      routeClass: "/mcp",
      jobId: "01234567-89ab-4cde-8f01-23456789abcd",
      resultStatus: "failed",
      errorCode: "ATTACHMENT_UNREADABLE",
      cleanupOutcome: "succeeded",
      durationMs: 12.5,
    }]);
    expect(JSON.stringify(events)).not.toMatch(/source\.md|stage:|https:|private\/|secret|token/u);
  });

  it("bounds renderer probes and caches a failed readiness result", async () => {
    const readiness = createRendererReadiness({
      commands: {
        soffice: { file: process.execPath, args: ["--version"] },
        pdfinfo: { file: "/missing/marpppt-pdfinfo", args: ["-v"] },
        pdftoppm: { file: process.execPath, args: ["--version"] },
      },
      timeoutMs: 250,
    });

    await expect(readiness()).resolves.toBe(false);
    await expect(readiness()).resolves.toBe(false);
  });
});
