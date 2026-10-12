/**
 * dsh-archive-viewer — Host half.
 *
 * A strictly read-only window onto archived Sessions.
 *
 * Why this exists: DSH's own UI refuses to surface an archived Session as the
 * current view (`guardedOpen` in @deepseek-ai/dsh-client-ui-workspace shows a
 * notice instead), so the only way to read one in the shipped UI is to
 * unarchive it first — which mutates the durable archive set. The archive is a
 * UI-navigation restriction, not a data restriction: the durable session log
 * stays fully readable through `sessionQuery` (the same service DSH's own
 * `/api/session.export` route reads cold logs with) and through the artifact
 * files under `<dshHome>/sessions`.
 *
 * This Host half therefore never writes session state. Its three GET routes
 * only read; its single POST route (`/unarchive`) exists because the user
 * asked for a "restore and continue" escape hatch and is only ever called from
 * an explicit button in the viewer.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const name = "dsh-archive-viewer";

/** All three services are present in every shipped Web profile; declaring them
 * keeps the plugin inactive (instead of throwing) in a profile without them. */
export const inject = ["webServer", "workspaceRegistry", "sessionQuery"];

/**
 * The plugin takes no Config: every value it needs is either a Service or the
 * resolved Harness home, and a dependency-free plugin cannot validate a Config
 * schema without pulling in the Schema package. `dshHome` may still be supplied
 * as a row field for a non-standard layout, and is validated by hand.
 */
export function configDshHome(config) {
  const value = config?.dshHome;
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("dshHome 必须是字符串路径");
  return value;
}

/** Expand `~`, `~/`, and `~\`, then require an absolute path. */
export function resolveDshHome(configured) {
  const raw = typeof configured === "string" ? configured.trim() : "";
  const fromEnv = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  let value = raw !== "" ? raw : (fromEnv !== "" ? fromEnv : join(homedir(), ".dsh"));
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = join(homedir(), value.slice(2));
  const absolute = resolve(value);
  if (!isAbsolute(absolute)) throw new Error(`无法解析 DSH 数据目录: ${String(configured)}`);
  return absolute;
}

/** Absolute route prefix the Host registers and the browser addresses. */
export const API_PREFIX = "/archive-viewer/api";

/**
 * Workspaces whose archived sessions are internal machinery, not conversations:
 * the memory plugin's background workbench creates and deletes its sessions on
 * its own, so they archive themselves and their artifact disappears (that is
 * also the source of the stale archived id whose fold used to cost ~85ms per
 * request). Excluded by the session's own `cwd`, so nothing is read to decide.
 *
 * Overridable through the row's config: `excludeWorkspacePaths: []` shows
 * everything again, and extra paths append to the default.
 */
export const DEFAULT_EXCLUDED_WORKSPACE_PATHS = ["aik_auto_memory_use"];

/** Read the exclusion list from one row's config. */
export function configExcludedPaths(config) {
  const value = config?.excludeWorkspacePaths;
  if (value === undefined || value === null) return [...DEFAULT_EXCLUDED_WORKSPACE_PATHS];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error("excludeWorkspacePaths 必须是字符串数组");
  }
  return value
    .map(item => item.trim())
    .filter(item => item !== "")
    .map(item => (item === "~" || item.startsWith("~/") || item.startsWith("~\\") ? join(homedir(), item.slice(2)) : item));
}

/**
 * Whether one session is hidden from the archive list.
 *
 * The session's `cwd` is compared after normalizing separators and case, so a
 * path with a trailing slash, mixed separators, or a different drive-letter
 * casing still matches; a directory name matches when it is a path segment or
 * a suffix of the path, never a partial word.
 * @param cwd - the session's working directory as DSH reports it.
 * @param excluded - configured exclusion patterns.
 * @returns whether the session should be left out of the list.
 */
export function isExcludedWorkspace(cwd, excluded) {
  if (typeof cwd !== "string" || cwd === "" || excluded === undefined) return false;
  const normalize = (value) => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = normalize(cwd);
  const segments = target.split("/").filter(segment => segment !== "");
  return excluded.some(pattern => {
    const needle = normalize(pattern);
    if (needle === "") return false;
    if (needle.includes("/")) return target === needle || target.startsWith(`${needle}/`);
    // A bare name matches a whole path segment, or the session's own `cwd`
    // when DSH reports a project directory rather than a full path.
    return segments.includes(needle) || target === needle;
  });
}

/** Durable artifact filenames, newest generation first. */
const ARTIFACT_NAMES = [
  "session.v4.jsonl.zstd",
  "session.v3.jsonl.zstd",
  "session.v2.jsonl.zstd",
  "session.jsonl.zstd",
  "session.jsonl"
];

