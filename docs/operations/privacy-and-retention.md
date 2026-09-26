# MarpPPT local data handling

## Input boundary

The local staging command accepts one UTF-8 `.md` file of at most 2 MiB and up to 30 PNG/JPEG images. Each image is limited to 10 MiB; the combined staged attachment set is limited to 50 MiB. The validated slide plan is limited to 60 slides. Image type is checked against decoded bytes as well as the extension. The renderer does not execute Markdown code, fetch arbitrary image URLs, or accept caller-supplied filesystem paths in MCP parameters.

Conversation attachments, if the host exposes authorized readable paths, are copied by `stage:attachments` to a private temporary directory on the configured MCP host. This means their bytes leave the conversation host for the MCP host when those hosts are different. The exact host and transfer mechanism must be reviewed before connecting a remote MCP deployment. The current local build has no verified Codex conversation attachment handoff; a visible filename alone is insufficient authorization.

## Temporary files and outputs

Each staged input job has a maximum 30-minute lifetime and is removed by a detached reaper or later cleanup scan. A completed render removes its working directory after producing the artifacts; failure also cleans its temporary render files. The local output store writes the PPTX, `.marp.md`, optional image bundle, and preview PNGs under `~/.marpppt/artifacts/<job-id>/` by default. Set `PPTX_OUTPUT_ROOT` to override that absolute directory. Local output references use `file://` and have no automatic expiry. The operator must remove these job directories when no longer needed.

The HTTP artifact mode issues unguessable download links that expire after 30 minutes. Expiry removes the token, **not** the underlying output files in `PPTX_OUTPUT_ROOT`; the operator must remove retained files separately. The HTTP host profile has not passed a live socket acceptance test in this sandbox.

## Logs and deletion

The normal MCP result contains file names, artifact references, warnings, validation counts, image usage, and typed failures. The staging command emits opaque IDs and metadata; it should be called with a structured argument array or safely quoted paths to avoid printing input paths through a shell. The implementation does not intentionally log Markdown bodies, image bytes, signed attachment URLs, or output file bytes. Runtime and host logs should be controlled by the operator because filesystem paths, error messages, and request metadata can still appear there.

To delete retained local outputs, remove the specific `<output-root>/<job-id>/` directory after saving any wanted files; `<output-root>` is `~/.marpppt/artifacts/` unless overridden by `PPTX_OUTPUT_ROOT`. To delete an unexpired staged input job, use the staging cleanup API or remove its private job directory through an authorized local process. Do not delete another job by guessing a path from a display name.
