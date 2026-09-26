import { createServer as createHttpServer } from "node:http";
import type { Server as NodeHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ArtifactStoreError, type HttpArtifactStore } from "../artifacts/artifact-store.js";
import { createHttpArtifactStore } from "../artifacts/http-artifact-store.js";
import { createLocalArtifactStore } from "../artifacts/local-artifact-store.js";
import { createHttpAdmission } from "./http-admission.js";
import { parseHttpRuntimeConfig } from "./http-config.js";
import { createRendererReadiness } from "./renderer-readiness.js";
import { getDefaultTempWorkspaceRoot } from "../attachments/temp-workspace.js";
import { runHttpRenderWorker, type HttpRenderWorkerOptions } from "./http-render-worker.js";
import type { RenderFinalizedEvent } from "./tools/render-presentation.js";
import { createFailClosedRenderDependencies, createMcpServer, type PresentationServerDependencies } from "./server.js";

const VERSION = "0.1.0";
const DEFAULT_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_ACTIVE_REQUESTS = 8;
const DEFAULT_ACTIVE_JOBS = 2;

export interface HttpRequestLogEvent {
  event: "http_request";
  requestId: string;
  routeClass: string;
  status: number;
  durationMs: number;
  errorCode?: string;
}

export interface HttpRenderLogEvent {
  event: "render_result";
  requestId: string;
  routeClass: "/mcp";
  jobId: string;
  resultStatus: RenderFinalizedEvent["status"];
  durationMs: number;
  cleanupOutcome: RenderFinalizedEvent["cleanupOutcome"];
  errorCode?: string;
}

export type HttpLogEvent = HttpRequestLogEvent | HttpRenderLogEvent;

export function classifyHttpRoute(path: string): string {
  return path === "/healthz" ? "/healthz"
    : path === "/mcp" ? "/mcp"
      : path.startsWith("/artifacts/") ? "/artifacts/:token" : "other";
}

export function createRequestLogMiddleware(writeLog: (event: HttpLogEvent) => void): RequestHandler {
  return (request, response, next) => {
    const requestId = randomUUID();
    const routeClass = classifyHttpRoute(request.path);
    const startedAt = process.hrtime.bigint();
    response.locals.requestId = requestId;
    response.setHeader("X-Request-ID", requestId);
    response.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const code = response.locals.errorCode;
      try {
        writeLog({
          event: "http_request",
          requestId,
          routeClass,
          status: response.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          ...(typeof code === "string" ? { errorCode: code } : {}),
        });
      } catch { /* Logging failures must not break a completed request. */ }
    });
    next();
  };
}

export function createRenderTelemetryLogger(
  requestId: string,
  writeLog: (event: HttpLogEvent) => void,
): (event: RenderFinalizedEvent) => void {
  return (renderEvent) => {
    try {
      writeLog({
        event: "render_result",
        requestId,
        routeClass: "/mcp",
        jobId: renderEvent.jobId,
        resultStatus: renderEvent.status,
        ...(renderEvent.errorCode ? { errorCode: renderEvent.errorCode } : {}),
        durationMs: renderEvent.durationMs,
        cleanupOutcome: renderEvent.cleanupOutcome,
      });
    } catch { /* Telemetry failures must never alter the rendering result. */ }
  };
}

export function createHealthHandler(readiness: Promise<boolean>, version = VERSION): RequestHandler {
  return async (_request, response) => {
    const ready = await readiness;
    response.setHeader("Cache-Control", "no-store");
    response.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", version });
  };
}

export interface HttpAppConfig {
  server: PresentationServerDependencies;
  renderWorker?: Omit<HttpRenderWorkerOptions, "jobId" | "input" | "artifactStore" | "onFinalized">;
  downloadStore?: HttpArtifactStore;
  configurationValidated?: boolean;
  readinessCheck?: () => Promise<boolean>;
  requestBodyLimitBytes?: number;
  maxActiveRequests?: number;
  maxActiveJobs?: number;
  log?: (event: HttpLogEvent) => void;
}

