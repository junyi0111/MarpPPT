# Hosted MarpPPT deployment readiness

This guide describes the container contract and release preparation. It does not select a cloud provider, deploy a service, or publish a plugin. No hosted endpoint has been selected for this candidate.

## Current release gate

The HTTP service and manifest generator are implementation scaffolding. A syntactically valid URL does not prove that a server is reachable, authenticated, interoperable, or accepted by Codex or ChatGPT. No real hosted manifest or hosted candidate archive has been generated.

The current production resolver remains fail-closed for host conversation attachments. A local Skill-side staging path writes private files on the Skill host; a separately hosted MCP process cannot read those files. A hosted release needs an authorized attachment transfer design that is tested end to end before the remote service can render a user's conversation attachments. M0 conversation transfer and artifact open/save, manual object editing, public reachability, and live Streamable HTTP acceptance remain open gates. See [the acceptance report](acceptance-report.md).

## Service contract

- Streamable HTTP MCP endpoint: `POST /mcp` (the route also mounts the SDK handler for other MCP transport methods).
- Liveness and readiness endpoint: `GET /healthz`; the only response fields are `status` and `version`.
- Artifact downloads: opaque-token route `/artifacts/:token`.
- The HTTP JSON body contains a presentation plan and opaque attachment references. It does not carry attachment bytes. The JSON body limit is at most 2 MiB.
- Arbitrary URLs, local file paths, and unauthenticated host-file references are not accepted as an attachment-ingestion feature. There is no general-purpose HTTP file origin allowlist.

`/healthz` returns HTTP 200 only after the service has parsed its startup configuration, created and verified its private output directory, and confirmed `soffice`, `pdfinfo`, and `pdftoppm` with bounded version checks. The local preflight used for verified CJK output additionally checks PDF text-layer glyph coverage with `pdftotext`. The result is cached for the process lifetime. Missing or timed-out renderers return HTTP 503. `fc-match` is optional and does not determine readiness.

Hosted HTTP rendering runs each admitted job in a separate worker process. The parent starts one 60-second timer before asynchronous worker setup; it covers attachment resolution, PPTX generation and inspection, preview rendering, artifact writes, parent-side reference validation, and HTTP token registration. On expiry during worker execution, the parent sends TERM to the worker process group, allows a short grace period, sends KILL if needed, and waits for worker exit. A timeout returns `RENDER_TIMEOUT`; output and private temp cleanup continue in a finalizer while the job slot remains occupied. If parent-side validation or token registration is still pending at timeout, the response can return immediately while the finalizer waits for that operation to settle before deleting files and tokens. Successful or other completed results are decided before cleanup, so slow cleanup cannot turn them into a timeout; cleanup can extend those responses. Worker stdin and stdout are each capped at 2 MiB. A timeout never returns a successful render result. Hosted preview subprocesses inherit the worker process group, so group termination also reaches renderer descendants, including processes that ignore TERM.

This is an HTTP render-work deadline, not a deadline for the full network request: queueing, transport, and successful-result cleanup can extend caller-visible duration beyond 60 seconds. After a timeout response, cleanup can continue in the background and keep the job slot occupied. The stdio server still renders in-process and does not use this hosted worker deadline. Only same-host signed staged refs can currently be resolved; a client-side stage ref does not transfer attachment bytes to a remote server, and `host-file` remains fail-closed. The worker boundary therefore does not complete Codex conversation-attachment handoff or M0. Keep an ingress timeout long enough for 60 seconds of work plus worker termination, and retain independent CPU, memory, process, disk, and request limits.

## Runtime configuration

| Setting | Required/default | Validation and purpose |
| --- | --- | --- |
| `PORT` | default `8080` | Integer TCP port from 1 through 65535. |
| `PPTX_OUTPUT_ROOT` | required | Absolute path below `/`; the service creates or verifies a real directory owned by its runtime user with private permissions. Mount persistent, writable storage here. |
| `MARPPPT_PUBLIC_BASE_URL` | required | HTTPS origin only, with no credentials, path, query, or fragment. Artifact links use this public origin. |
| `MARPPPT_MAX_REQUEST_BYTES` | default `2097152` | Integer from 1024 bytes through 2 MiB. This limit applies to JSON metadata and opaque refs, not attachment contents. |
| `MARPPPT_MAX_ACTIVE_REQUESTS` | default `8` | Integer from 1 through 128. Excess requests receive HTTP 503. |
| `MARPPPT_MAX_ACTIVE_JOBS` | default `2` | Integer from 1 through 32 and no greater than the request limit. Every `render_presentation` call in a JSON-RPC batch consumes a slot. |
| `MARPPPT_SOFFICE` | default `soffice` | Optional absolute executable override. |
| `MARPPPT_PDFINFO` | default `pdfinfo` | Optional absolute executable override. |
| `MARPPPT_PDFTOPPM` | default `pdftoppm` | Optional absolute executable override. |
| `MARPPPT_PDFTOTEXT` | default `pdftotext` | Optional absolute executable override used for CJK glyph coverage checks. |
| `MARPPPT_FC_MATCH` | default `fc-match` | Optional font matcher used during preview; it is not part of readiness. |

