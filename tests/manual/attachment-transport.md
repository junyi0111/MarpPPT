# Live Codex attachment transport check (M0)

Run this check in a fresh Codex task with Markdown and image files attached by the user. A local MCP smoke check does not satisfy M0.

1. Run `npm ci` and validate the plugin manifest with the Plugin Creator validator available in your Codex installation. Resolve `${PLUGIN_ROOT}` to the checkout path when loading the local `.mcp.json` manifest.
2. Start a fresh Codex task and confirm it discovers the `probe_attachments` tool from the temporary local probe server.
3. Attach a Markdown file and a PNG/JPEG through the conversation file picker. Keep the original files for local comparison.
4. Use only the exact local paths surfaced to Codex for those attachments. Run the staging CLI with an argument array equivalent to `npm --silent run stage:attachments -- --source <source.md> --image <image.png>`. It returns a private expiring job with opaque references; do not infer paths from visible attachment names or substitute unrelated files.
5. Call `probe_attachments` using the staged references. Confirm both names, MIME types, byte lengths, and SHA-256 digests match the staging manifest. Confirm the response contains no local paths, Markdown text, raw image bytes, base64, or signed input URLs.
6. Open or save the returned sample PPTX from Codex. Verify that it is a valid one-slide presentation. A local `file://` link from a CLI check is not proof that the Codex user can open the artifact.
7. Record only a sanitized pass/fail summary and the failing boundary. M0 passes only if both conversation attachments reached the MCP as readable bytes and the user opened or saved the sample artifact through Codex.

For an isolated server smoke check using fixed in-memory fixtures, run `node --import tsx tests/manual/local-probe.ts`. That check covers MCP discovery, the tool call, arbitrary-path refusal, metadata redaction, a resource link, and PPTX ZIP bytes; it does not test live conversation transfer or artifact opening.