type HttpAdmission = ReturnType<typeof createHttpAdmission>;

export function createRequestAdmissionMiddleware(admission: HttpAdmission): RequestHandler {
  return function requestAdmissionMiddleware(request, response, next) {
    if (request.path === "/healthz") {
      next();
      return;
    }
    const releaseRequest = admission.tryAcquireRequest();
    if (!releaseRequest) {
      response.locals.errorCode = "REQUEST_LIMIT";
      response.status(503).json({ error: { code: "REQUEST_LIMIT", message: "The service is at its active request limit." } });
      return;
    }
    response.once("finish", releaseRequest);
    response.once("close", releaseRequest);
    next();
  };
}

export function createRenderJobAdmissionMiddleware(admission: HttpAdmission): RequestHandler {
  return function renderJobAdmissionMiddleware(request, response, next) {
    const messages = Array.isArray(request.body) ? request.body : [request.body];
    const renderJobCount = request.path === "/mcp" ? messages.filter((message) => {
      if (!message || typeof message !== "object") return false;
      const rpc = message as { method?: unknown; params?: { name?: unknown } };
      return rpc.method === "tools/call" && rpc.params?.name === "render_presentation";
    }).length : 0;
    if (renderJobCount === 0 || renderJobCount <= admission.maxActiveJobs) {
      next();
      return;
    }
    response.locals.errorCode = "JOB_LIMIT";
    response.status(503).json({ error: { code: "JOB_LIMIT", message: "The batch contains more rendering jobs than the configured limit." } });
  };
}

