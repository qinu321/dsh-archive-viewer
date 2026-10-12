/**
 * How does title cost scale with the number of sessions?
 *
 * The archive list shows one page at a time, so if the fold cost is linear in
 * the number of ids, paging alone fixes the latency at any archive size. If it
 * is a fixed per-call cost, paging does not help and the titles must come from
 * somewhere that does not read logs at all.
 *
 * Read-only. Run: node perf-probe-2.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = process.env.DSH_HOME ?? "E:\\DeepSeek Harness";
const { decompressAllZstdFrames } = await import(pathToFileURL(join(HOME, "profiles/web/node_modules/dsh-session-manager/lib/compat/zstd-frames.js")).href);

const state = JSON.parse(readFileSync(join(HOME, "storages", "workspace.json"), "utf8"));
const archived = state.global.archivedSessionIds.map(String);

function findArtifact(id) {
  const root = join(HOME, "sessions");
  for (const project of readdirSync(root)) {
    const directory = join(root, project, id);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
    for (const name of ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl.zstd", "session.jsonl"]) {
      const path = join(directory, name);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

const withArtifact = archived.filter(id => findArtifact(id) !== undefined);
console.log(`archived=${archived.length} withArtifact=${withArtifact.length}`);

// The per-session cost of decompressing just to find the latest title event.
async function foldOne(id) {
  const path = findArtifact(id);
  if (path === undefined) return undefined;
  const decoded = await decompressAllZstdFrames(readFileSync(path));
  let title;
  for (const line of decoded.content.toString("utf8").split("\n")) {
    if (line === "" || line.charCodeAt(0) !== 123) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "session/title" && typeof event.data?.title === "string") title = event.data.title;
  }
  return title;
}

for (const count of [1, 5, 10, 25, withArtifact.length]) {
  const sample = withArtifact.slice(0, count);
  const started = Date.now();
  for (const id of sample) await foldOne(id);
  const elapsed = Date.now() - started;
  console.log(`fold ${String(count).padStart(3)} sessions: ${String(elapsed).padStart(6)}ms  (${(elapsed / count).toFixed(1)}ms each)`);
}

// How expensive is the cold file-existence walk the artifact index performs?
const started = Date.now();
let found = 0;
for (const id of archived) if (findArtifact(id) !== undefined) found += 1;
console.log(`full artifact lookup for ${archived.length} ids (per-id directory walk): ${Date.now() - started}ms, found ${found}`);

// What a projection-cache file read costs per session (the instant path).
const projDir = join(HOME, "storages", "session_projcache", "sessions");
const startedCache = Date.now();
let titles = 0;
for (const id of archived) {
  const file = join(projDir, `${id}.json`);
  if (!existsSync(file)) continue;
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (typeof record?.record?.rows?.title?.val === "string") titles += 1;
  } catch { /* ignore */ }
}
console.log(`read ${archived.length} projection-cache files: ${Date.now() - startedCache}ms, ${titles} carried a title value`);
