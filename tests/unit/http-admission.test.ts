import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createHttpAdmission, withRenderJobAdmission } from "../../src/mcp/http-admission.js";
import { createRenderJobAdmissionMiddleware, createRequestAdmissionMiddleware } from "../../src/mcp/http.js";

class CapturedResponse extends EventEmitter {
  statusCode = 200;
  locals: Record<string, unknown> = {};
  body: unknown;
  status(code: number): this { this.statusCode = code; return this; }
  json(body: unknown): this { this.body = body; return this; }
}

describe("HTTP active-work admission", () => {
  it("bounds requests and render jobs independently and releases slots exactly once", () => {
    const admission = createHttpAdmission({ maxActiveRequests: 3, maxActiveJobs: 1 });
    const releaseRequest = admission.tryAcquireRequest();
    const releaseJob = admission.tryAcquireJob();

    expect(releaseRequest).toBeTypeOf("function");
    expect(releaseJob).toBeTypeOf("function");
    expect(admission.tryAcquireRequest()).toBeTypeOf("function");
    expect(admission.tryAcquireRequest()).toBeTypeOf("function");
    expect(admission.tryAcquireRequest()).toBeUndefined();
    expect(admission.tryAcquireJob()).toBeUndefined();
    releaseJob?.();
    releaseJob?.();
    expect(admission.tryAcquireJob()).toBeTypeOf("function");
    releaseRequest?.();
    expect(admission.tryAcquireRequest()).toBeTypeOf("function");
  });

  it("counts every render job in a JSON-RPC batch as an active job slot", () => {
    const admission = createHttpAdmission({ maxActiveRequests: 8, maxActiveJobs: 2 });
    const releaseBatchJobs = admission.tryAcquireJobs(2);

    expect(releaseBatchJobs).toBeTypeOf("function");
    expect(admission.tryAcquireJob()).toBeUndefined();
    expect(admission.tryAcquireJobs(3)).toBeUndefined();
    releaseBatchJobs?.();
    expect(admission.tryAcquireJobs(2)).toBeTypeOf("function");
  });

  it("reserves request capacity before parsing and releases it after a parser error", () => {
    const admission = createHttpAdmission({ maxActiveRequests: 1, maxActiveJobs: 1 });
    const middleware = createRequestAdmissionMiddleware(admission);
    const response = new CapturedResponse();
    let continued = false;

    middleware({ path: "/mcp" } as never, response as never, () => { continued = true; });
    expect(continued).toBe(true);
    const rejected = new CapturedResponse();
    middleware({ path: "/mcp" } as never, rejected as never, () => { throw new Error("request should be capped while parsing"); });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.body).toMatchObject({ error: { code: "REQUEST_LIMIT" } });

    // Express routes the body-parser error through its final error handler, then emits finish.
    response.emit("finish");
    const retried = new CapturedResponse();
    continued = false;
    middleware({ path: "/mcp" } as never, retried as never, () => { continued = true; });
    expect(continued).toBe(true);
  });

  it("releases a reserved request slot when the client disconnects", () => {
    const admission = createHttpAdmission({ maxActiveRequests: 1, maxActiveJobs: 1 });
    const middleware = createRequestAdmissionMiddleware(admission);
    const response = new CapturedResponse();
    middleware({ path: "/mcp" } as never, response as never, () => undefined);
    response.emit("close");

    const retry = new CapturedResponse();
    let continued = false;
    middleware({ path: "/mcp" } as never, retry as never, () => { continued = true; });
    expect(continued).toBe(true);
  });

  it("counts parsed batch render jobs after a request slot has been acquired", () => {
    const admission = createHttpAdmission({ maxActiveRequests: 2, maxActiveJobs: 1 });
    const requestMiddleware = createRequestAdmissionMiddleware(admission);
    const jobMiddleware = createRenderJobAdmissionMiddleware(admission);
    const response = new CapturedResponse();
    requestMiddleware({ path: "/mcp" } as never, response as never, () => undefined);
    jobMiddleware({ path: "/mcp", body: [
      { method: "tools/call", params: { name: "render_presentation" } },
      { method: "tools/call", params: { name: "render_presentation" } },
    ] } as never, response as never, () => { throw new Error("batch must exceed the job cap"); });
    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ error: { code: "JOB_LIMIT" } });
  });

  it("holds a render slot through disconnect until the tool callback settles", async () => {
    const admission = createHttpAdmission({ maxActiveRequests: 1, maxActiveJobs: 1 });
    const requestMiddleware = createRequestAdmissionMiddleware(admission);
    const response = new CapturedResponse();
    requestMiddleware({ path: "/mcp" } as never, response as never, () => undefined);

    let finishRender!: () => void;
    const operation = vi.fn(() => new Promise<string>((resolve) => { finishRender = () => resolve("completed"); }));
    const running = withRenderJobAdmission(() => admission.tryAcquireJob(), operation, () => "JOB_LIMIT");
    response.emit("close");

    const competingOperation = vi.fn(async () => "should not run");
    await expect(withRenderJobAdmission(() => admission.tryAcquireJob(), competingOperation, () => "JOB_LIMIT"))
      .resolves.toBe("JOB_LIMIT");
    expect(competingOperation).not.toHaveBeenCalled();

    finishRender();
    await expect(running).resolves.toBe("completed");
    const released = admission.tryAcquireJob();
    expect(released).toBeTypeOf("function");
    released?.();
  });

  it("can return a deadline result while retaining the job lease until deferred work settles", async () => {
    const admission = createHttpAdmission({ maxActiveRequests: 1, maxActiveJobs: 1 });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const result = await withRenderJobAdmission(
      () => admission.tryAcquireJob(),
      async (deferReleaseUntil) => {
        deferReleaseUntil(pending);
        return "deadline response";
      },
      () => "rejected",
    );

    expect(result).toBe("deadline response");
    expect(admission.tryAcquireJob()).toBeUndefined();
    finish();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(admission.tryAcquireJob()).toBeTypeOf("function");
  });
});
