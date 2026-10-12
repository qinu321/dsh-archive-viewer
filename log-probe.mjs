/**
 * Read-only shape probe for the current session log generation.
 *
 * Two questions this answers with data instead of memory:
 *   1. Which event type carries a tool RESULT in this DSH generation
 *      (`tool/result`, `tool/pair`, or both)?
 *   2. What do the injected-context rows look like in practice (how many, and
 *      how much text do they contribute to a transcript)?
 *
 * Reads one archived session artifact from disk. Never writes anything.
 * Run: node log-probe.mjs [sessionId]
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = process.env.DSH_HOME ?? "E:\\DeepSeek Harness";
const { decompressAllZstdFrames } = await import(pathToFileURL(join(HOME, "profiles/web/node_modules/dsh-session-manager/lib/compat/zstd-frames.js")).href);

/** Find one archived session artifact by id. */
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

const requested = process.argv[2];
const state = JSON.parse(readFileSync(join(HOME, "storages", "workspace.json"), "utf8"));
const archived = state.global.archivedSessionIds;
const target = requested ?? [...archived].reverse().find(id => findArtifact(id) !== undefined);
const artifact = findArtifact(target);
if (artifact === undefined) {
  console.log(`no artifact for ${target}`);
  process.exit(1);
}
console.log(`artifact: ${artifact}`);

const decoded = await decompressAllZstdFrames(readFileSync(artifact));
const events = decoded.content.toString("utf8").split("\n").filter(line => line.trim() !== "").map(line => JSON.parse(line));
console.log(`events: ${events.length}`);

const types = new Map();
for (const event of events) types.set(event.type, (types.get(event.type) ?? 0) + 1);
console.log("--- event types ---");
for (const [type, count] of [...types].sort((a, b) => b[1] - a[1])) console.log(`  ${type}: ${count}`);

// Shape of every type whose name suggests it carries a tool outcome.
console.log("--- tool-shaped event shapes (first occurrence each) ---");
const seen = new Set();
for (const event of events) {
  if (!/tool/i.test(event.type) || seen.has(event.type)) continue;
  seen.add(event.type);
  const text = JSON.stringify(event);
  console.log(`\n## ${event.type} (seq ${event.seq}) — ${text.length} bytes`);
  console.log(text.slice(0, 900));
}

// Call-id linkage: how do tool/call events correlate with each result type?
const calls = events.filter(event => event.type === "tool/call");
const linkable = (event) => event.data?.callId ?? event.data?.message?.source?.callId ?? event.data?.call?.callId ?? event.data?.callId;
console.log("--- linkage ---");
console.log(`  tool/call events: ${calls.length}; with data.callId: ${calls.filter(event => typeof event.data?.callId === "string").length}`);
for (const type of types.keys()) {
  if (!/tool/i.test(type) || type === "tool/call") continue;
  const list = events.filter(event => event.type === type);
  const ids = list.map(linkable).filter(id => typeof id === "string");
  const unique = new Set(ids);
  const callIds = new Set(calls.map(event => event.data?.callId).filter(id => typeof id === "string"));
  const matched = [...unique].filter(id => callIds.has(id)).length;
  console.log(`  ${type}: ${list.length} events, ${ids.length} carry a callId, ${unique.size} unique, ${matched} match a tool/call`);
}

// How much of the transcript is injected context, and what labels it uses?
console.log("--- injected user messages ---");
const users = events.filter(event => event.type === "user/message");
const injectedByKind = new Map();
let injectedChars = 0;
let typedChars = 0;
for (const event of users) {
  const text = Array.isArray(event.data?.content)
    ? event.data.content.filter(block => block?.type === "text").map(block => block.text ?? "").join("")
    : "";
  const kind = event.data?.source?.kind ?? "?";
  const looksInjected = text.startsWith("<system-reminder>") || text.startsWith("Current runtime context.");
  if (looksInjected) {
    injectedByKind.set(kind, (injectedByKind.get(kind) ?? 0) + 1);
    injectedChars += text.length;
  } else typedChars += text.length;
}
console.log(`  user/message total: ${users.length}`);
console.log(`  injected (system-reminder / runtime context): ${[...injectedByKind].map(([kind, count]) => `${kind}=${count}`).join(" ") || "none"}`);
console.log(`  chars: injected=${injectedChars} typed=${typedChars}`);
console.log("  first injected sample:");
const firstInjected = users.find(event => {
  const text = Array.isArray(event.data?.content) ? event.data.content.map(block => block.text ?? "").join("") : "";
  return text.startsWith("<system-reminder>") || text.startsWith("Current runtime context.");
});
if (firstInjected !== undefined) {
  const text = firstInjected.data.content.map(block => block.text ?? "").join("");
  console.log(`    seq=${firstInjected.seq} kind=${firstInjected.data?.source?.kind} len=${text.length} head="${text.slice(0, 120).replace(/\n/g, " ")}"`);
}
