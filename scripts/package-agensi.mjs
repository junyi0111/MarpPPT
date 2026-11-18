// Builds a self-contained, host-neutral Agent Skill zip (SKILL.md + bundled engine)
// for skill marketplaces. Requires `npm run build` first.
import { readFile, readdir, lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const SKILL = "marp-ppt";
const MTIME = new Date(2000, 0, 1);
const entries = {};

async function walk(dir, skip = () => false) {
  const out = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
    const rel = relative(root, path).split(sep).join("/");
    if (name === ".DS_Store" || skip(rel)) continue;
    if (info.isDirectory()) out.push(...await walk(path, skip));
    else out.push(rel);
  }
  return out;
}

async function add(archivePath, sourceRel, executable = false) {
  const bytes = await readFile(join(root, sourceRel));
  entries[`${SKILL}/${archivePath}`] = [bytes, { mtime: MTIME, os: 3, attrs: ((executable ? 0o100755 : 0o100644) << 16) >>> 0 }];
}

for (const rel of await walk(join(root, "skills-portable", SKILL))) {
  await add(rel.slice(`skills-portable/${SKILL}/`.length), rel, rel.endsWith(".sh"));
}
for (const rel of await walk(join(root, "examples"))) await add(rel, rel);
for (const rel of await walk(join(root, "dist"), (p) => p.startsWith("dist/probe"))) await add(`engine/${rel}`, rel);
for (const rel of await walk(join(root, "assets/themes"))) await add(`engine/${rel}`, rel);
for (const file of ["package.json", "package-lock.json", "scripts/preflight.mjs"]) await add(`engine/${file}`, file);
await add("LICENSE", "LICENSE");

const required = ["SKILL.md", "scripts/setup.sh", "engine/dist/cli/render-deck.js", "engine/dist/mcp/stdio.js", "engine/assets/themes/default.json"];
for (const file of required) if (!entries[`${SKILL}/${file}`]) throw new Error(`Missing ${file}; run npm run build first.`);

const output = resolve(process.argv[2] ?? join(root, "runtime", `marp-ppt-skill-${version}.zip`));
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, zipSync(entries, { level: 6 }));
console.log(`${output} (${Object.keys(entries).length} files)`);