/** How long one `<dshHome>/sessions` directory walk is reused. */
const SCAN_TTL_MS = 15000;
/**
 * The persisted projection-cache directory, read as the cheap title source.
 * Measured on this library: reading all 52 checkpoint rows costs ~14ms, while
 * folding a title out of the log costs ~44ms PER SESSION (2.3s for the whole
 * archive). The live `sessionProjectionCache` service is tried first; this
 * direct read covers a cold in-memory table, and every value is accepted only
 * after its identity fields match the header DSH itself supplied.
 */
const PROJECTION_CACHE_SEGMENTS = ["storages", "session_projcache", "sessions"];
/** Default sessions returned per list page; the client asks for more on demand. */
const DEFAULT_LIST_LIMIT = 50;
/** Hard cap so one request can never ask for an unbounded page. */
const MAX_LIST_LIMIT = 500;
/** Per-block character cap for rendered transcript text. */
const MAX_BLOCK_CHARS = 8000;
/** Most recent transcript rows returned for one read. */
const MAX_ROWS = 1200;

/** Session ids are directory names under one validated root; reject anything
 * that could escape it before a path is ever composed. */
export function assertSessionId(id) {
  if (typeof id !== "string" || id.trim() === "" || id === "." || id === ".."
    || /[\\/\x00-\x1f<>:"|?*]/.test(id) || /[. ]$/.test(id)) {
    const error = new Error("sessionId 必须是合法的会话标识");
    error.code = "bad-request";
    throw error;
  }
  return id;
}

export function safeErrorMessage(error) {
  if (error === null || error === undefined) return `<nullish:${typeof error}>`;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    if (typeof error.message === "string" && error.message.length > 0) return error.message;
    if (typeof error.code === "string" && error.code.length > 0) return `[code=${error.code}]`;
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

async function readBody(req, limit = 1024 * 64) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) { const error = new Error("请求体过大"); error.code = "bad-request"; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Truncate one rendered text block, keeping the head and saying so. */
function clip(text, limit = MAX_BLOCK_CHARS) {
  if (typeof text !== "string") return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断 ${text.length - limit} 字符）`;
}

/**
 * Walk `<sessionsRoot>/<project>/<sessionDir>/` once and index every durable
 * artifact by session id. Header-only discovery: nothing is inflated here, so
 * this stays cheap on a large library.
 * @param root - the resolved `<dshHome>/sessions` directory.
 * @returns id → { path, bytes, mtime, project }.
 */
export async function scanSessionArtifacts(root) {
  const index = new Map();
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); }
  catch { return index; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let entries;
    try { entries = await readdir(projectPath, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const artifactName of ARTIFACT_NAMES) {
        const artifactPath = join(projectPath, entry.name, artifactName);
        try {
          const info = await stat(artifactPath);
          if (info.isFile()) {
            index.set(entry.name, { path: artifactPath, bytes: info.size, mtime: info.mtimeMs, project: project.name });
            break;
          }
        } catch { /* try the next generation's filename */ }
      }
    }
  }
  return index;
}

/**
 * Read one session's folded title straight from its persisted projection
 * checkpoint — the cheap path, no log inflation.
 *
 * Every acceptance is guarded by the same identity the official
 * `cachedSnapshot` face checks (format version, createdAt, cwd, isSeeded), so a
 * value can lag the log but can never come from a different session or an older
 * format generation whose fold semantics differed. Anything that does not match
 * returns undefined and the caller falls back to the log.
 *
 * @param cacheDir - resolved `<dshHome>/storages/session_projcache/sessions`.
 * @param header - the header DSH itself supplied for this session.
 * @returns the stored title, or undefined when the row cannot be trusted.
 */
export async function readCachedTitle(cacheDir, header) {
  if (header === undefined || header === null) return undefined;
  let parsed;
  try {
    const raw = await readFile(join(cacheDir, `${header.id}.json`), "utf8");
    parsed = JSON.parse(raw);
  } catch { return undefined; }
  const record = parsed?.record;
  const rows = record?.rows;
  const title = rows?.title?.val;
  if (typeof title !== "string" || title === "") return undefined;
  const identity = record?.identity;
  if (identity === undefined || identity === null) return undefined;
  if (identity.formatVersion !== header.version) return undefined;
  if (identity.createdAt !== header.createdAt) return undefined;
  if (identity.isSeeded !== header.isSeeded) return undefined;
  if (header.cwd !== undefined && identity.cwd !== header.cwd) return undefined;
  return title;
}

/** `{ type, seq, time, data }` JSONL lines of an artifact, header included. */
export function parseSessionLines(content) {  const lines = content.split("\n");
  const events = [];
  let header;
  for (const line of lines) {
    const text = line.trim();
    if (text === "") continue;
    let parsed;
    try { parsed = JSON.parse(text); } catch { continue; }
    if (header === undefined && parsed !== null && typeof parsed === "object" && parsed.type === "session") { header = parsed; continue; }
    if (parsed !== null && typeof parsed === "object" && typeof parsed.type === "string") events.push(parsed);
  }
  return { header, events };
}

/** Fold one Assistant `stream` record list into display text. */
export function assistantParts(stream) {
  let text = "";
  let reasoning = "";
  if (!Array.isArray(stream)) return { text, reasoning, toolCalls: [] };
  for (const record of stream) {
    if (record === null || typeof record !== "object") continue;
    if (record.type === "text-chunks" && Array.isArray(record.texts)) text += record.texts.join("");
    else if (record.type === "reasoning-chunks" && Array.isArray(record.texts)) reasoning += record.texts.join("");
    else if (record.type === "chunk" && record.chunk !== null && typeof record.chunk === "object") {
      const chunk = record.chunk;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") reasoning += chunk.text;
    }
  }
  return { text, reasoning, toolCalls: [] };
}

/** Text of one message/content-block array, tolerating every block kind a log
 * may carry; unknown kinds are named rather than dropped silently. */
export function contentText(content) {
  const parts = [];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "reasoning" && typeof block.text === "string") parts.push("");
    else if (block.type === "image") parts.push(`[图片${block.attachment?.name ? ` ${block.attachment.name}` : ""}]`);
    else if (block.type === "file") parts.push(`[文件 ${block.attachment?.name ?? ""}]`);
    else if (block.type === "tool-call") parts.push("");
    else if (block.type === "tool-addition") parts.push(`[工具上线 ${block.toolName ?? ""}]`);
    else if (block.type === "tool-removal") parts.push(`[工具下线 ${block.toolName ?? ""}]`);
    else parts.push(`[${String(block.type)}]`);
  }
  return parts.filter(part => part !== "").join("\n");
}

/** Prettify a tool argument payload; a non-JSON payload is shown verbatim. */
export function formatToolArgs(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  try { return JSON.stringify(JSON.parse(raw), null, 2); }
  catch { return raw; }
}

/**
 * Tool-call metadata keyed by callId, collected from the complete raw log.
 *
 * Why a separate pass: the "current surface" view DSH exposes for a session
 * carries tool RESULTS but not the `tool/call` events that name the tool — an
 * archived read showed 91 results and zero calls. Without this map every
 * result renders as "unpaired", which is exactly how the first version read.
 * @param events - complete event log, calls included.
 * @returns callId → { name, arguments }.
 */
export function collectCallMeta(events) {
  const meta = new Map();
  for (const event of events) {
    if (event.type !== "tool/call") continue;
    const callId = event.data?.callId ?? event.data?.id;
    if (typeof callId !== "string") continue;
    meta.set(callId, {
      name: typeof event.data?.name === "string" ? event.data.name : "",
      arguments: typeof event.data?.arguments === "string" ? event.data.arguments : ""
    });
  }
  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    for (const block of event.data?.message?.content ?? []) {
      if (block?.type !== "tool-call" || typeof block.id !== "string") continue;
      if (!meta.has(block.id)) meta.set(block.id, { name: block.name ?? "", arguments: block.arguments ?? "" });
    }
  }
  return meta;
}

/** Whether one rendered row is Harness-injected context rather than something
 * the user typed or the model said. Drives the reader's hide-injected toggle. */
export function isInjectedRow(row) {
  return row.kind === "injected";
}

/** Turn a raw event log into display rows: the conversation as it stood, with
 * tool calls paired to their results and injected context summarized.
 * @param events - the events to render (the current surface, or the raw log).
 * @param header - durable session header.
 * @param options - `callsById` supplies tool-call metadata from the complete
 *   log, so results render with their tool's name even when the view omits the
 *   call events themselves.
 */
export function buildRows(events, header, options = {}) {
  const callsById = options.callsById ?? collectCallMeta(events);
  const consumed = new Set();
  const rows = [];
  const resultsById = new Map();
  const resultsInOrder = [];
  for (const event of events) {
    if (event.type !== "tool/result") continue;
    const callId = event.data?.message?.source?.callId ?? event.data?.toolCallId;
    if (typeof callId === "string") resultsById.set(callId, event);
    resultsInOrder.push({ seq: event.seq, event });
  }
  const takeResult = (callId, seq) => {
    let hit = typeof callId === "string" ? resultsById.get(callId) : undefined;
    if (hit === undefined) {
      // Older logs may not carry a call id on the result; take the first
      // unconsumed result that follows the call.
      const candidate = resultsInOrder.find(entry => !consumed.has(entry.seq) && entry.seq > seq);
      hit = candidate?.event;
    }
    if (hit !== undefined) consumed.add(hit.seq);
    return hit;
  };

  for (const event of events) {
    const data = event.data ?? {};
    const base = { seq: event.seq, time: event.time };
    switch (event.type) {
      case "user/message": {
        const kind = data.source?.kind;
        const text = contentText(data.content);
        // Harness-injected context (runtime snapshot, workspace instructions,
        // skill catalog, hook notices) also arrives as a user message. Label it
        // so it can be collapsed away from the actual conversation: measured on
        // a real archived session it was 216,688 characters against 3,621
        // characters of typed prompts.
        const injected = kind === "system-prompt" || kind === "user-approval" || kind === "delegation"
          || text.startsWith("<system-reminder>")
          || text.startsWith("Current runtime context.");
        if (injected) {
          rows.push({ ...base, kind: "injected", label: kind ?? "context", text: clip(text) });
        } else {
          rows.push({ ...base, kind: "user", text: clip(text), source: kind ?? "user" });
        }
        break;
      }
      case "assistant/message": {
        const parts = assistantParts(data.stream);
        const fallback = contentText(data.message?.content);
        rows.push({
          ...base,
          kind: "assistant",
          turn: data.turn,
          step: data.step,
          text: clip(parts.text !== "" ? parts.text : fallback),
          reasoning: clip(parts.reasoning, 4000),
          model: data.message?.source?.model,
          provider: data.message?.source?.provider,
          interrupted: data.interrupted === true,
          usage: data.usage === undefined ? undefined : {
            input: data.usage.inputTokens,
            output: data.usage.outputTokens,
            reasoning: data.usage.reasoningTokens
          }
        });
        break;
      }
      case "tool/call": {
        const result = takeResult(data.callId, event.seq);
        rows.push({
          ...base,
          kind: "tool",
          name: data.name,
          callId: data.callId,
          args: clip(formatToolArgs(data.arguments), 4000),
          result: result === undefined ? undefined : clip(contentText(result.data?.message?.content), MAX_BLOCK_CHARS),
          error: result?.data?.error === undefined ? undefined : `${result.data.error.name ?? "error"}${result.data.error.code ? ` (${result.data.error.code})` : ""}`
        });
        break;
      }
      case "tool/result": {
        if (consumed.has(event.seq)) break;
        const callId = data.message?.source?.callId ?? data.toolCallId;
        const meta = typeof callId === "string" ? callsById.get(callId) : undefined;
        rows.push({
          ...base,
          kind: "tool",
          name: meta?.name ?? "",
          callId: typeof callId === "string" ? callId : undefined,
          paired: meta !== undefined,
          args: clip(formatToolArgs(meta?.arguments), 4000),
          result: clip(contentText(data.message?.content), MAX_BLOCK_CHARS),
          error: data.error === undefined ? undefined : `${data.error.name ?? "error"}${data.error.code ? ` (${data.error.code})` : ""}`
        });
        break;
      }
      case "system/message":
        rows.push({ ...base, kind: "injected", label: "system", text: clip(contentText(data.message?.content)) });
        break;
      case "developer/message":
        rows.push({ ...base, kind: "injected", label: "developer", text: clip(contentText(data.message?.content)) });
        break;
      case "system-prompt": {
        const text = typeof data.prompt === "string" ? data.prompt : contentText(data.content);
        if (text !== "") rows.push({ ...base, kind: "injected", label: "system-prompt", text: clip(text) });
        break;
      }
      case "session/title":
        if (typeof data.title === "string") rows.push({ ...base, kind: "title", text: data.title });
        break;
      case "working-directory/change":
        rows.push({ ...base, kind: "notice", label: "cwd", text: String(data.cwd ?? "") });
        break;
      case "sandbox/mode":
        rows.push({ ...base, kind: "notice", label: "sandbox", text: String(data.mode ?? "") });
        break;
      case "approval/policy":
        rows.push({ ...base, kind: "notice", label: "approval", text: String(data.policy ?? "") });
        break;
      case "permission/preset":
        rows.push({ ...base, kind: "notice", label: "permission", text: String(data.preset ?? data.name ?? "") });
        break;
      case "model/selection":
        rows.push({
          ...base,
          kind: "notice",
          label: "model",
          text: [data.provider, data.model].filter(value => typeof value === "string" && value !== "").join(" / ")
        });
        break;
      case "agent-preset/selected":
        rows.push({ ...base, kind: "notice", label: "preset", text: String(data.agentPreset ?? "") });
        break;
      case "turn/start":
        rows.push({ ...base, kind: "turn", turn: data.turn, phase: "start" });
        break;
      case "turn/end": {
        const reason = data.reason?.kind ?? String(data.reason ?? "");
        rows.push({ ...base, kind: "turn", turn: data.turn, phase: "end", reason });
        break;
      }
      case "compaction":
        rows.push({ ...base, kind: "notice", label: "compaction", text: "" });
        break;
      case "session/end-seed":
        if (data.inherited !== true) rows.push({ ...base, kind: "notice", label: "seed", text: "" });
        break;
      default:
        break;
    }
  }

  const filtered = rows.filter(row => row.kind !== "notice" || row.text !== "" || row.label === "seed" || row.label === "compaction");
  const truncated = filtered.length > MAX_ROWS;
  const items = truncated ? filtered.slice(filtered.length - MAX_ROWS) : filtered;
  return {
    items,
    truncated,
    rowCount: filtered.length,
    eventCount: events.length,
    firstSeq: events.length > 0 ? events[0].seq : undefined,
    lastSeq: events.length > 0 ? events[events.length - 1].seq : undefined,
    lastTime: events.length > 0 ? events[events.length - 1].time : undefined,
    header: header === undefined ? undefined : {
      id: header.id,
      version: header.version,
      cwd: header.cwd,
      createdAt: header.createdAt,
      agentPreset: header.agentPreset,
      origin: header.origin,
      parentSession: header.parentSession,
      isSeeded: header.isSeeded
    }
  };
}

/** Build the transcript payload from one live/prepared observation. */
export async function transcriptFor(sessionQuery, sessionId) {
  const snapshot = await sessionQuery.readSession(sessionId);
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  let surfaceEvents = events;
  let surfaceAvailable = false;
  if (typeof sessionQuery.readSurface === "function") {
    try {
      const surface = await sessionQuery.readSurface(sessionId);
      if (Array.isArray(surface?.events) && surface.events.length > 0) {
        surfaceEvents = surface.events;
        surfaceAvailable = true;
      }
    } catch { /* surface read is an optimization; the raw log stands in */ }
  }
  // The surface view omits `tool/call` events, so tool metadata is collected
  // from the complete log and merged in while folding the surface rows.
  const callsById = collectCallMeta(events);
  const built = buildRows(surfaceEvents, snapshot?.session, { callsById });
  const injectedCount = built.items.reduce((total, row) => total + (isInjectedRow(row) ? 1 : 0), 0);
  const usage = events.reduce((total, event) => {
    const value = event.data?.usage;
    if (value === undefined || value === null) return total;
    return {
      input: total.input + (value.inputTokens ?? 0),
      output: total.output + (value.outputTokens ?? 0),
      calls: total.calls + 1
    };
  }, { input: 0, output: 0, calls: 0 });
  return {
    sessionId,
    header: built.header,
    items: built.items,
    truncated: built.truncated,
    rowCount: built.rowCount,
    eventCount: built.eventCount,
    injectedCount,
    callCount: callsById.size,
    surfaceAvailable,
    firstSeq: built.firstSeq,
    lastSeq: built.lastSeq,
    lastTime: built.lastTime,
    usage
  };
}

/** Archive-list payload: registry membership, workspace title, folded title,
 * artifact statistics. Persistence-derived values are best-effort per id so
 * one unreadable session cannot fail the whole list. */
export async function listArchived({ workspaceRegistry, sessionQuery, sessionsRoot, artifactIndex, titleCache, projectionCache, projectionCacheDir, dshHome, page, excludedPaths, timings }) {
  const mark = () => Date.now();
  const spent = {};
  const started = mark();
  const archivedIds = [...(workspaceRegistry?.archivedSessionIds ?? [])].map(String);
  const workspaceBySession = new Map();
  const workspaceTitles = new Map();
  for (const workspace of workspaceRegistry?.list?.() ?? []) {
    workspaceTitles.set(String(workspace.id), workspace.title);
    for (const id of workspace.sessionIds ?? []) workspaceBySession.set(String(id), String(workspace.id));
  }
  spent.registryMs = mark() - started;

  const records = new Map();
  let filterError;
  let filterFirstFields = [];
  if (sessionQuery !== undefined && typeof sessionQuery.filterSessions === "function") {
    const from = mark();
    try {
      const found = await sessionQuery.filterSessions([{ kind: "id", values: archivedIds }]);
      for (const record of found ?? []) records.set(String(record.header?.id), record);
      filterFirstFields = found !== undefined && found.length > 0 ? Object.keys(found[0] ?? {}) : [];
    } catch (error) { filterError = safeErrorMessage(error); }
    spent.filterMs = mark() - from;
  }
  spent.filterRecords = records.size;
  spent.filterFirstFields = filterFirstFields;
  if (filterError !== undefined) spent.filterError = filterError;

  // Internal machinery stays out of the archive list: the memory plugin's
  // workbench sessions archive and delete themselves, so they are noise here
  // and their leftover ids are the stale entries that cost a fold each request.
  // Filtering uses the header DSH already supplied (or the artifact's project
  // directory), so nothing extra is read to decide.
  const hiddenByPath = [];
  const visibleIds = archivedIds.filter(id => {
    const cwd = records.get(id)?.header?.cwd ?? artifactIndex?.get(id)?.project;
    if (!isExcludedWorkspace(cwd, excludedPaths)) return true;
    hiddenByPath.push(id);
    return false;
  });
  spent.hiddenByPath = hiddenByPath.length;
  spent.hiddenSample = hiddenByPath.slice(0, 3);

  const from = mark();
  const index = artifactIndex ?? await scanSessionArtifacts(sessionsRoot);
  spent.scanMs = mark() - from;

  // One page only: every per-session cost below (titles, folding) is bounded by
  // the page size, so latency stays flat while the archive grows. `hasMore`
  // tells the reader there is another page.
  const pageSize = Number.isSafeInteger(page) && page > 0 ? Math.min(page, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
  const pageIds = visibleIds.slice(0, pageSize);

  // Titles, cheapest source first. Measured here: reading all 52 persisted
  // checkpoints costs ~14ms, while folding one title out of a log costs ~44ms
  // per session (2.3s for the archive, and it grows with the archive).
  //   1. the live `sessionProjectionCache.cachedSnapshot` face (zero I/O);
  //   2. the same checkpoint read straight off disk, identity-checked;
  //   3. our own fold, cached against the artifact's stat fingerprint;
  //   4. folding a log that actually changed (a rename).
  // Only the requested page is resolved, so the cost is bounded by the page
  // size no matter how large the archive grows.
  const titles = new Map();
  const fromCache = new Set();

  // Settle our own fingerprint-verified folds first: that value was read from
  // the log itself and is therefore never older than a checkpoint, so a stale
  // checkpoint must not shadow it.
  const ownVerified = new Set();
  for (const id of pageIds) {
    const artifact = index.get(id);
    const own = titleCache?.get(id);
    if (own !== undefined && artifact !== undefined && own.mtimeMs === artifact.mtime && own.bytes === artifact.bytes) {
      titles.set(id, own.title);
      ownVerified.add(id);
    }
  }

  // 1. the live checkpoint face (zero I/O) — tried even for verified ids, since
  //    a newer title there is strictly better than an older fold of ours.
  const viewFrom = mark();
  if (projectionCache !== undefined && typeof projectionCache.cachedSnapshot === "function") {
    for (const id of pageIds) {
      const header = records.get(id)?.header;
      if (header === undefined) continue;
      try {
        const snapshot = projectionCache.cachedSnapshot(header, ["title"]);
        const title = snapshot?.values?.title?.title;
        if (typeof title === "string" && title !== "") {
          titles.set(id, title);
          fromCache.add(id);
        }
      } catch { /* a missing checkpoint just falls through */ }
    }
  }
  spent.cachedTitleMs = mark() - viewFrom;

  // 2. the same checkpoint straight off disk, identity-checked. Our own
  //    fingerprint-settled values skip it: they already came from this log.
  const diskFrom = mark();
  const cacheDir = projectionCacheDir ?? join(dshHome ?? "", ...PROJECTION_CACHE_SEGMENTS);
  for (const id of pageIds) {
    if (ownVerified.has(id) || (titles.has(id) && fromCache.has(id))) continue;
    const header = records.get(id)?.header;
    if (header === undefined) continue;
    const title = await readCachedTitle(cacheDir, header);
    if (title !== undefined) {
      titles.set(id, title);
      fromCache.add(id);
    }
  }
  spent.checkpointDiskMs = mark() - diskFrom;

  // 3. anything still unresolved is folded from its log below.
  const stale = [];
  for (const id of pageIds) {
    if (titles.has(id)) continue;
    stale.push(id);
  }
  // "hits" counts everything already served without a fold.
  spent.titleCacheHits = pageIds.length - stale.length;
  spent.titleCacheMisses = stale.length;
  spent.titlesFromCheckpoint = fromCache.size;
  spent.pageIds = pageIds.length;

  if (stale.length > 0 && sessionQuery !== undefined && typeof sessionQuery.readTitleSnapshots === "function") {
    const foldFrom = mark();
    try {
      const snapshots = await sessionQuery.readTitleSnapshots(stale);
      for (const result of snapshots ?? []) {
        if (result?.status === "fulfilled" && typeof result.value?.title?.title === "string") {
          const id = String(result.sessionId);
          const title = result.value.title.title;
          titles.set(id, title);
          const artifact = index.get(id);
          if (artifact !== undefined && titleCache !== undefined) {
            titleCache.set(id, { title, mtimeMs: artifact.mtime, bytes: artifact.bytes });
          }
        }
      }
    } catch { /* a title is decoration; the id remains the identifier */ }
    spent.foldMs = mark() - foldFrom;
  } else {
    spent.foldMs = 0;
  }

  const sessions = pageIds.map(id => {
    const record = records.get(id);
    const artifact = index.get(id);
    const workspaceId = workspaceBySession.get(id);
    return {
      id,
      title: titles.get(id) ?? "",
      workspaceId: workspaceId ?? "",
      workspaceTitle: workspaceId === undefined ? "" : (workspaceTitles.get(workspaceId) ?? workspaceId),
      cwd: record?.header?.cwd ?? artifact?.project ?? "",
      createdAt: record?.header?.createdAt ?? undefined,
      agentPreset: record?.header?.agentPreset ?? undefined,
      persisted: record?.persisted === true || artifact !== undefined,
      formatStatus: record?.formatStatus ?? undefined,
      bytes: artifact?.bytes ?? undefined,
      mtime: artifact?.mtime ?? undefined,
      // "checkpoint" = read from a persisted projection row (instant, may lag
      // the log); "fold" = read out of the log; "none" = no title found.
      titleSource: titles.has(id) ? (fromCache.has(id) ? "checkpoint" : "fold") : "none"
    };
  });
  sessions.sort((a, b) => (b.createdAt ?? b.mtime ?? 0) - (a.createdAt ?? a.mtime ?? 0));
  spent.totalMs = mark() - started;
  spent.archived = visibleIds.length;
  spent.archivedAll = archivedIds.length;
  if (timings !== undefined) Object.assign(timings, spent);
  return {
    sessions,
    // Both counts are reported, so the reader can say "N hidden" without
    // misreporting how many ids the archive set actually holds.
    archivedCount: visibleIds.length,
    total: visibleIds.length,
    hiddenCount: hiddenByPath.length,
    archivedIdCount: archivedIds.length,
    hasMore: visibleIds.length > pageIds.length,
    // Folded per page in newest-first order, so "load more" walks the archive
    // without ever resolving more titles than the page it is showing.
    timings: spent
  };
}

/**
 * Host half entry point. Registers one read-only route family; the only state
 * change it can perform is the explicit `/unarchive` the user asked for.
 * @param ctx - composed Host context.
 */
export function apply(ctx, config = {}) {
  const dshHome = resolveDshHome(configDshHome(config));
  const sessionsRoot = join(dshHome, "sessions");
  let artifactCache = { at: 0, index: new Map() };
  /**
   * Folded titles keyed by session id, each stamped with the artifact's
   * mtime+size. That fingerprint is what makes the cache safe: a log that has
   * not been written cannot have a newer title, and a rewritten log (a rename)
   * changes the stamp and the entry is refolded on its own.
   */
  const titleCache = new Map();
  /** Workspaces whose archived sessions are machinery, not conversations. */
  const excludedPaths = configExcludedPaths(config);
  /** Last page-side diagnostic report; memory only, replaced on every post. */
  let lastDiagnostic = null;
  const artifacts = async (force = false) => {
    const now = Date.now();
    if (force || now - artifactCache.at > SCAN_TTL_MS) {
      artifactCache = { at: now, index: await scanSessionArtifacts(sessionsRoot) };
    }
    return artifactCache.index;
  };
  const sessionQuery = () => ctx.get("sessionQuery");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.startsWith(API_PREFIX)
        ? url.pathname.slice(API_PREFIX.length) || "/"
        : "/";
      try {
        if (req.method === "GET" && path === "/sessions") {
          // `refresh=1` is the explicit Refresh button: it drops both caches so
          // a just-renamed session shows its new title immediately. Normal
          // opens rely on the fingerprint cache and stay fast.
          const force = url.searchParams.get("refresh") === "1";
          if (force) titleCache.clear();
          const rawLimit = Number(url.searchParams.get("limit") ?? "");
          const artifactIndex = await artifacts(force);
          const result = await listArchived({
            workspaceRegistry: ctx.workspaceRegistry,
            sessionQuery: sessionQuery(),
            sessionsRoot,
            artifactIndex,
            titleCache,
            // The zero-I/O listing read DSH's own session list is built on, plus
            // the same checkpoint read straight off disk for a cold table.
            projectionCache: ctx.get("sessionProjectionCache"),
            projectionCacheDir: join(dshHome, ...PROJECTION_CACHE_SEGMENTS),
            excludedPaths,
            page: Number.isSafeInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined
          });
          return sendJson(res, 200, { ok: true, result });
        }

        if (req.method === "GET" && path === "/transcript") {
          const sessionId = assertSessionId(url.searchParams.get("sessionId") ?? "");
          const query = sessionQuery();
          if (query === undefined || typeof query.readSession !== "function") {
            return sendJson(res, 503, { ok: false, error: "当前部署未提供 sessionQuery 服务，无法读取会话正文" });
          }
          if (![...ctx.workspaceRegistry.archivedSessionIds].map(String).includes(sessionId)) {
            return sendJson(res, 409, { ok: false, error: "该会话当前不处于归档状态，请改用官方会话视图打开" });
          }
          try {
            const result = await transcriptFor(query, sessionId);
            return sendJson(res, 200, { ok: true, result });
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: `读取会话日志失败：${safeErrorMessage(error)}`, code: "read-failed" });
          }
        }

        if (req.method === "GET" && path === "/workspaces") {
          const items = (ctx.workspaceRegistry.list?.() ?? []).map(workspace => ({
            id: String(workspace.id),
            title: workspace.title,
            path: workspace.path
          }));
          return sendJson(res, 200, { ok: true, result: { items } });
        }

        if (req.method === "POST" && path === "/unarchive") {
          const raw = await readBody(req);
          let body = {};
          if (raw.trim() !== "") {
            try { body = JSON.parse(raw); }
            catch { return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          }
          const sessionId = assertSessionId(body?.sessionId ?? "");
          await ctx.workspaceRegistry.unarchiveSession(sessionId);
          return sendJson(res, 200, { ok: true, result: { sessionId, archived: false } });
        }

        /**
         * Drop one archived id whose session no longer exists anywhere.
         *
         * Such ids are debris: the session's directory, its persistence record
         * and its projection checkpoint are all gone, yet the id stays in the
         * archive set — which is why DSH's own session manager cannot show it
         * (it lists sessions from the persistence index) while this list, which
         * reports archive-set membership, still does.
         *
         * This only removes the id from the archive set. It touches no session
         * content, and a session that still exists is refused.
         */
        if (req.method === "POST" && path === "/forget") {
          const raw = await readBody(req);
          let body = {};
          if (raw.trim() !== "") {
            try { body = JSON.parse(raw); }
            catch { return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          }
          const sessionId = assertSessionId(body?.sessionId ?? "");
          const artifactIndex = await artifacts();
          const stillThere = artifactIndex.has(sessionId)
            || (sessionQuery() !== undefined && (await sessionQuery().filterSessions([{ kind: "id", values: [sessionId] }])).length > 0);
          if (stillThere) {
            return sendJson(res, 409, {
              ok: false,
              error: "该会话在本机仍然存在，未清理；请改用「移出归档」或官方会话视图",
              code: "session-exists"
            });
          }
          await ctx.workspaceRegistry.unarchiveSession(sessionId);
          return sendJson(res, 200, { ok: true, result: { sessionId, forgotten: true } });
        }

        // Page-side diagnostics: the Client half and the paste-once probe post
        // what only the browser can observe (factory execution, render failure,
        // footer DOM). Read-only for the Host: capped, kept in memory, never
        // written to disk, and no session state is touched.
        if (req.method === "POST" && path === "/diagnostic") {
          const raw = await readBody(req, 512 * 1024);
          if (raw.trim() === "") return sendJson(res, 400, { ok: false, error: "缺少诊断内容" });
          let body;
          try { body = JSON.parse(raw); }
          catch { return sendJson(res, 400, { ok: false, error: "诊断内容不是合法 JSON" }); }
          lastDiagnostic = { receivedAt: new Date().toISOString(), report: body };
          return sendJson(res, 200, { ok: true, result: { stored: true } });
        }

        if (req.method === "GET" && path === "/diagnostic") {
          return sendJson(res, 200, { ok: true, result: lastDiagnostic });
        }

        return sendJson(res, 404, { ok: false, error: `未知端点 ${req.method} ${path}` });
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : undefined;
        const status = code === "bad-request" ? 400 : 500;
        return sendJson(res, status, { ok: false, error: safeErrorMessage(error), code });
      }
    }
  }), "dsh-archive-viewer: routes");
}
