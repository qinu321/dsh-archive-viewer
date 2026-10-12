/**
 * Measure where the archive-list time actually goes.
 *
 * Suspect: folding each archived session's title requires decompressing the
 * whole artifact, and the list route did that for all 52 archived sessions on
 * every request. This measures that cost directly against the real library,
 * plus the cheap alternative (reading the title out of the on-disk projection
 * cache when one exists).
 *
 * Read-only. Run: node perf-probe.mjs
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

const artifacts = [];
for (const id of archived) {
  const path = findArtifact(id);
  if (path !== undefined) artifacts.push({ id, path, bytes: statSync(path).size });
}
const totalBytes = artifacts.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`archived=${archived.length} withArtifact=${artifacts.length} totalBytes=${(totalBytes / 1048576).toFixed(1)}MB`);

// 1. Decompress + fold the title, exactly what readTitleSnapshots must do.
let t0 = Date.now();
let folded = 0;
for (const entry of artifacts) {
  const decoded = await decompressAllZstdFrames(readFileSync(entry.path));
  const lines = decoded.content.toString("utf8").split("\n");
  let title;
  for (const line of lines) {
    if (line === "" || line.charCodeAt(0) !== 123) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "session/title" && typeof event.data?.title === "string") title = event.data.title;
  }
  if (title !== undefined) folded += 1;
}
console.log(`fold titles (full decompress): ${Date.now() - t0}ms for ${artifacts.length} sessions (${folded} with a title event)`);

// 2. The cheap alternative: titles already checkpointed in the projection cache.
const projDir = join(HOME, "storages", "session_projcache", "sessions");
t0 = Date.now();
let cached = 0;
let cachedBytes = 0;
for (const entry of artifacts) {
  const file = join(projDir, `${entry.id}.json`);
  if (!existsSync(file)) continue;
  cached += 1;
  cachedBytes += statSync(file).size;
}
console.log(`projection-cache lookup: ${Date.now() - t0}ms; files present=${cached}/${artifacts.length} (${(cachedBytes / 1048576).toFixed(1)}MB)`);

// What does one cache file look like — is the folded title actually in there?
const sample = artifacts.map(entry => join(projDir, `${entry.id}.json`)).find(file => existsSync(file));
if (sample !== undefined) {
  const raw = readFileSync(sample, "utf8");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  const keys = parsed === undefined ? [] : Object.keys(parsed);
  console.log(`sample cache: ${sample}`);
  console.log(`  ${raw.length} bytes, keys=${JSON.stringify(keys.slice(0, 12))}`);
  const titleHit = raw.match(/"session\/title"|"title"\s*:/);
  console.log(`  contains a title-looking field: ${titleHit === null ? "no" : titleHit[0]}`);
}

// 3. Header-only scans are cheap by comparison (what the artifact index does).
t0 = Date.now();
let headers = 0;
for (const entry of artifacts) {
  const handle = readFileSync(entry.path);
  const frame = handle.subarray(0, 4096);
  headers += frame.length > 0 ? 1 : 0;
}
console.log(`read first 4KB of each artifact: ${Date.now() - t0}ms`);