The HTTP artifact-token lifetime is fixed at 30 minutes. The token-to-file map is held in process memory. Keep one replica and avoid process restarts while artifact links are in use. Multiple replicas cannot share or resolve each other's tokens, and a restart invalidates outstanding HTTP download tokens even if the private output volume remains intact. Shared token storage is future work.

## Container and operational controls

The Docker image uses a multi-stage build, installs LibreOffice Impress, Poppler, fontconfig, and Noto CJK fonts, and runs the HTTP service as UID/GID `10001`. It creates a private output directory and a private temp directory, sets the HTTP server command, and checks `/healthz` through the image healthcheck. `docker-compose.yml` also sets a read-only root filesystem, bounded tmpfs, output volume, CPU/memory/PID limits, drops Linux capabilities, and disables privilege escalation as a starting local profile.

For any hosting environment:

1. Run a non-root container with a read-only root filesystem where supported. Give only the output volume and temporary directory write access, both private to the service identity.
2. Set CPU and memory limits, an ingress body limit no higher than 2 MiB, a bounded request timeout, and connection/rate limits. The configured active-request and active-job caps provide in-process admission control; they do not replace platform limits.
3. Configure `PPTX_OUTPUT_ROOT` as a private persistent volume. Set retention and backup policy for generated presentations; remove files according to that policy.
4. Set the HTTPS artifact origin to the exact public origin that will serve `/artifacts/:token`. Configure DNS, TLS renewal, and ingress forwarding for `/mcp`, `/healthz`, and `/artifacts/`.
5. Keep credentials out of source, build arguments, image layers, and manifests. Use the provider's secret manager if authorization or upstream credentials are added.
6. Verify the deployed service using its actual public URL and an MCP client. Test initialization, tool discovery, valid and invalid calls, timeout cleanup, artifact retrieval, expiry, restart behavior, and authorization before connecting a client or proposing publication.
7. Monitor readiness, HTTP status, latency, process memory, CPU, disk usage, and renderer failures. Keep an immutable previous image and deployment configuration available for rollback.

Structured logs separate HTTP request events from render-result events. Request events include a random request ID, fixed route class, HTTP status, duration, and a known route error code when available. Artifact URLs are logged as `/artifacts/:token`. Render events join to that request ID and include only the random job ID, render result (`completed`, `draft`, or `failed`), known failure code, measured render duration, and cleanup outcome (`succeeded`, `failed`, or `not-needed`) observed by the render finalizer. The service does not log request bodies, content, attachment data, signed URLs, artifact tokens, cleanup error details, or paths. An HTTP 200 alone must not be interpreted as a completed render.

The container does not add authentication or a host-provided attachment adapter. A public endpoint must be protected with an appropriate authorization boundary before it accepts private user data. Use the hosting platform's ingress for TLS and access control; validate any MCP client authentication mechanism against its official requirements.

## Preparing manifests and a candidate archive

Choose a stable HTTPS `/mcp` endpoint only after it is deployed and verified. The manifest generator checks URL syntax only; it deliberately makes no network request and does not verify DNS, TLS, route behavior, authorization, or reachability.

```bash
PLUGIN_MCP_URL='https://slides.example.org/mcp' npm run manifest:hosted
PLUGIN_MCP_URL='https://slides.example.org/mcp' npm run package:plugin -- --profile hosted
```

The first command writes `mcp.json` and `.mcp.json` under `runtime/hosted-release/`. The second overlays those files into a hosted candidate ZIP; it does not edit the local root manifests. The portable config uses Streamable HTTP; the Codex compatibility config uses the Codex HTTP transport type. These commands have not been run with a real endpoint in this task.

## Release checklist

- [ ] Select a stable endpoint and verify public DNS, TLS, routing, authentication, and `/healthz` readiness.
- [ ] Implement and pass the authorized conversation-attachment handoff and artifact open/save M0 workflow.
- [ ] Verify manual text, image, and shape editing, save, and reopen in a presentation app.
- [ ] Review full-size output and CJK rendering in the target environment.
- [ ] Audit and resolve the two previously reported high-severity dependency advisories.
- [ ] Confirm single-replica/token-memory operational constraints or implement shared token storage.
- [ ] Generate a hosted profile only with the selected endpoint, inspect the ZIP manifests, then complete MCP client and plugin review checks.
- [ ] Choose a hosting provider, privacy statement, retention policy, monitoring, and rollback owner.
- [ ] Publish only after every required acceptance gate is passed.