export function createApp(config: HttpAppConfig): Express {
  const requestBodyLimitBytes = config.requestBodyLimitBytes ?? DEFAULT_REQUEST_BYTES;
  const maxActiveRequests = config.maxActiveRequests ?? DEFAULT_ACTIVE_REQUESTS;
  const maxActiveJobs = config.maxActiveJobs ?? DEFAULT_ACTIVE_JOBS;
  if (!Number.isSafeInteger(requestBodyLimitBytes) || requestBodyLimitBytes < 1024 || requestBodyLimitBytes > DEFAULT_REQUEST_BYTES) {
    throw new RangeError("HTTP JSON request size must be between 1 KiB and 2 MiB.");
  }
  if (config.renderWorker && !config.downloadStore) throw new Error("The isolated HTTP render worker requires a parent HTTP artifact store.");
  const admission = createHttpAdmission({ maxActiveRequests, maxActiveJobs });
  const readiness = config.configurationValidated
    ? Promise.resolve().then(() => (config.readinessCheck ?? createRendererReadiness())()).then(Boolean, () => false)
    : Promise.resolve(false);
  const writeLog = config.log ?? ((event: HttpLogEvent) => process.stderr.write(`${JSON.stringify(event)}\n`));
  const app = express();
  app.disable("x-powered-by");
  app.use(createRequestLogMiddleware(writeLog));
  app.use(createRequestAdmissionMiddleware(admission));
  app.use(express.json({ limit: requestBodyLimitBytes, strict: true }));
  app.use(createRenderJobAdmissionMiddleware(admission));

  app.get("/healthz", createHealthHandler(readiness));

  app.get("/artifacts/:token", async (request: Request, response: Response) => {
    if (!config.downloadStore) {
      response.locals.errorCode = "ARTIFACT_NOT_FOUND";
      response.status(404).json({ error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact download was not found." } });
      return;
    }
    try {
      const token = typeof request.params.token === "string" ? request.params.token : "";
      const artifact = await config.downloadStore.read(token);
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.type(artifact.mimeType);
      response.attachment(artifact.fileName);
      response.status(200).send(Buffer.from(artifact.bytes));
    } catch (error) {
      const artifactError = error instanceof ArtifactStoreError ? error : undefined;
      const status = artifactError?.code === "ARTIFACT_EXPIRED" ? 410
        : artifactError?.code === "ARTIFACT_NOT_FOUND" ? 404 : 500;
      response.locals.errorCode = artifactError?.code ?? "ARTIFACT_STORE_FAILED";
      response.status(status).json({
        error: {
          code: artifactError?.code ?? "ARTIFACT_STORE_FAILED",
          message: artifactError?.message ?? "Artifact download could not be completed.",
        },
      });
    }
  });

  app.all("/mcp", async (request: Request, response: Response) => {
    const requestId = typeof response.locals.requestId === "string" ? response.locals.requestId : "unknown";
    const logRender = createRenderTelemetryLogger(requestId, writeLog);
    const onRenderFinalized = (event: RenderFinalizedEvent) => {
      try { config.server.onRenderFinalized?.(event); }
      finally { logRender(event); }
    };
    const executeRender = config.renderWorker && config.downloadStore
      ? (input: unknown, deferReleaseUntil: (pending: Promise<unknown>) => void) => runHttpRenderWorker({
        ...config.renderWorker!,
        jobId: randomUUID(),
        input,
        artifactStore: config.downloadStore!,
        onFinalized: onRenderFinalized,
      }, deferReleaseUntil)
      : undefined;
    const mcpServer = createMcpServer({
      ...config.server,
      acquireRenderJob: () => admission.tryAcquireJob(),
      onRenderFinalized,
      ...(executeRender ? { executeRender } : {}),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      response.locals.errorCode = "MCP_TRANSPORT_FAILED";
      if (!response.headersSent) {
        response.status(500).json({ error: { code: "MCP_TRANSPORT_FAILED", message: "The MCP request could not be completed." } });
      } else if (!response.writableEnded) {
        response.end();
      }
    } finally {
      await mcpServer.close().catch(() => undefined);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const status = typeof error === "object" && error !== null && "status" in error && error.status === 413 ? 413 : 400;
    const code = status === 413 ? "REQUEST_TOO_LARGE" : "INVALID_JSON";
    response.locals.errorCode = code;
    response.status(status).json({ error: { code, message: status === 413 ? "The JSON request exceeds the configured size limit." : "The JSON request is invalid." } });
  });

  return app;
}

export interface RunningHttpServer {
  app: Express;
  server: NodeHttpServer;
  close(): Promise<void>;
}

export async function startHttpServerFromEnvironment(): Promise<RunningHttpServer> {
  const runtime = parseHttpRuntimeConfig(process.env);
  const tempRoot = getDefaultTempWorkspaceRoot();
  const localStore = await createLocalArtifactStore({ outputRoot: runtime.outputRoot });
  const downloadStore = createHttpArtifactStore({ localStore, publicBaseUrl: runtime.publicBaseUrl });
  let app: Express;
  try {
    const dependencies = await createFailClosedRenderDependencies({ artifactStore: downloadStore, outputRoot: localStore.outputRoot, tempRoot });
    app = createApp({
      server: dependencies,
      renderWorker: { outputRoot: localStore.outputRoot, tempRoot },
      downloadStore,
      configurationValidated: true,
      readinessCheck: createRendererReadiness(),
      requestBodyLimitBytes: runtime.requestBodyLimitBytes,
      maxActiveRequests: runtime.maxActiveRequests,
      maxActiveJobs: runtime.maxActiveJobs,
    });
  } catch (error) {
    await downloadStore.close?.();
    await localStore.close?.();
    throw error;
  }
  const server = createHttpServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(runtime.port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await downloadStore.close?.();
    await localStore.close?.();
    throw error;
  }
  return {
    app,
    server,
    async close() {
      await downloadStore.close?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startHttpServerFromEnvironment().then(({ server }) => {
    process.stderr.write(`MarpPPT MCP HTTP server listening on port ${(server.address() as { port: number } | null)?.port ?? "unknown"}.\n`);
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unable to start the MarpPPT HTTP server.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
