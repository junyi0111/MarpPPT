#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'MarpPPT install: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail 'This installer supports macOS only.'

case "$(uname -m)" in
  arm64) node_arch='arm64' ;;
  x86_64) node_arch='x64' ;;
  *) fail 'Unsupported Mac architecture.' ;;
esac

codex_bin="${MARPPPT_CODEX_BIN:-}"
if [[ -z "$codex_bin" ]]; then
  codex_bin="$(command -v codex || true)"
fi
if [[ -z "$codex_bin" ]]; then
  for candidate in /Applications/ChatGPT.app/Contents/Resources/codex "$HOME/Applications/ChatGPT.app/Contents/Resources/codex" /Applications/Codex.app/Contents/Resources/codex "$HOME/Applications/Codex.app/Contents/Resources/codex"; do
    if [[ -x "$candidate" ]]; then
      codex_bin="$candidate"
      break
    fi
  done
fi
[[ -n "$codex_bin" && -x "$codex_bin" ]] || fail 'Codex desktop app was not found. Install ChatGPT/Codex desktop first, or set MARPPPT_CODEX_BIN to its executable.'

install_root="${MARPPPT_INSTALL_ROOT:-$HOME/.local/share/marpppt}"
[[ "$install_root" == /* ]] || fail 'MARPPPT_INSTALL_ROOT must be an absolute path.'
[[ "$install_root" != / ]] || fail 'MARPPPT_INSTALL_ROOT cannot be the filesystem root.'
[[ ! -e "$install_root/source" && ! -e "$install_root/node" ]] || fail "Installation already exists at $install_root. Remove or update it deliberately before reinstalling."

umask 077
mkdir -p "$install_root"
staging_dir="$(mktemp -d "$install_root/.install.XXXXXXXX")"
trap 'rm -rf "$staging_dir"' EXIT

printf 'Downloading Node.js 24 for macOS %s...\n' "$node_arch"
curl -fsSL --retry 3 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$staging_dir/SHASUMS256.txt"
checksum_line="$(awk -v arch="$node_arch" '$2 ~ ("^node-v[0-9.]+-darwin-" arch "\\.tar\\.gz$") { print; exit }' "$staging_dir/SHASUMS256.txt")"
[[ -n "$checksum_line" ]] || fail 'Could not find the official Node.js macOS archive checksum.'
node_checksum="${checksum_line%% *}"
node_archive="${checksum_line##* }"
curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v24.x/$node_archive" -o "$staging_dir/$node_archive"
printf '%s  %s\n' "$node_checksum" "$staging_dir/$node_archive" | shasum -a 256 -c - >/dev/null || fail 'Node.js checksum verification failed.'
tar -xzf "$staging_dir/$node_archive" -C "$staging_dir"
node_staging="$staging_dir/${node_archive%.tar.gz}"
[[ -x "$node_staging/bin/node" && -f "$node_staging/bin/npm" ]] || fail 'Node.js archive is incomplete.'

printf 'Downloading MarpPPT source...\n'
curl -fsSL --retry 3 https://codeload.github.com/junyi0111/MarpPPT/tar.gz/refs/heads/main -o "$staging_dir/MarpPPT.tar.gz"
tar -xzf "$staging_dir/MarpPPT.tar.gz" -C "$staging_dir"
source_staging="$staging_dir/MarpPPT-main"
[[ -f "$source_staging/package-lock.json" && -f "$source_staging/.agents/plugins/marketplace.json" ]] || fail 'MarpPPT source archive is incomplete.'

printf 'Installing dependencies and building the plugin...\n'
(cd "$source_staging" && PATH="$node_staging/bin:$PATH" "$node_staging/bin/npm" ci && PATH="$node_staging/bin:$PATH" "$node_staging/bin/npm" run build && PATH="$node_staging/bin:$PATH" "$node_staging/bin/npm" run package:validate)

mv "$node_staging" "$install_root/node"
mv "$source_staging" "$install_root/source"
node_bin="$install_root/node/bin/node"
"$node_bin" - "$install_root/source" "$node_bin" <<'NODE'
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

printf 'Registering the marketplace and installing MarpPPT...\n'
"$codex_bin" plugin marketplace add "$install_root/source"
install_result="$("$codex_bin" plugin add markdown-to-editable-pptx@marpppt --json)"
plugin_root="$(printf '%s' "$install_result" | "$node_bin" -e 'const fs=require("node:fs"); const result=JSON.parse(fs.readFileSync(0,"utf8")); if(result.pluginId!=="markdown-to-editable-pptx@marpppt" || !result.installedPath) process.exit(1); process.stdout.write(result.installedPath);')"
[[ -f "$plugin_root/dist/mcp/stdio.js" ]] || fail 'The installed plugin cache is missing its MCP server.'

printf 'Checking the installed MCP server...\n'
(cd "$plugin_root" && MARPPPT_CHECK_NODE_BIN="$node_bin" MARPPPT_CHECK_PLUGIN_ROOT="$plugin_root" MARPPPT_CHECK_OUTPUT_ROOT="$staging_dir/check-output" "$node_bin" --input-type=module <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'marpppt-install-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.env.MARPPPT_CHECK_NODE_BIN,
  args: [`${process.env.MARPPPT_CHECK_PLUGIN_ROOT}/dist/mcp/stdio.js`],
  cwd: process.env.MARPPPT_CHECK_PLUGIN_ROOT,
  env: { ...process.env, PPTX_OUTPUT_ROOT: process.env.MARPPPT_CHECK_OUTPUT_ROOT },
});
await client.connect(transport);
try {
  const result = await client.listTools();
  if (!result.tools.some((tool) => tool.name === 'render_presentation')) {
    throw new Error('The installed MCP does not expose render_presentation.');
  }
} finally {
  await client.close();
}
NODE
)

printf '\nInstalled. Quit and reopen Codex, start a new conversation, and invoke $marp-ppt with a Markdown file.\n'
