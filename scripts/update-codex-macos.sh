#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'MarpPPT update: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail 'This updater supports macOS only.'

case "$(uname -m)" in
  arm64|x86_64) ;;
  *) fail 'Unsupported Mac architecture.' ;;
esac

codex_bin="${MARPPPT_CODEX_BIN:-}"
if [[ -z "$codex_bin" ]]; then
  codex_bin="$(command -v codex || true)"
fi
if [[ -z "$codex_bin" ]]; then
  for candidate in \
    /Applications/ChatGPT.app/Contents/Resources/codex \
    /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
    "$HOME/Applications/ChatGPT.app/Contents/Resources/codex" \
    "$HOME/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" \
    /Applications/Codex.app/Contents/Resources/codex \
    "$HOME/Applications/Codex.app/Contents/Resources/codex"; do
    if [[ -x "$candidate" ]]; then
      codex_bin="$candidate"
      break
    fi
  done
fi
[[ -n "$codex_bin" && -x "$codex_bin" ]] || fail 'Codex desktop app was not found. Set MARPPPT_CODEX_BIN to its executable.'

install_root="${MARPPPT_INSTALL_ROOT:-$HOME/.local/share/marpppt}"
[[ "$install_root" == /* ]] || fail 'MARPPPT_INSTALL_ROOT must be an absolute path.'
[[ -d "$install_root/source" ]] || fail "No existing MarpPPT source found at $install_root/source. Run the installer first."
node_bin="$install_root/node/bin/node"
[[ -x "$node_bin" ]] || fail "No managed Node.js runtime found at $node_bin. Run the installer first."
npm_bin="$install_root/node/bin/npm"
[[ -f "$npm_bin" ]] || fail "No managed npm runtime found at $npm_bin. Run the installer first."

umask 077
staging_dir="$(mktemp -d "$install_root/.update.XXXXXXXX")"
backup_dir="$install_root/.source-backup.$$.${RANDOM}"
swapped=0

cleanup() {
  rm -rf "$staging_dir"
  if [[ "$swapped" == 1 && -e "$backup_dir" ]]; then
    rm -rf "$install_root/source"
    mv "$backup_dir" "$install_root/source" || true
  elif [[ "$swapped" == 2 && -e "$backup_dir" ]]; then
    rm -rf "$backup_dir"
  fi
}
trap cleanup EXIT

printf 'Downloading the latest MarpPPT source...\n'
curl -fsSL --retry 3 https://codeload.github.com/junyi0111/MarpPPT/tar.gz/refs/heads/main -o "$staging_dir/MarpPPT.tar.gz"
tar -xzf "$staging_dir/MarpPPT.tar.gz" -C "$staging_dir"
source_staging="$staging_dir/MarpPPT-main"
[[ -f "$source_staging/package-lock.json" && -f "$source_staging/.agents/plugins/marketplace.json" ]] || fail 'MarpPPT source archive is incomplete.'

printf 'Installing dependencies and validating the update...\n'
(cd "$source_staging" && PATH="$install_root/node/bin:$PATH" "$npm_bin" ci && PATH="$install_root/node/bin:$PATH" "$npm_bin" run build && PATH="$install_root/node/bin:$PATH" "$npm_bin" run package:validate)

"$node_bin" - "$source_staging" "$node_bin" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, nodeBinary] = process.argv.slice(2);
for (const name of ['mcp.json', '.mcp.json']) {
  const file = path.join(root, name);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.mcpServers.presentation.command = nodeBinary;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
NODE

mv "$install_root/source" "$backup_dir"
swapped=1
mv "$source_staging" "$install_root/source"

printf 'Refreshing the local marketplace and plugin cache...\n'
"$codex_bin" plugin marketplace add "$install_root/source"
install_result="$("$codex_bin" plugin add markdown-to-editable-pptx@marpppt --json)"
plugin_root="$(printf '%s' "$install_result" | "$node_bin" -e 'const fs=require("node:fs"); const result=JSON.parse(fs.readFileSync(0,"utf8")); if(result.pluginId!=="markdown-to-editable-pptx@marpppt" || !result.installedPath) process.exit(1); process.stdout.write(result.installedPath);')"
[[ -f "$plugin_root/dist/mcp/stdio.js" ]] || fail 'The updated plugin cache is missing its MCP server.'
swapped=2

printf 'Checking the updated MCP tools...\n'
(cd "$plugin_root" && MARPPPT_CHECK_NODE_BIN="$node_bin" MARPPPT_CHECK_PLUGIN_ROOT="$plugin_root" MARPPPT_CHECK_OUTPUT_ROOT="$staging_dir/check-output" "$node_bin" --input-type=module <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'marpppt-update-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.env.MARPPPT_CHECK_NODE_BIN,
  args: [`${process.env.MARPPPT_CHECK_PLUGIN_ROOT}/dist/mcp/stdio.js`],
  cwd: process.env.MARPPPT_CHECK_PLUGIN_ROOT,
  env: { ...process.env, PPTX_OUTPUT_ROOT: process.env.MARPPPT_CHECK_OUTPUT_ROOT },
});
await client.connect(transport);
try {
  const result = await client.listTools();
  const names = new Set(result.tools.map((tool) => tool.name));
  if (!names.has('render_presentation') || !names.has('ensure_font') || !names.has('prepare_markdown_sources') || !names.has('save_markdown_draft')) {
    throw new Error('The updated MCP does not expose render_presentation, ensure_font, prepare_markdown_sources, and save_markdown_draft.');
  }
} finally {
  await client.close();
}
NODE
)

rm -rf "$backup_dir"
swapped=0
printf '\nUpdated MarpPPT. Quit and reopen Codex completely, then start a new conversation.\n'
