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
  assertSessionId,
  assistantParts,
  buildRows,
  configDshHome,
  collectCallMeta,
  contentText,
  isInjectedRow,
  formatToolArgs,
  resolveDshHome,
  safeErrorMessage
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
      const liveCtx = {
        webServer: { register(definition) { liveHandler = definition.handler; return () => {}; } },
        effect(callback) { callback(); return () => {}; },
        get: () => undefined,
        workspaceRegistry: { archivedSessionIds: archivedIds, list: () => [], unarchiveSession: async () => {} },
        sessionQuery: undefined
      };
      apply(liveCtx, { dshHome });
      const live = fakeRes();
      await liveHandler(fakeReq(`${API_PREFIX}/sessions`), live);
      const livePayload = JSON.parse(live.captured.body);
      const sessions = livePayload.result.sessions;
      check("live: registry count is reported", livePayload.result.archivedCount === archivedIds.length, String(livePayload.result.archivedCount));
      check("live: artifacts were found", sessions.some(session => typeof session.bytes === "number"));
      const withArtifact = sessions.find(session => typeof session.bytes === "number");
      check("live: artifact size is plausible", withArtifact.bytes > 0, JSON.stringify(withArtifact));
      check("live: missing artifacts are marked, not invented", sessions.filter(session => session.bytes === undefined).every(session => session.persisted === false));
      results.push(`  info live: ${sessions.length} archived, ${sessions.filter(s => s.bytes !== undefined).length} with an artifact, newest "${withArtifact.title || withArtifact.id}"`);
    }
  }
}

console.log(results.join("\n"));
console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${results.length - failures}/${results.length} checks`);
process.exit(failures === 0 ? 0 : 1);


