/**
 * Validate the direct checkpoint read against the real library.
 *
 * The list now reads each session's folded title straight out of its persisted
 * projection checkpoint, guarded by the same identity fields the official
 * `cachedSnapshot` face checks. This proves the guard accepts real rows and
 * rejects a header that does not belong to the row.
 *
 * Read-only. Run: node checkpoint-check.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readCachedTitle } from "./host.js";

const HOME = process.env.DSH_HOME ?? "E:\\DeepSeek Harness";
const state = JSON.parse(readFileSync(join(HOME, "storages", "workspace.json"), "utf8"));
const archived = state.global.archivedSessionIds.map(String);
const cacheDir = join(HOME, "storages", "session_projcache", "sessions");
const framesUrl = pathToFileURL(join(HOME, "profiles/web/node_modules/dsh-session-manager/lib/compat/zstd-frames.js")).href;
const { decompressZstdFrame, scanZstdFrames } = await import(framesUrl);

/** Read one session's durable header without inflating the whole log. */
async function headerOf(id) {
  const root = join(HOME, "sessions");
  for (const project of readdirSync(root)) {
    const directory = join(root, project, id);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
    for (const name of ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl.zstd"]) {
      const file = join(directory, name);
      if (!existsSync(file)) continue;
      const buffer = readFileSync(file);
      const { frames } = scanZstdFrames(buffer, 1);
      if (frames.length === 0) continue;
      const decoded = await decompressZstdFrame(buffer.subarray(frames[0].start, frames[0].end), {});
      const content = decoded.toString("utf8");
      return JSON.parse(content.slice(0, content.indexOf("\n")));
    }
  }
  return undefined;
}

let headers = 0;
let accepted = 0;
let noTitle = 0;
const samples = [];
for (const id of archived) {
  const header = await headerOf(id);
  if (header === undefined) continue;
  headers += 1;
  const title = await readCachedTitle(cacheDir, header);
  if (title === undefined) { noTitle += 1; continue; }
  accepted += 1;
  if (samples.length < 5) samples.push([id, title.slice(0, 40)]);
}
console.log(`sessions with a readable header : ${headers}`);
console.log(`checkpoint titles accepted     : ${accepted}`);
console.log(`headers with no usable title   : ${noTitle}`);
for (const [id, title] of samples) console.log(`  ${id} -> ${title}`);

// The guard must reject a header that does not identify that row.
const firstId = archived.find(id => existsSync(join(cacheDir, `${id}.json`)));
const goodHeader = firstId === undefined ? undefined : await headerOf(firstId);
if (goodHeader !== undefined) {
  const wrongCreatedAt = await readCachedTitle(cacheDir, { ...goodHeader, createdAt: 1 });
  const wrongCwd = await readCachedTitle(cacheDir, { ...goodHeader, cwd: "E:\\definitely-not-this-session" });
  const wrongVersion = await readCachedTitle(cacheDir, { ...goodHeader, version: 3 });
  const missing = await readCachedTitle(cacheDir, { ...goodHeader, id: "session-does-not-exist" });
  console.log(`rejects a wrong createdAt : ${wrongCreatedAt === undefined}`);
  console.log(`rejects a wrong cwd       : ${wrongCwd === undefined}`);
  console.log(`rejects a wrong version   : ${wrongVersion === undefined}`);
  console.log(`rejects an unknown id     : ${missing === undefined}`);
}
