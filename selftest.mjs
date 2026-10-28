/**
 * Offline self-test for dsh-archive-viewer.
 *
 * Imports the Host half exactly as the Loader would, drives its route handler
 * through a fake `ctx` and fake req/res pairs, and exercises the transcript
 * fold on synthetic event logs. No Harness runtime required.
 *
 * Live checks (real archive registry + real artifacts) run only when
 * `ARCHIVE_VIEWER_LIVE=1` is set, so the default run stays offline:
 *   node selftest.mjs                 # offline
 *   ARCHIVE_VIEWER_LIVE=1 node selftest.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  API_PREFIX,
  apply,
  archiveMeta,
  assertSessionId,
  assistantParts,
  buildRows,
  configDshHome,
  configExcludedPaths,
  isExcludedWorkspace,
  collectCallMeta,
  contentText,
  isInjectedRow,
  formatToolArgs,
  listArchived,
  resolveDshHome,
  safeErrorMessage,
  sessionWorkspaces,
  indexWorkspaces,
  workspacePathKey
} from "./host.js";

let failures = 0;
const results = [];
function check(label, condition, detail) {
  if (condition) { results.push(`  ok   ${label}`); return; }
  failures += 1;
  results.push(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

// --- 1. sessionId validation ----------------------------------------------
for (const bad of ["", "  ", ".", "..", "a/b", "a\\b", "a:b", "a*b", "x\n"]) {
  let threw = false;
  try { assertSessionId(bad); } catch { threw = true; }
  check(`assertSessionId rejects ${JSON.stringify(bad)}`, threw);
}
check("assertSessionId accepts a real id", assertSessionId("session-12f34548-8cd7-4b58-bbf3-bd1adffd4aed") === "session-12f34548-8cd7-4b58-bbf3-bd1adffd4aed");
check("assertSessionId rejects non-strings", (() => { try { assertSessionId(7); return false; } catch { return true; } })());

// --- 2. config / home resolution ------------------------------------------
check("configDshHome defaults to empty", configDshHome({}) === "");
check("configDshHome passes a string through", configDshHome({ dshHome: "E:\\x" }) === "E:\\x");
check("configDshHome rejects a non-string", (() => { try { configDshHome({ dshHome: 5 }); return false; } catch { return true; } })());
check("resolveDshHome honours an explicit path", resolveDshHome("E:\\DeepSeek Harness") === "E:\\DeepSeek Harness");
check("resolveDshHome expands ~", resolveDshHome("~/dsh-test") === join(homedir(), "dsh-test"));

// --- 2b. tool pairing across the surface view -----------------------------
// The surface view DSH exposes carries tool RESULTS but not the `tool/call`
// events that name the tool: a real archived read returned 91 results with no
// calls, so every row rendered as "unpaired". Call metadata must therefore come
// from the complete log.
const fullLog = [
  { type: "tool/call", seq: 10, time: 1, data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: '{"file_path":"E:\\\\x"}' } },
  { type: "tool/result", seq: 11, time: 2, data: { message: { role: "tool", source: { kind: "tool", callId: "c1" }, content: [{ type: "text", text: "file body" }] } } },
  { type: "tool/call", seq: 12, time: 3, data: { turn: 1, step: 1, callId: "c2", name: "grep", arguments: '{"pattern":"x"}' } },
  { type: "tool/result", seq: 13, time: 4, data: { message: { role: "tool", source: { kind: "tool", callId: "c2" }, content: [{ type: "text", text: "no match" }] } } }
];
const meta = collectCallMeta(fullLog);
check("collectCallMeta indexes every call by callId", meta.size === 2 && meta.get("c1").name === "read" && meta.get("c2").name === "grep", JSON.stringify([...meta]));
check("collectCallMeta keeps the raw argument string", meta.get("c1").arguments === '{"file_path":"E:\\\\x"}', String(meta.get("c1").arguments));

const surfaceOnly = fullLog.filter(event => event.type === "tool/result");
const pairedByMeta = buildRows(surfaceOnly, undefined, { callsById: meta });
check("a surface with only results still names the tool", pairedByMeta.items.length === 2
  && pairedByMeta.items[0].name === "read" && pairedByMeta.items[1].name === "grep",
  JSON.stringify(pairedByMeta.items.map(row => row.name)));
check("a matched result is not flagged as unpaired", pairedByMeta.items.every(row => row.paired === true), JSON.stringify(pairedByMeta.items.map(row => row.paired)));
check("the call arguments come from the log, not the result", pairedByMeta.items[0].args.includes("file_path"), String(pairedByMeta.items[0].args));
check("the tool result body is kept", pairedByMeta.items[0].result === "file body", String(pairedByMeta.items[0].result));

const unknownCall = buildRows([{ type: "tool/result", seq: 5, time: 1, data: { message: { role: "tool", source: { kind: "tool", callId: "nope" }, content: [{ type: "text", text: "orphan" }] } } }], undefined, { callsById: meta });
check("a result with no call anywhere is flagged unpaired", unknownCall.items[0].paired === false, JSON.stringify(unknownCall.items[0]));
check("an unpaired result carries no invented tool name", unknownCall.items[0].name === "", JSON.stringify(unknownCall.items[0].name));

check("isInjectedRow separates injected rows", (() => {
  const rows = buildRows([
    { type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }], source: { kind: "agent-instructions" } } },
    { type: "user/message", seq: 2, time: 2, data: { content: [{ type: "text", text: "typed" }], source: { kind: "user" } } },
    { type: "system/message", seq: 3, time: 3, data: { message: { content: [{ type: "text", text: "system prompt" }] } } }
  ], undefined);
  return rows.items.filter(isInjectedRow).length === 2 && rows.items.filter(row => !isInjectedRow(row)).length === 1;
})());

// --- 2c. internal workbench sessions stay out of the archive list ---------
// The memory plugin's workbench archives and deletes its own sessions, so its
// leftovers are noise here and are the stale ids that cost a fold per request.
const WORKBENCH = "E:\\DeepSeek Harness\\aik_auto_memory_use";
const debugPath = "E:\\codeVibe\\debug";
check("a workbench session is excluded by default", isExcludedWorkspace(WORKBENCH, configExcludedPaths({})) === true);
check("an ordinary workspace is kept", isExcludedWorkspace(debugPath, configExcludedPaths({})) === false);
check("a path with forward slashes and a trailing slash still matches",
  isExcludedWorkspace("E:/DeepSeek Harness/aik_auto_memory_use/", configExcludedPaths({})) === true);
check("the comparison ignores drive-letter case",
  isExcludedWorkspace("e:\\deepseek harness\\AIK_AUTO_MEMORY_USE", configExcludedPaths({})) === true);
check("a partial word does not match", isExcludedWorkspace("E:\\x\\aik_auto_memory_use_backup", configExcludedPaths({})) === false);
check("a nested path under the excluded root matches",
  isExcludedWorkspace("E:\\codeVibe\\tmp\\aik_auto_memory_use\\sub", configExcludedPaths({})) === true);
check("an empty or missing cwd is never excluded",
  isExcludedWorkspace(undefined, configExcludedPaths({})) === false && isExcludedWorkspace("", configExcludedPaths({})) === false);
check("an explicit empty list disables the exclusion", isExcludedWorkspace(WORKBENCH, configExcludedPaths({ excludeWorkspacePaths: [] })) === false);
check("extra paths append to the default", isExcludedWorkspace("E:\\codeVibe\\scratch", configExcludedPaths({ excludeWorkspacePaths: ["E:\\codeVibe\\scratch"] })) === true);
check("a non-array exclusion config is rejected", (() => { try { configExcludedPaths({ excludeWorkspacePaths: "x" }); return false; } catch { return true; } })());

// --- 3. transcript fold ---------------------------------------------------
const synthetic = [
  { type: "user/message", seq: 1, time: 1000, data: { content: [{ type: "text", text: "hello" }], source: { kind: "user" } } },
  { type: "user/message", seq: 2, time: 1001, data: { content: [{ type: "text", text: "injected" }], source: { kind: "user-approval" } } },
  {
    type: "assistant/message", seq: 3, time: 1002,
    data: {
      turn: 1, step: 1, interrupted: false,
      message: { role: "assistant", content: [{ type: "text", text: "fallback" }], source: { kind: "model", provider: "p", model: "m" } },
      stream: [
        { type: "reasoning-chunks", time0: 0, index: 0, dt: [1], texts: ["think "] },
        { type: "text-chunks", time0: 0, index: 1, dt: [1], texts: ["say hi"] },
        { type: "tool-call-chunks", time0: 0, index: 2, dt: [1], id: "c1", args: ["{}"] }
      ],
      usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2 }
    }
  },
  { type: "tool/call", seq: 4, time: 1003, data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: "{\"path\":\"a\"}" } },
  { type: "tool/result", seq: 5, time: 1004, data: { turn: 1, step: 1, message: { role: "tool", source: { kind: "tool", callId: "c1" }, content: [{ type: "text", text: "file body" }] } } },
  { type: "tool/result", seq: 6, time: 1005, data: { turn: 1, step: 1, message: { role: "tool", source: { kind: "tool", callId: "gone" }, content: [{ type: "text", text: "orphan" }] }, error: { name: "Boom", code: "E1" } } },
  { type: "turn/start", seq: 7, time: 1006, data: { turn: 1 } },
  { type: "turn/end", seq: 8, time: 1007, data: { turn: 1, reason: { kind: "completed" } } },
  { type: "session/title", seq: 9, time: 1008, data: { title: "T", messageSeqs: [1], source: { kind: "user" } } },
  { type: "working-directory/change", seq: 10, time: 1009, data: { cwd: "E:\\x" } }
];
const built = buildRows(synthetic, { id: "s1", version: 4, createdAt: 999, cwd: "E:\\x", isSeeded: false, agentPreset: "standard" });
const kinds = built.items.map(item => item.kind);
check("fold keeps every renderable row", built.items.length === 9, JSON.stringify(kinds));
check("user row carries the message text", built.items[0].kind === "user" && built.items[0].text === "hello");
check("injected user-approval becomes an injected row", built.items[1].kind === "injected" && built.items[1].label === "user-approval");
const contextRows = buildRows([
  { type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "<system-reminder>rules</system-reminder>" }], source: { kind: "user" } } },
  { type: "user/message", seq: 2, time: 2, data: { content: [{ type: "text", text: "Current runtime context. cwd: E:\\x" }], source: { kind: "user" } } },
  { type: "user/message", seq: 3, time: 3, data: { content: [{ type: "text", text: "真正手打的话" }], source: { kind: "user" } } }
], undefined);
check("system-reminder and runtime-context messages are labelled injected", contextRows.items.filter(item => item.kind === "injected").length === 2, JSON.stringify(contextRows.items.map(item => item.kind)));
check("a typed prompt stays a user row", contextRows.items.filter(item => item.kind === "user").length === 1 && contextRows.items.find(item => item.kind === "user").text === "真正手打的话");
const assistant = built.items[2];
check("assistant text comes from the stream, not the message fallback", assistant.text === "say hi", JSON.stringify(assistant.text));
check("assistant reasoning comes from the stream", assistant.reasoning === "think ", JSON.stringify(assistant.reasoning));
check("assistant keeps model identity", assistant.model === "m" && assistant.provider === "p");
check("assistant usage is carried", assistant.usage.input === 10 && assistant.usage.reasoning === 2);
const tool1 = built.items[3];
check("tool call is rendered as a tool row", tool1.kind === "tool" && tool1.name === "read");
check("tool arguments are pretty-printed", tool1.args.includes("\n  \"path\": \"a\""), JSON.stringify(tool1.args));
check("tool call is paired with its result", tool1.result === "file body", JSON.stringify(tool1.result));
check("paired result is not rendered twice", built.items.filter(item => item.result === "file body").length === 1);
const orphan = built.items.find(item => item.result === "orphan");
check("unpaired result is rendered with its error", orphan !== undefined && String(orphan.error).startsWith("Boom"), JSON.stringify(orphan));
const paired = built.items.find(item => item.result === "file body");
check("a paired result carries no error", paired !== undefined && paired.error === undefined, JSON.stringify(paired));
check("turn rows are rendered", built.items.some(item => item.kind === "turn" && item.phase === "end" && item.reason === "completed"));
check("title event becomes a title row", built.items.some(item => item.kind === "title" && item.text === "T"));
check("cwd change becomes a notice row", built.items.some(item => item.kind === "notice" && item.label === "cwd" && item.text === "E:\\x"), JSON.stringify(built.items.filter(item => item.kind === "notice")));
check("header is echoed into the payload", built.header.id === "s1" && built.header.cwd === "E:\\x");

const clipped = buildRows([{ type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "x".repeat(9000) }], source: { kind: "user" } } }], undefined);
check("long blocks are clipped with a marker", clipped.items[0].text.length < 9000 && clipped.items[0].text.includes("已截断"));

const many = buildRows(Array.from({ length: 1300 }, (_, index) => ({
  type: "user/message", seq: index, time: index, data: { content: [{ type: "text", text: `m${index}` }], source: { kind: "user" } }
})), undefined);
check("row cap truncates and reports it", many.truncated === true && many.items.length === 1200 && many.rowCount === 1300);
check("truncation keeps the newest rows", many.items[many.items.length - 1].text === "m1299");

// --- 4. helpers -----------------------------------------------------------
check("assistantParts tolerates a missing stream", assistantParts(undefined).text === "" && assistantParts(undefined).reasoning === "");
check("contentText names unknown block kinds", contentText([{ type: "weird" }]) === "[weird]");
check("contentText describes images and files", contentText([{ type: "image", attachment: { name: "a.png" } }, { type: "file", attachment: { name: "b.txt" } }]).includes("[图片 a.png]"));
check("formatToolArgs keeps non-JSON verbatim", formatToolArgs("not json") === "not json");
check("formatToolArgs pretty-prints JSON", formatToolArgs('{"a":1}') === '{\n  "a": 1\n}');
check("safeErrorMessage prefers message", safeErrorMessage(new Error("boom")) === "boom");
check("safeErrorMessage survives null", safeErrorMessage(null) === "<nullish:object>");

// --- 5. routes ------------------------------------------------------------
function fakeReq(url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return {
    url,
    method: body === undefined ? "GET" : "POST",
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; }
  };
}
function fakeRes() {
  const captured = { status: 0, body: "", headers: {} };
  return {
    captured,
    setHeader(name, value) { captured.headers[name] = value; },
    set statusCode(value) { captured.status = value; },
    get statusCode() { return captured.status; },
    end(text) { captured.body = text; }
  };
}

const ARCHIVED_ID = "session-archived-1";
const LIVE_ID = "session-live-1";
const unarchived = [];
let routeHandler;
const fakeCtx = {
  webServer: { register(definition) { routeHandler = definition.handler; return () => {}; } },
  effect(callback) { callback(); return () => {}; },
  get(key) { return key === "sessionQuery" ? fakeCtx.sessionQuery : undefined; },
  workspaceRegistry: {
    archivedSessionIds: [ARCHIVED_ID],
    list: () => [{ id: "ws-1", title: "调试工作区", path: "E:\\codeVibe\\debug", sessionIds: [ARCHIVED_ID] }],
    // The in-memory header index the Client-side list's metadata answer reads:
    // no disk I/O, and the only source of `createdAt` on this side.
    headers: new Map([[ARCHIVED_ID, { id: ARCHIVED_ID, createdAt: 111, cwd: "E:\\codeVibe\\debug" }]]),
    unarchiveSession: async (id) => { unarchived.push(id); }
  },
  sessionQuery: {
    filterSessions: async () => [{ header: { id: ARCHIVED_ID, cwd: "E:\\codeVibe\\debug", createdAt: 111, agentPreset: "standard" }, live: false, persisted: true }],
    readTitleSnapshots: async () => [{ sessionId: ARCHIVED_ID, status: "fulfilled", value: { title: { title: "归档的会话" } } }],
    readSession: async () => ({
      session: { id: ARCHIVED_ID, version: 4, createdAt: 111, cwd: "E:\\codeVibe\\debug", isSeeded: false },
      events: synthetic
    }),
    readSurface: async () => ({ events: synthetic })
  }
};
apply(fakeCtx, { dshHome: "E:\\nonexistent-dsh-home-for-tests" });
check("route handler registered", typeof routeHandler === "function");

async function call(url, body) {
  const res = fakeRes();
  await routeHandler(fakeReq(url, body), res);
  let parsed;
  try { parsed = JSON.parse(res.captured.body); } catch { parsed = undefined; }
  return { status: res.captured.status, payload: parsed };
}

const routed = await call(`${API_PREFIX}/sessions`);
check("GET /sessions answers 200", routed.status === 200 && routed.payload?.ok === true, JSON.stringify(routed.payload));
check("list carries registry membership", routed.payload.result.archivedCount === 1 && routed.payload.result.sessions[0].id === ARCHIVED_ID);
check("list carries the workspace title", routed.payload.result.sessions[0].workspaceTitle === "调试工作区");
check("list carries the folded title", routed.payload.result.sessions[0].title === "归档的会话");
check("list reports a missing artifact honestly", routed.payload.result.sessions[0].persisted === true && routed.payload.result.sessions[0].bytes === undefined);

const transcript = await call(`${API_PREFIX}/transcript?sessionId=${encodeURIComponent(ARCHIVED_ID)}`);
check("GET /transcript answers 200", transcript.status === 200 && transcript.payload?.ok === true, JSON.stringify(transcript.payload).slice(0, 200));
check("transcript reports the surface path", transcript.payload.result.surfaceAvailable === true);
check("transcript carries the folded rows", transcript.payload.result.items.length === 9);
check("transcript aggregates usage", transcript.payload.result.usage.calls === 1 && transcript.payload.result.usage.input === 10);

const refused = await call(`${API_PREFIX}/transcript?sessionId=${encodeURIComponent(LIVE_ID)}`);
check("reading a non-archived session is refused", refused.status === 409 && refused.payload?.ok === false, JSON.stringify(refused.payload));

const badId = await call(`${API_PREFIX}/transcript?sessionId=${encodeURIComponent("../escape")}`);
check("a path-shaped id is rejected as a bad request", badId.status === 400, JSON.stringify(badId.payload));

const workspaces = await call(`${API_PREFIX}/workspaces`);
check("GET /workspaces lists registry workspaces", workspaces.payload.result.items[0].title === "调试工作区");

// --- 4a. the Client-held list's metadata answer ----------------------------
// The list itself no longer comes from the Host: the Client derives it from
// DSH's own sessions/workspaces snapshots. These are the only facts it cannot
// see there, and they are asked for once, over the whole archive set — never
// per page. That is what removes the 500-row ceiling instead of raising it.
const metaRoute = await call(`${API_PREFIX}/meta`);
check("GET /meta answers 200", metaRoute.status === 200 && metaRoute.payload?.ok === true, JSON.stringify(metaRoute.payload));
check("meta carries createdAt from the registry header index",
  metaRoute.payload.result.createdAt[ARCHIVED_ID] === 111, JSON.stringify(metaRoute.payload.result.createdAt));
check("meta omits a size for a session with no artifact on disk",
  metaRoute.payload.result.bytes[ARCHIVED_ID] === undefined, JSON.stringify(metaRoute.payload.result.bytes));
check("meta reports the internal-machinery exclusion set",
  Array.isArray(metaRoute.payload.result.excluded) && metaRoute.payload.result.excluded.length === 0,
  JSON.stringify(metaRoute.payload.result.excluded));
check("meta counts the archive set it answered for", metaRoute.payload.result.archivedIdCount === 1,
  String(metaRoute.payload.result.archivedIdCount));

const metaHeaders = new Map([
  ["session-a", { id: "session-a", createdAt: 1500, cwd: "E:\\codeVibe\\debug" }],
  ["session-old", { id: "session-old", createdAt: "2026-01-02T03:04:05.000Z", cwd: "E:\\codeVibe\\temp" }],
  ["session-workbench", { id: "session-workbench", createdAt: 900, cwd: "E:\\DeepSeek Harness\\aik_auto_memory_use" }]
]);
const metaArtifacts = new Map([
  ["session-a", { path: "a", bytes: 4096, mtime: 7000, project: "debug" }],
  ["session-noheader", { path: "b", bytes: 12, mtime: 8000, project: "aik_auto_memory_use" }]
]);
const metaPure = archiveMeta({
  workspaceRegistry: { archivedSessionIds: ["session-a", "session-old", "session-workbench", "session-noheader", "session-stale"], headers: metaHeaders },
  artifactIndex: metaArtifacts,
  excludedPaths: configExcludedPaths({})
});
check("meta reads createdAt for the ids the header index knows",
  metaPure.createdAt["session-a"] === 1500 && metaPure.createdAt["session-old"] === Date.parse("2026-01-02T03:04:05.000Z"),
  JSON.stringify(metaPure.createdAt));
check("meta normalizes an ISO createdAt to epoch milliseconds",
  typeof metaPure.createdAt["session-old"] === "number" && Number.isFinite(metaPure.createdAt["session-old"]),
  String(metaPure.createdAt["session-old"]));
check("meta carries the artifact size and mtime for one session",
  metaPure.bytes["session-a"] === 4096 && metaPure.mtime["session-a"] === 7000,
  JSON.stringify([metaPure.bytes, metaPure.mtime]));
check("meta leaves a stale archived id out of every map",
  metaPure.createdAt["session-stale"] === undefined && metaPure.bytes["session-stale"] === undefined,
  JSON.stringify([metaPure.createdAt, metaPure.bytes]));
check("meta excludes internal machinery by its header cwd",
  metaPure.excluded.includes("session-workbench"), JSON.stringify(metaPure.excluded));
check("meta falls back to the artifact project directory when a header is missing",
  metaPure.excluded.includes("session-noheader"), JSON.stringify(metaPure.excluded));
check("meta keeps a real session that simply has no header",
  metaPure.bytes["session-noheader"] === 12 && metaPure.createdAt["session-noheader"] === undefined,
  JSON.stringify(metaPure.bytes));
const metaObjectHeaders = archiveMeta({
  workspaceRegistry: { archivedSessionIds: ["session-a"], headers: { "session-a": { createdAt: 42 } } },
  artifactIndex: new Map(),
  excludedPaths: []
});
check("meta accepts a plain-object header index as well as a Map",
  metaObjectHeaders.createdAt["session-a"] === 42, JSON.stringify(metaObjectHeaders));
check("meta survives a registry without a header index at all",
  JSON.stringify(archiveMeta({ workspaceRegistry: { archivedSessionIds: ["x"] }, artifactIndex: new Map(), excludedPaths: [] }).createdAt) === "{}",
  "createdAt should stay empty rather than throw");

// The route-level workspace filter: the reader's selector addresses the list
// through this parameter, and the response says which filter it applied.
const routeFiltered = await call(`${API_PREFIX}/sessions?workspace=ws-1`);
check("GET /sessions accepts a workspace filter",
  routeFiltered.status === 200 && routeFiltered.payload.result.sessions.length === 1
  && routeFiltered.payload.result.workspace === "ws-1", JSON.stringify(routeFiltered.payload.result.workspace));
check("the filtered list carries the workspace options",
  JSON.stringify(routeFiltered.payload.result.workspaceOptions.map(option => [option.id, option.title, option.count]))
  === JSON.stringify([["ws-1", "调试工作区", 1]]),
  JSON.stringify(routeFiltered.payload.result.workspaceOptions));
const routeUnmatched = await call(`${API_PREFIX}/sessions?workspace=ws-other`);
check("a workspace with no archived session answers with an empty list",
  routeUnmatched.status === 200 && routeUnmatched.payload.result.sessions.length === 0
  && routeUnmatched.payload.result.total === 0, JSON.stringify(routeUnmatched.payload.result.total));
const routeUnfiltered = await call(`${API_PREFIX}/sessions`);
check("no workspace parameter means the whole archive", routeUnfiltered.payload.result.workspace === "", JSON.stringify(routeUnfiltered.payload.result.workspace));

const restored = await call(`${API_PREFIX}/unarchive`, { sessionId: ARCHIVED_ID });
check("POST /unarchive calls the registry", restored.status === 200 && unarchived.length === 1 && unarchived[0] === ARCHIVED_ID);

const unknown = await call(`${API_PREFIX}/nope`);
check("an unknown endpoint answers 404", unknown.status === 404);
const diagPost = await call(`${API_PREFIX}/diagnostic`, { stage: "factory:start", at: "now" });
check("POST /diagnostic stores a page report", diagPost.status === 200 && diagPost.payload?.result?.stored === true, JSON.stringify(diagPost.payload));
const diagGet = await call(`${API_PREFIX}/diagnostic`);
check("GET /diagnostic returns the last report", diagGet.payload?.result?.report?.stage === "factory:start", JSON.stringify(diagGet.payload).slice(0, 160));

const brokenQuery = { ...fakeCtx, sessionQuery: { ...fakeCtx.sessionQuery, readSession: async () => { throw new Error("log unreadable"); } } };
let brokenHandler;
apply({ ...brokenQuery, webServer: { register(definition) { brokenHandler = definition.handler; return () => {}; } }, effect(callback) { callback(); return () => {}; }, get: (key) => (key === "sessionQuery" ? brokenQuery.sessionQuery : undefined) }, { dshHome: "E:\\nonexistent" });
const failed = fakeRes();
await brokenHandler(fakeReq(`${API_PREFIX}/transcript?sessionId=${encodeURIComponent(ARCHIVED_ID)}`), failed);
const failedPayload = JSON.parse(failed.captured.body);
check("a read failure is reported, not thrown", failedPayload.ok === false && failedPayload.error.includes("log unreadable"), failed.captured.body.slice(0, 160));

// The list itself must drop them and report how many it dropped.
const mixedIds = ["session-keep", "session-workbench"];
const mixedQuery = {
  ...fakeCtx.sessionQuery,
  filterSessions: async (filters) => (filters[0]?.values ?? []).map(id => ({
    header: { id, cwd: id === "session-workbench" ? WORKBENCH : debugPath, createdAt: 5, version: 4, isSeeded: false },
    live: false,
    persisted: true
  })),
  readTitleSnapshots: async (ids) => ids.map(id => ({ sessionId: id, status: "fulfilled", value: { title: { title: `t-${id}` } } }))
};
const filtered = await listArchived({
  workspaceRegistry: { archivedSessionIds: mixedIds, list: () => [] },
  sessionQuery: mixedQuery,
  sessionsRoot: "unused",
  artifactIndex: new Map(mixedIds.map(id => [id, { path: id, bytes: 5, mtime: 1, project: "p" }])),
  titleCache: new Map(),
  projectionCache: undefined,
  excludedPaths: configExcludedPaths({})
});
check("the workbench session is not listed", filtered.sessions.length === 1 && filtered.sessions[0].id === "session-keep",
  JSON.stringify(filtered.sessions.map(session => session.id)));
check("the hidden count is reported", filtered.hiddenCount === 1, String(filtered.hiddenCount));
check("the archive-set size is still reported", filtered.archivedIdCount === 2, String(filtered.archivedIdCount));
check("an excluded session is never folded", filtered.sessions.every(session => session.id !== "session-workbench"));

// --- 5b-2. leftover archive-set ids can be cleaned up ----------------------
// An id can stay in the archive set after its session is gone everywhere
// (directory, persistence record, checkpoint). DSH's own session manager lists
// sessions from the persistence index, so it cannot even show such a row; this
// list reports set membership, so it must offer the one honest action.
const GHOST_ID = "session-does-not-exist";
const forgetCalls = [];
const forgetCtx = {
  ...fakeCtx,
  workspaceRegistry: {
    archivedSessionIds: [ARCHIVED_ID, GHOST_ID],
    list: () => [],
    unarchiveSession: async (id) => { forgetCalls.push(id); }
  },
  sessionQuery: {
    ...fakeCtx.sessionQuery,
    // The ghost has no record; the real session does.
    filterSessions: async (filters) => (filters[0]?.values ?? []).filter(id => id === ARCHIVED_ID).map(id => ({ header: { id, cwd: "E:\\codeVibe\\debug", createdAt: 1, version: 4, isSeeded: false }, live: false, persisted: true }))
  }
};
let forgetHandler;
apply({ ...forgetCtx, webServer: { register(definition) { forgetHandler = definition.handler; return () => {}; } }, effect(callback) { callback(); return () => {}; }, get: (key) => (key === "sessionQuery" ? forgetCtx.sessionQuery : undefined) }, { dshHome: "E:\\nonexistent" });

async function callOn(handler, url, body) {
  const res = fakeRes();
  await handler(fakeReq(url, body), res);
  return { status: res.captured.status, payload: JSON.parse(res.captured.body) };
}

const ghost = await callOn(forgetHandler, `${API_PREFIX}/forget`, { sessionId: GHOST_ID });
check("a leftover id is removed from the archive set", ghost.status === 200 && ghost.payload?.result?.forgotten === true, JSON.stringify(ghost.payload));
check("cleanup unarchives exactly that id", forgetCalls.length === 1 && forgetCalls[0] === GHOST_ID, JSON.stringify(forgetCalls));

const existing = await callOn(forgetHandler, `${API_PREFIX}/forget`, { sessionId: ARCHIVED_ID });
check("a session that still exists is refused", existing.status === 409 && existing.payload?.code === "session-exists", JSON.stringify(existing.payload));
check("a refused cleanup writes nothing", forgetCalls.length === 1, JSON.stringify(forgetCalls));

const badForget = await callOn(forgetHandler, `${API_PREFIX}/forget`, { sessionId: "../etc" });
check("a path-shaped cleanup target is rejected", badForget.status === 400, JSON.stringify(badForget.payload));

// --- 5c. title folding is cached against the artifact fingerprint ----------
// The list route used to decompress every archived artifact on every request
// (~2.3s for 63.9MB here). Folding must now happen once per unchanged log.
const foldCalls = [];
const cacheQuery = {
  ...fakeCtx.sessionQuery,
  readTitleSnapshots: async (ids) => {
    foldCalls.push([...ids]);
    return ids.map(id => ({ sessionId: id, status: "fulfilled", value: { title: { title: `t-${foldCalls.length}` } } }));
  }
};
const cacheArtifacts = new Map([[ARCHIVED_ID, { path: "x", bytes: 100, mtime: 1000, project: "p" }]]);
const registry = fakeCtx.workspaceRegistry;
const titleCache = new Map();

const first = await listArchived({ workspaceRegistry: registry, sessionQuery: cacheQuery, sessionsRoot: "unused", artifactIndex: cacheArtifacts, titleCache });
check("the first list folds the title", foldCalls.length === 1 && foldCalls[0].length === 1, JSON.stringify(foldCalls));
check("the folded title is returned", first.sessions[0].title === "t-1", String(first.sessions[0].title));
check("the first list reports a cache miss", first.timings.titleCacheMisses === 1 && first.timings.titleCacheHits === 0, JSON.stringify(first.timings));

const second = await listArchived({ workspaceRegistry: registry, sessionQuery: cacheQuery, sessionsRoot: "unused", artifactIndex: cacheArtifacts, titleCache });
check("an unchanged log is not re-folded", foldCalls.length === 1, `folds=${foldCalls.length}`);
check("the cached title is served", second.sessions[0].title === "t-1", String(second.sessions[0].title));
check("the second list reports a cache hit with no fold time", second.timings.titleCacheHits === 1 && second.timings.foldMs === 0, JSON.stringify(second.timings));

const rewritten = new Map([[ARCHIVED_ID, { path: "x", bytes: 120, mtime: 2000, project: "p" }]]);
const third = await listArchived({ workspaceRegistry: registry, sessionQuery: cacheQuery, sessionsRoot: "unused", artifactIndex: rewritten, titleCache });
check("a rewritten log is folded again", foldCalls.length === 2, `folds=${foldCalls.length}`);
check("the refolded title replaces the cached one", third.sessions[0].title === "t-2", String(third.sessions[0].title));

// --- 5d. the checkpoint path must avoid the fold entirely ------------------
// This is the path DSH's own session list uses (zero-I/O listing read). When a
// matching checkpoint exists, the list must not touch the log at all.
const checkpointFolds = [];
const checkpointQuery = {
  ...fakeCtx.sessionQuery,
  readTitleSnapshots: async (ids) => { checkpointFolds.push([...ids]); return []; }
};
const checkpointCache = {
  cachedSnapshot: (header) => (String(header.id) === ARCHIVED_ID ? { asOfSeq: 5, values: { title: { title: "来自检查点的标题" } } } : undefined)
};
const fastList = await listArchived({
  workspaceRegistry: registry,
  sessionQuery: checkpointQuery,
  sessionsRoot: "unused",
  artifactIndex: cacheArtifacts,
  titleCache: new Map(),
  projectionCache: checkpointCache
});
check("a checkpoint title is used as-is", fastList.sessions[0].title === "来自检查点的标题", String(fastList.sessions[0].title));
check("a checkpoint title needs no fold", checkpointFolds.length === 0, `folds=${JSON.stringify(checkpointFolds)}`);
check("the checkpoint path reports zero fold time", fastList.timings.foldMs === 0, JSON.stringify(fastList.timings));
check("the title is labelled as coming from the checkpoint", fastList.sessions[0].titleSource === "checkpoint", String(fastList.sessions[0].titleSource));

// A session the checkpoint does not cover still falls back to the fold.
const partial = await listArchived({
  workspaceRegistry: { ...registry, archivedSessionIds: [ARCHIVED_ID, "session-other"] },
  sessionQuery: { ...checkpointQuery, readTitleSnapshots: async (ids) => { checkpointFolds.push([...ids]); return ids.map(id => ({ sessionId: id, status: "fulfilled", value: { title: { title: "折叠标题" } } })); } },
  sessionsRoot: "unused",
  artifactIndex: new Map([...cacheArtifacts, ["session-other", { path: "y", bytes: 10, mtime: 5, project: "p" }]]),
  titleCache: new Map(),
  projectionCache: checkpointCache
});
check("only the uncovered session is folded", checkpointFolds.length === 1 && checkpointFolds[0].length === 1 && checkpointFolds[0][0] === "session-other", JSON.stringify(checkpointFolds));
check("both sessions end up with titles", partial.sessions.every(session => session.title !== ""), JSON.stringify(partial.sessions.map(session => [session.id, session.title, session.titleSource])));

// Our own fingerprint-verified fold outranks the on-disk checkpoint.
const fingerprintCache = new Map([[ARCHIVED_ID, { title: "日志里更新的标题", mtimeMs: 1000, bytes: 100 }]]);
const fresh = await listArchived({
  workspaceRegistry: registry,
  sessionQuery: checkpointQuery,
  sessionsRoot: "unused",
  artifactIndex: cacheArtifacts,
  titleCache: fingerprintCache,
  projectionCache: undefined
});
check("a fingerprint-fresh fold wins over the on-disk checkpoint", fresh.sessions[0].title === "日志里更新的标题" && fresh.sessions[0].titleSource === "fold",
  JSON.stringify([fresh.sessions[0].title, fresh.sessions[0].titleSource]));

// A live checkpoint beats a fold of ours that the checkpoint has since passed:
// the live table is runtime state, the fold is a snapshot of the log we read.
const both = await listArchived({
  workspaceRegistry: registry,
  sessionQuery: checkpointQuery,
  sessionsRoot: "unused",
  artifactIndex: cacheArtifacts,
  titleCache: fingerprintCache,
  projectionCache: checkpointCache
});
check("the live checkpoint wins when both know a title", both.sessions[0].title === "来自检查点的标题" && both.sessions[0].titleSource === "checkpoint",
  JSON.stringify([both.sessions[0].title, both.sessions[0].titleSource]));

// --- 5e. paging bounds the per-session work -------------------------------
// Latency must not grow with the archive: only the requested page may be
// resolved, and the fold must never see an id outside it.
const manyIds = ["session-a", "session-b", "session-c", "session-d", "session-e", "session-f"];
const manyArtifacts = new Map(manyIds.map((id, index) => [id, { path: id, bytes: 10, mtime: index + 1, project: "p" }]));
const manyQuery = {
  ...fakeCtx.sessionQuery,
  filterSessions: async (filters) => (filters[0]?.values ?? []).map(id => ({ header: { id, cwd: "E:\\\\x", createdAt: 100, agentPreset: "standard", version: 4, isSeeded: false }, live: false, persisted: true })),
  readTitleSnapshots: async (ids) => ids.map(id => ({ sessionId: id, status: "fulfilled", value: { title: { title: `folded-${id}` } } }))
};
const paged = await listArchived({
  workspaceRegistry: { archivedSessionIds: manyIds, list: () => [] },
  sessionQuery: manyQuery,
  sessionsRoot: "unused",
  artifactIndex: manyArtifacts,
  titleCache: new Map(),
  projectionCache: undefined,
  page: 2
});
check("a page returns only the requested size", paged.sessions.length === 2, String(paged.sessions.length));
check("a page never folds a session outside it", paged.sessions.every(session => manyIds.slice(0, 2).includes(session.id)), JSON.stringify(paged.sessions.map(session => session.id)));
check("the total still reports the whole archive", paged.total === 6 && paged.archivedCount === 6, JSON.stringify([paged.total, paged.archivedCount]));
check("hasMore marks that another page exists", paged.hasMore === true);
check("the timings show the page size", paged.timings.pageIds === 2, JSON.stringify(paged.timings));

const lastPage = await listArchived({
  workspaceRegistry: { archivedSessionIds: manyIds, list: () => [] },
  sessionQuery: manyQuery,
  sessionsRoot: "unused",
  artifactIndex: manyArtifacts,
  titleCache: new Map(),
  projectionCache: undefined,
  page: 6
});
check("the last page reports no more", lastPage.hasMore === false && lastPage.sessions.length === 6, JSON.stringify([lastPage.hasMore, lastPage.sessions.length]));

const capped = await listArchived({
  workspaceRegistry: { archivedSessionIds: manyIds, list: () => [] },
  sessionQuery: manyQuery,
  sessionsRoot: "unused",
  artifactIndex: manyArtifacts,
  titleCache: new Map(),
  projectionCache: undefined,
  page: 100000
});
check("an oversized page request is capped, not honoured", capped.sessions.length === 6, String(capped.sessions.length));

// --- 5f. workspace filtering ----------------------------------------------
// The reader's workspace selector is answered here, over the WHOLE archive set
// and before paging: a filter applied to the loaded page would under-report any
// workspace holding more sessions than one page.
check("separators and trailing slashes do not change a path key",
  workspacePathKey("E:\\codeVibe\\debug\\") === workspacePathKey("E:/codeVibe/debug")
  && workspacePathKey("E:/codeVibe/debug") === "e:/codevibe/debug", workspacePathKey("E:\\codeVibe\\debug\\"));
check("a posix path keeps its case", workspacePathKey("/Home/Kano/Repo/") === "/Home/Kano/Repo", workspacePathKey("/Home/Kano/Repo/"));
check("an empty or non-string path has no key",
  workspacePathKey("") === "" && workspacePathKey(undefined) === "" && workspacePathKey(null) === "");

const wsIndex = indexWorkspaces([
  { id: "ws-debug", title: "debug", path: "E:\\codeVibe\\debug", sessionIds: ["session-member"] },
  { id: "ws-temp", title: "temp", path: "E:/codeVibe/temp/", sessionIds: [] }
]);
check("registry membership is the first answer",
  [...sessionWorkspaces("session-member", "E:\\somewhere\\else", wsIndex)].join(",") === "ws-debug",
  JSON.stringify([...sessionWorkspaces("session-member", "E:\\somewhere\\else", wsIndex)]));
check("an unaccounted session falls back to its cwd",
  [...sessionWorkspaces("session-old", "E:\\codeVibe\\temp", wsIndex)].join(",") === "ws-temp",
  JSON.stringify([...sessionWorkspaces("session-old", "E:\\codeVibe\\temp", wsIndex)]));
check("a session matching neither tier is ungrouped",
  sessionWorkspaces("session-orphan", "E:\\elsewhere", wsIndex).size === 0);
check("a session with no cwd at all is ungrouped", sessionWorkspaces("session-nocwd", undefined, wsIndex).size === 0);

const wsIds = ["session-m1", "session-m2", "session-old", "session-orphan"];
const wsArtifacts = new Map(wsIds.map((id, index) => [id, { path: id, bytes: 10, mtime: index + 1, project: "p" }]));
const wsQuery = {
  ...fakeCtx.sessionQuery,
  filterSessions: async (filters) => (filters[0]?.values ?? []).map(id => ({
    header: {
      id,
      // Only the "old" session is placed by its directory; the others are
      // placed by registry membership, and one by nothing at all.
      cwd: id === "session-old" ? "E:\\codeVibe\\temp" : id === "session-orphan" ? "E:\\elsewhere" : "E:\\codeVibe\\debug",
      createdAt: 100, version: 4, isSeeded: false
    },
    live: false,
    persisted: true
  })),
  readTitleSnapshots: async (ids) => ids.map(id => ({ sessionId: id, status: "fulfilled", value: { title: { title: `t-${id}` } } }))
};
const wsRegistry = {
  archivedSessionIds: wsIds,
  list: () => [
    { id: "ws-debug", title: "debug", path: "E:\\codeVibe\\debug", sessionIds: ["session-m1", "session-m2"] },
    { id: "ws-temp", title: "temp", path: "E:\\codeVibe\\temp", sessionIds: [] }
  ]
};
const listFor = (options = {}) => listArchived({
  workspaceRegistry: wsRegistry,
  sessionQuery: wsQuery,
  sessionsRoot: "unused",
  artifactIndex: wsArtifacts,
  titleCache: new Map(),
  projectionCache: undefined,
  excludedPaths: configExcludedPaths({}),
  ...options
});

const everything = await listFor();
check("with no filter every session is listed", everything.sessions.length === 4 && everything.total === 4, String(everything.total));
check("the unfiltered size is reported next to it", everything.visibleTotal === 4, String(everything.visibleTotal));
check("the applied filter is echoed as empty", everything.workspace === "", JSON.stringify(everything.workspace));
check("the options count each workspace's archived sessions",
  JSON.stringify(everything.workspaceOptions.map(option => [option.id, option.title, option.count]))
  === JSON.stringify([["ws-debug", "debug", 2], ["ws-temp", "temp", 1]]),
  JSON.stringify(everything.workspaceOptions));
check("an option carries the workspace directory, for disambiguating same-titled workspaces",
  everything.workspaceOptions[0].path === "E:\\codeVibe\\debug", JSON.stringify(everything.workspaceOptions.map(option => option.path)));
check("sessions no workspace accounts for are counted as ungrouped", everything.ungroupedCount === 1, String(everything.ungroupedCount));
check("a session placed by its cwd shows the workspace it matched",
  everything.sessions.find(session => session.id === "session-old")?.workspaceTitle === "temp",
  JSON.stringify(everything.sessions.find(session => session.id === "session-old")));

const onlyDebug = await listFor({ workspaceFilter: "ws-debug" });
check("a workspace filter lists only that workspace",
  onlyDebug.sessions.map(session => session.id).sort().join(",") === "session-m1,session-m2",
  JSON.stringify(onlyDebug.sessions.map(session => session.id)));
check("the filtered total replaces the archive total",
  onlyDebug.total === 2 && onlyDebug.archivedCount === 2, JSON.stringify([onlyDebug.total, onlyDebug.archivedCount]));
check("the unfiltered size survives the filter, for the \"all\" label",
  onlyDebug.visibleTotal === 4 && onlyDebug.archivedIdCount === 4, JSON.stringify([onlyDebug.visibleTotal, onlyDebug.archivedIdCount]));
check("the filter is echoed back", onlyDebug.workspace === "ws-debug", JSON.stringify(onlyDebug.workspace));
check("the options still describe the whole archive, not the selection",
  onlyDebug.workspaceOptions.length === 2 && onlyDebug.ungroupedCount === 1, JSON.stringify(onlyDebug.workspaceOptions));
check("a filtered list needs no more pages when it fits", onlyDebug.hasMore === false);

const cwdMatched = await listFor({ workspaceFilter: "ws-temp" });
check("a workspace also lists the sessions it owns by directory",
  cwdMatched.sessions.map(session => session.id).join(",") === "session-old",
  JSON.stringify(cwdMatched.sessions.map(session => session.id)));
check("a cwd-placed row carries its workspace title", cwdMatched.sessions[0].workspaceTitle === "temp", JSON.stringify(cwdMatched.sessions[0]));

const ungrouped = await listFor({ workspaceFilter: "ungrouped" });
check("the ungrouped filter lists only sessions no workspace owns",
  ungrouped.sessions.map(session => session.id).join(",") === "session-orphan",
  JSON.stringify(ungrouped.sessions.map(session => session.id)));
check("an ungrouped row shows no workspace", ungrouped.sessions[0].workspaceTitle === "", JSON.stringify(ungrouped.sessions[0]));

const unknownWorkspace = await listFor({ workspaceFilter: "ws-nope" });
check("an unknown workspace matches nothing", unknownWorkspace.sessions.length === 0 && unknownWorkspace.total === 0, JSON.stringify(unknownWorkspace.total));
check("an unknown workspace still reports the options, so the reader can recover",
  unknownWorkspace.workspaceOptions.length === 2 && unknownWorkspace.visibleTotal === 4, JSON.stringify(unknownWorkspace.workspaceOptions));
check("an unknown workspace is echoed honestly", unknownWorkspace.workspace === "ws-nope" && unknownWorkspace.hasMore === false);

// Paging must run over the filtered set, or "load more" would walk the whole
// archive while the reader believes it is walking one workspace.
const wideRegistry = {
  archivedSessionIds: ["session-m1", "session-m2", "session-old", "session-orphan", "session-x"],
  list: () => [{ id: "ws-debug", title: "debug", path: "E:\\codeVibe\\debug", sessionIds: ["session-m1", "session-m2", "session-x"] }]
};
const wideQuery = {
  ...wsQuery,
  filterSessions: async (filters) => (filters[0]?.values ?? []).map(id => ({
    // Only the three members carry the workspace's directory; the other two
    // would otherwise be placed by the cwd tier and inflate the fixture.
    header: {
      id,
      cwd: ["session-m1", "session-m2", "session-x"].includes(id) ? "E:\\codeVibe\\debug" : "E:\\elsewhere",
      createdAt: 100, version: 4, isSeeded: false
    },
    live: false,
    persisted: true
  }))
};
const wideArtifacts = new Map(wideRegistry.archivedSessionIds.map((id, index) => [id, { path: id, bytes: 10, mtime: index + 1, project: "p" }]));
const firstFilteredPage = await listArchived({
  workspaceRegistry: wideRegistry,
  sessionQuery: wideQuery,
  sessionsRoot: "unused",
  artifactIndex: wideArtifacts,
  titleCache: new Map(),
  projectionCache: undefined,
  excludedPaths: configExcludedPaths({}),
  workspaceFilter: "ws-debug",
  page: 2
});
check("a filtered page holds only matching sessions",
  firstFilteredPage.sessions.length === 2 && firstFilteredPage.sessions.every(session => ["session-m1", "session-m2", "session-x"].includes(session.id)),
  JSON.stringify(firstFilteredPage.sessions.map(session => session.id)));
check("the filtered total counts matches, not the archive",
  firstFilteredPage.total === 3 && firstFilteredPage.visibleTotal === 5, JSON.stringify([firstFilteredPage.total, firstFilteredPage.visibleTotal]));
check("hasMore follows the filtered set", firstFilteredPage.hasMore === true);
const lastFilteredPage = await listArchived({
  workspaceRegistry: wideRegistry,
  sessionQuery: wideQuery,
  sessionsRoot: "unused",
  artifactIndex: wideArtifacts,
  titleCache: new Map(),
  projectionCache: undefined,
  excludedPaths: configExcludedPaths({}),
  workspaceFilter: "ws-debug",
  page: 10
});
check("the last filtered page reports no more", lastFilteredPage.sessions.length === 3 && lastFilteredPage.hasMore === false,
  JSON.stringify([lastFilteredPage.sessions.length, lastFilteredPage.hasMore]));
const untitled = await listArchived({
  workspaceRegistry: { ...wideRegistry, list: () => [{ id: "ws-debug", path: "E:\\codeVibe\\debug", sessionIds: ["session-m1"] }] },
  sessionQuery: wideQuery,
  sessionsRoot: "unused",
  artifactIndex: wideArtifacts,
  titleCache: new Map(),
  projectionCache: undefined,
  excludedPaths: configExcludedPaths({})
});
check("a workspace with no title is labelled by its id",
  untitled.workspaceOptions.length === 1 && untitled.workspaceOptions[0].title === "ws-debug",
  JSON.stringify(untitled.workspaceOptions));

// A page must be the newest N of the MATCHED set, not the first N of the
// archive set re-sorted afterwards: with the latter, a workspace holding more
// sessions than one page hid its own newest sessions behind "load more"
// (measured on the live library: the newest four sat outside the first 50
// archive-set positions). The archive-set order below deliberately puts the
// newest session LAST.
const orderIds = ["session-oldest", "session-middle", "session-newest"];
const orderCreatedAt = { "session-oldest": 100, "session-middle": 200, "session-newest": 300 };
const orderArtifacts = new Map(orderIds.map((id, index) => [id, { path: id, bytes: 10, mtime: 10 + index, project: "p" }]));
const orderRegistry = {
  archivedSessionIds: orderIds,
  list: () => [{ id: "ws-debug", title: "debug", path: "E:\\codeVibe\\debug", sessionIds: [...orderIds] }]
};
const orderQuery = {
  ...fakeCtx.sessionQuery,
  filterSessions: async (filters) => (filters[0]?.values ?? []).map(id => ({
    header: { id, cwd: "E:\\codeVibe\\debug", createdAt: orderCreatedAt[id], version: 4, isSeeded: false }, live: false, persisted: true
  })),
  readTitleSnapshots: async (ids) => ids.map(id => ({ sessionId: id, status: "fulfilled", value: { title: { title: `t-${id}` } } }))
};
const orderedPage = await listArchived({
  workspaceRegistry: orderRegistry,
  sessionQuery: orderQuery,
  sessionsRoot: "unused",
  artifactIndex: orderArtifacts,
  titleCache: new Map(),
  projectionCache: undefined,
  excludedPaths: configExcludedPaths({}),
  workspaceFilter: "ws-debug",
  page: 2
});
check("a page holds the newest sessions of the filtered set, not the first in archive-set order",
  JSON.stringify(orderedPage.sessions.map(session => session.id)) === JSON.stringify(["session-newest", "session-middle"]),
  JSON.stringify(orderedPage.sessions.map(session => session.id)));
check("the page still reports that more sessions exist", orderedPage.hasMore === true && orderedPage.total === 3);

// A session the registry accounts under two workspaces: the options count it in
// both (each option answers "how many rows will I see if I pick this"), so the
// counts need not sum to the archive total — and the row has to name the
// workspace the filter matched, not an arbitrary one.
const dualIds = ["session-both", "session-nowhere"];
const dualRegistry = {
  archivedSessionIds: dualIds,
  list: () => [
    { id: "ws-a", title: "A", path: "E:\\a", sessionIds: ["session-both"] },
    { id: "ws-b", title: "B", path: "E:\\b", sessionIds: ["session-both"] }
  ]
};
const dualQuery = {
  ...fakeCtx.sessionQuery,
  filterSessions: async (filters) => (filters[0]?.values ?? []).map(id => ({
    header: { id, cwd: "E:\\nowhere", createdAt: 100, version: 4, isSeeded: false }, live: false, persisted: true
  })),
  readTitleSnapshots: async (ids) => ids.map(id => ({ sessionId: id, status: "fulfilled", value: { title: { title: `t-${id}` } } }))
};
const dual = await listArchived({
  workspaceRegistry: dualRegistry,
  sessionQuery: dualQuery,
  sessionsRoot: "unused",
  artifactIndex: new Map(dualIds.map(id => [id, { path: id, bytes: 10, mtime: 5, project: "p" }])),
  titleCache: new Map(),
  projectionCache: undefined,
  excludedPaths: configExcludedPaths({})
});
check("a session owned twice is counted under both workspaces",
  JSON.stringify(dual.workspaceOptions.map(option => [option.id, option.count])) === JSON.stringify([["ws-a", 1], ["ws-b", 1]]),
  JSON.stringify(dual.workspaceOptions));
check("the counted rows therefore need not sum to the archive total",
  dual.visibleTotal === 2 && dual.ungroupedCount === 1
  && dual.workspaceOptions.reduce((sum, option) => sum + option.count, 0) + dual.ungroupedCount === 3,
  JSON.stringify({ options: dual.workspaceOptions, ungrouped: dual.ungroupedCount, visible: dual.visibleTotal }));
const dualFiltered = await listArchived({
  workspaceRegistry: dualRegistry,
  sessionQuery: dualQuery,
  sessionsRoot: "unused",
  artifactIndex: new Map(dualIds.map(id => [id, { path: id, bytes: 10, mtime: 5, project: "p" }])),
  titleCache: new Map(),
  projectionCache: undefined,
  excludedPaths: configExcludedPaths({}),
  workspaceFilter: "ws-b"
});
check("a multi-owned row names the workspace the filter matched, not the first one",
  dualFiltered.sessions.length === 1 && dualFiltered.sessions[0].workspaceId === "ws-b" && dualFiltered.sessions[0].workspaceTitle === "B",
  JSON.stringify(dualFiltered.sessions.map(session => [session.id, session.workspaceId, session.workspaceTitle])));

// When the persistence read that resolves ownership fails, every session looks
// ungrouped: the response must say so, or a filtered "nothing" reads as an
// empty workspace while the reader knows it holds dozens of sessions.
const brokenOwnership = await listArchived({
  workspaceRegistry: dualRegistry,
  sessionQuery: { ...dualQuery, filterSessions: async () => { throw new Error("db down"); } },
  sessionsRoot: "unused",
  artifactIndex: new Map(dualIds.map(id => [id, { path: id, bytes: 10, mtime: 5, project: "p" }])),
  titleCache: new Map(),
  projectionCache: undefined,
  excludedPaths: configExcludedPaths({}),
  workspaceFilter: "ws-a"
});
check("a failed ownership read is reported, not disguised as an empty workspace",
  brokenOwnership.groupingFailed === true && brokenOwnership.total === 1,
  JSON.stringify({ failed: brokenOwnership.groupingFailed, total: brokenOwnership.total }));
check("a failed ownership read still places sessions the registry accounts for (membership needs no header)",
  brokenOwnership.sessions.length === 1 && brokenOwnership.sessions[0].id === "session-both",
  JSON.stringify(brokenOwnership.sessions.map(session => session.id)));
check("the same list without a filter still reports the failure",
  (await listArchived({
    workspaceRegistry: dualRegistry,
    sessionQuery: { ...dualQuery, filterSessions: async () => { throw new Error("db down"); } },
    sessionsRoot: "unused",
    artifactIndex: new Map(dualIds.map(id => [id, { path: id, bytes: 10, mtime: 5, project: "p" }])),
    titleCache: new Map(),
    projectionCache: undefined,
    excludedPaths: configExcludedPaths({})
  })).groupingFailed === true);
check("a healthy list does not claim a failure",
  dual.groupingFailed === false && orderedPage.groupingFailed === false, JSON.stringify([dual.groupingFailed, orderedPage.groupingFailed]));

// The workspace index is shared state for the duration of one request: a caller
// must not be able to mutate it through a returned Set.
const isolationIndex = indexWorkspaces([{ id: "ws-a", title: "A", path: "E:\\a", sessionIds: ["session-x"] }]);
sessionWorkspaces("session-x", undefined, isolationIndex).add("POISON");
check("resolving a session returns a copy, so the index cannot be mutated",
  sessionWorkspaces("session-x", undefined, isolationIndex).size === 1
  && !sessionWorkspaces("session-x", undefined, isolationIndex).has("POISON"),
  JSON.stringify([...sessionWorkspaces("session-x", undefined, isolationIndex)]));
check("the path tier is a copy too",
  sessionWorkspaces("session-y", "E:\\a", isolationIndex).size === 1);

// --- 6. client artifact ---------------------------------------------------
const clientSource = readFileSync(new URL("./client.js", import.meta.url), "utf8");
check("client registers through the module loader", clientSource.includes("__ModuleLoader__.load"));
check("client factory id matches the package name", clientSource.includes("id: 'dsh-archive-viewer'"));
check("client declares the footer slot", clientSource.includes("sidebar.footer.action"));
check("client uses a fresh slot id", clientSource.includes("archive-viewer-footer"));
check("client never calls the mutation route on render", clientSource.includes("'/unarchive'"));
check("client routes visible text through the locale dictionaries", clientSource.includes("ctx.locale.register") && clientSource.includes("locale: NS"));
check("client labels include both locales", clientSource.includes("panel.title") && clientSource.includes("归档会话查看器"));
check("client contains no hard-coded file paths", !/E:\\\\/.test(clientSource));
check("client styles use host theme tokens", clientSource.includes("--dsw-alias-label-primary") && clientSource.includes("--dsw-alias-border-l1"));

// --- 7. optional live checks ----------------------------------------------
if (process.env.ARCHIVE_VIEWER_LIVE === "1") {
  const dshHome = resolveDshHome(process.env.DSH_HOME || "E:\\DeepSeek Harness");
  const statePath = join(dshHome, "storages", "workspace.json");
  if (!existsSync(statePath)) {
    results.push("  skip live checks — no workspace.json");
  } else {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const archivedIds = state?.global?.archivedSessionIds ?? [];
    if (archivedIds.length === 0) {
      results.push("  skip live checks — no archived sessions");
    } else {
      let liveHandler;
      const registryRecords = state?.tables?.workspaces ?? {};
      const liveWorkspaces = (state?.global?.workspaceIds ?? [])
        .filter(id => registryRecords[id] !== undefined)
        .map(id => ({ id, ...registryRecords[id] }));
      const liveCtx = {
        webServer: { register(definition) { liveHandler = definition.handler; return () => {}; } },
        effect(callback) { callback(); return () => {}; },
        get: () => undefined,
        workspaceRegistry: { archivedSessionIds: archivedIds, list: () => liveWorkspaces, unarchiveSession: async () => {} },
        sessionQuery: undefined
      };
      apply(liveCtx, { dshHome });
      const liveCall = async (url) => {
        const res = fakeRes();
        await liveHandler(fakeReq(url), res);
        return JSON.parse(res.captured.body).result;
      };
      const live = await liveCall(`${API_PREFIX}/sessions`);
      const sessions = live.sessions;
      check("live: registry count is reported", live.archivedCount === archivedIds.length, String(live.archivedCount));
      // The Client half's one metadata answer, checked against the legacy list
      // on the same real library: it must describe the whole archive set (not a
      // page), agree on the internal-machinery exclusion, and carry real sizes.
      const liveMeta = await liveCall(`${API_PREFIX}/meta`);
      check("live: meta answers for the whole archive set",
        liveMeta.archivedIdCount === archivedIds.length, String(liveMeta.archivedIdCount));
      check("live: meta agrees with the legacy list on the hidden set",
        liveMeta.excluded.length === live.hiddenCount,
        JSON.stringify({ meta: liveMeta.excluded.length, hidden: live.hiddenCount }));
      check("live: every hidden id is a member of the archive set",
        liveMeta.excluded.every(id => archivedIds.includes(id)), JSON.stringify(liveMeta.excluded));
      check("live: meta carries artifact sizes for real sessions",
        Object.keys(liveMeta.bytes).length > 0 && Object.keys(liveMeta.bytes).length <= live.archivedCount,
        JSON.stringify({ sized: Object.keys(liveMeta.bytes).length, archived: live.archivedCount }));
      check("live: meta never invents a size for a stale id",
        Object.keys(liveMeta.bytes).every(id => archivedIds.includes(id)), "a size appeared for an id outside the archive set");
      check("live: artifacts were found", sessions.some(session => typeof session.bytes === "number"));
      const withArtifact = sessions.find(session => typeof session.bytes === "number");
      check("live: artifact size is plausible", withArtifact.bytes > 0, JSON.stringify(withArtifact));
      check("live: missing artifacts are marked, not invented", sessions.filter(session => session.bytes === undefined).every(session => session.persisted === false));
      check("live: every visible session is accounted for by an option",
        live.workspaceOptions.reduce((total, option) => total + option.count, 0) + live.ungroupedCount === live.visibleTotal,
        JSON.stringify({ options: live.workspaceOptions, ungrouped: live.ungroupedCount, visible: live.visibleTotal }));
      check("live: this library resolves to at least one workspace (the cwd tier is not what is being exercised)",
        live.workspaceOptions.length > 0,
        `options=${live.workspaceOptions.length} ungrouped=${live.ungroupedCount} visible=${live.visibleTotal}`);
      for (const option of live.workspaceOptions.slice(0, 3)) {
        const only = await liveCall(`${API_PREFIX}/sessions?workspace=${encodeURIComponent(option.id)}&limit=500`);
        check(`live: "${option.title}" is filtered to its own sessions`,
          only.total === option.count && only.sessions.every(session => session.workspaceId === option.id),
          JSON.stringify({ expected: option.count, got: only.total, workspaceIds: [...new Set(only.sessions.map(session => session.workspaceId))] }));
      }
      const liveUngrouped = await liveCall(`${API_PREFIX}/sessions?workspace=ungrouped&limit=500`);
      check("live: the ungrouped filter matches its own count",
        liveUngrouped.total === live.ungroupedCount
        && liveUngrouped.sessions.every(session => session.workspaceId === ""),
        JSON.stringify({ expected: live.ungroupedCount, got: liveUngrouped.total }));
      const liveUnknown = await liveCall(`${API_PREFIX}/sessions?workspace=ws-does-not-exist`);
      check("live: an unknown workspace matches nothing", liveUnknown.total === 0 && liveUnknown.sessions.length === 0,
        JSON.stringify({ total: liveUnknown.total }));
      results.push(`  info live: ${live.total} archived, ${sessions.filter(s => s.bytes !== undefined).length} of the ${sessions.length}-row page carry an artifact, newest "${withArtifact.title || withArtifact.id}"`);
      results.push(`  info live: workspaces ${JSON.stringify(live.workspaceOptions.map(option => [option.title, option.count]))}, ungrouped ${live.ungroupedCount}`);
    }
  }
}

console.log(results.join("\n"));
console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${results.length - failures}/${results.length} checks`);
process.exit(failures === 0 ? 0 : 1);










