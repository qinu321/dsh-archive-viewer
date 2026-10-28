/**
 * dsh-archive-viewer — Client half.
 *
 * A read-only archive browser. Why it does not just open the Session through
 * the shipped UI: DSH's Workspace view refuses to surface an archived Session
 * as the current view, so the shipped path unarchives first — a durable state
 * change. The archive set only restricts navigation, not data, so this panel
 * reads the durable log through the Host half's own read-only routes and never
 * touches the archive set. The single mutating control ("恢复并继续对话")
 * calls the Workspace service explicitly, on an explicit click.
 */
window.__ModuleLoader__.load({
  id: 'dsh-archive-viewer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useSyncExternalStore } = React;

    const API = '/archive-viewer/api';
    const NS = 'archive-viewer';
    /** Injected context is hidden by default: measured on one archived session
     * it was 216,688 characters of runtime snapshot / instructions / skill
     * catalog against 3,621 characters of typed prompts. */
    const HIDE_INJECTED_KEY = 'dsh-archive-viewer:hide-injected';
    const readHideInjected = () => {
      try { return window.localStorage.getItem(HIDE_INJECTED_KEY) !== '0'; }
      catch { return true; }
    };

    /** Flip the injected-context preference and remember it across reloads. */
    function toggleHideInjected() {
      const next = !store.state.hideInjected;
      try { window.localStorage.setItem(HIDE_INJECTED_KEY, next ? '1' : '0'); } catch { /* preference only */ }
      store.set({ hideInjected: next });
    }

    /**
     * Fire-and-forget page-side diagnostics. The Host keeps the last report in
     * memory and exposes it on GET /archive-viewer/api/diagnostic, so a failure
     * that only exists inside the browser (factory never ran, apply threw,
     * render threw, icon missing from the DOM) is readable from the outside
     * instead of guessed at. Never throws into the caller.
     */
    const report = (stage, detail) => {
      try {
        void fetch(`${API}/diagnostic`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            stage,
            detail: detail === undefined ? undefined : String(detail && detail.stack || detail),
            at: new Date().toISOString()
          })
        }).catch(() => {});
      } catch { /* diagnostics must never break the plugin */ }
    };
    report('factory:start');

    /**
     * The archive list is derived from DSH's own Client stores: `sessions.list`
     * holds every ordinary Session — archived ones included, which is why the
     * shipped Workspace view can show them with a view option — and
     * `workspaces.list` holds the archive set and workspace membership. The
     * Host is asked exactly once per archive-set change for the three facts
     * those snapshots do not carry (createdAt, artifact size, exclusion of
     * internal machinery). Nothing is paged, so nothing has a page ceiling.
     */
    const LIST_WINDOW = 200;
    const EMPTY_SESSIONS = { ids: [], byId: {} };
    const EMPTY_WORKSPACES = { items: [], archivedSessionIds: [], pinnedSessionIds: [] };

    /** The Client context, captured by `apply`: the stores it carries are the
     * list's data source. Null before apply, which is why every reader uses
     * optional chaining and a stable empty snapshot. */
    let clientCtx = null;
    const sessionsSnapshot = () => clientCtx?.sessions?.list?.getSnapshot?.() ?? EMPTY_SESSIONS;
    const workspacesSnapshot = () => clientCtx?.workspaces?.list?.getSnapshot?.() ?? EMPTY_WORKSPACES;
    const subscribeSessions = (listener) => {
      const model = clientCtx?.sessions?.list;
      return model !== undefined && typeof model.subscribe === 'function' ? model.subscribe(listener) : () => {};
    };
    const subscribeWorkspaces = (listener) => {
      const model = clientCtx?.workspaces?.list;
      return model !== undefined && typeof model.subscribe === 'function' ? model.subscribe(listener) : () => {};
    };

    /** Small external store so the dialog and the footer button stay in sync. */
    const store = {
      state: {
        open: false,
        // The Host's one-shot answer for the whole archive set: createdAt,
        // artifact size, and the internal-machinery exclusion.
        meta: null,
        metaPhase: 'idle',
        metaKey: '',
        metaError: '',
        // Rows painted per click. A rendering window, never a request size, so
        // it cannot cap what the archive holds.
        showCount: LIST_WINDOW,
        query: '',
        // '' = every workspace; a workspace id; or 'ungrouped'. Filtering is
        // local, over every derived row, so a workspace holding more sessions
        // than the window is still counted and searched in full.
        workspaceFilter: '',
        // Set when the chosen workspace lost its last archived session and the
        // reader fell back to "all": a selection must not vanish silently.
        filterDropped: false,
        selectedId: '',
        transcript: null,
        rowPhase: 'idle',
        rowError: '',
        notice: '',
        // Defaults to hiding injected context; the stored preference wins.
        hideInjected: true
      },
      listeners: new Set(),
      set(patch) {
        // Opening the panel always starts from the first window: a previous
        // "show more" must not decide how much a new visit paints.
        const next = patch.open === true ? { ...patch, showCount: LIST_WINDOW } : patch;
        store.state = { ...store.state, ...next };
        for (const listener of store.listeners) listener();
        // Opening the panel is when the metadata has to be there; an archive
        // set that changes while it is open is handled by the snapshot effect.
        if (patch.open === true) void ensureMeta();
      },
      subscribe(listener) {
        store.listeners.add(listener);
        return () => { store.listeners.delete(listener); };
      },
      snapshot() { return store.state; }
    };
    store.state.hideInjected = readHideInjected();

    function useStore() {
      return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
    }

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, options);
      let payload;
      try { payload = await response.json(); }
      catch { throw new Error(`HTTP ${response.status}`); }
      if (payload?.ok !== true) {
        const error = new Error(payload?.error || `HTTP ${response.status}`);
        error.code = payload?.code;
        throw error;
      }
      return payload.result;
    }

    const formatTime = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      const date = new Date(value);
      const pad = (number) => String(number).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };

    const formatBytes = (value) => {
      if (typeof value !== 'number' || value <= 0) return '';
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    };

    /** One session's display title: the folded title, else the first user line. */
    function sessionLabel(session) {
      if (session.title && session.title.trim() !== '') return session.title.trim();
      return session.id;
    }

    /** Key of the archive set the current metadata describes. */
    const archiveKey = () => (workspacesSnapshot().archivedSessionIds ?? []).map(String).join('\0');

    /**
     * Ask the Host for the facts DSH's client snapshots do not carry: createdAt,
     * the durable artifact size, and which ids are internal machinery.
     *
     * One request per archive-set change, never per page — that is what removes
     * the ceiling instead of raising it. A request is skipped while the same key
     * is already loading or already answered, so a re-render cannot storm the
     * Host.
     */
    let metaSeq = 0;
    async function loadMeta(key, options = {}) {
      const force = options.force === true;
      if (!force) {
        if (store.state.metaPhase === 'loading' && store.state.metaKey === key) return;
        // A failed read is retried on the next open instead of being frozen in
        // place: the answer is cheap, and a stale failure is worse than a call.
        if (store.state.meta !== null && store.state.metaKey === key && store.state.metaPhase !== 'error') return;
      }
      const seq = ++metaSeq;
      store.set({ metaPhase: 'loading', metaKey: key, metaError: '' });
      try {
        const result = await api('/meta' + (force ? '?refresh=1' : ''));
        if (seq !== metaSeq) return;
        store.set({
          meta: {
            createdAt: result.createdAt ?? {},
            bytes: result.bytes ?? {},
            mtime: result.mtime ?? {},
            excluded: Array.isArray(result.excluded) ? result.excluded : []
          },
          metaPhase: 'ready',
          metaError: ''
        });
        report('meta:fetched', JSON.stringify({
          createdAt: Object.keys(result.createdAt ?? {}).length,
          excluded: Array.isArray(result.excluded) ? result.excluded.length : 0
        }));
      } catch (error) {
        // Keep the previous answer: without createdAt the list still renders,
        // ordered by updatedAt, and the panel says what is missing.
        if (seq !== metaSeq) return;
        store.set({ metaPhase: 'error', metaError: String(error && error.message) });
      }
    }

    /** Ensure the metadata for the archive set currently in the snapshot. */
    const ensureMeta = (force = false) => loadMeta(archiveKey(), { force });

    /** Comparison key for a workspace path — mirrors the Host half's rule. */
    const workspacePathKey = (value) => {
      if (typeof value !== 'string' || value === '') return '';
      const path = value.replace(/[\\/]+/g, '/').replace(/\/+$/, '') || '/';
      return (/^[a-z]:(?:\/|$)/i.test(path) || path.startsWith('//')) ? path.toLowerCase() : path;
    };

    /** Index workspace views by session and by path — the Host half's two tiers. */
    function indexWorkspaces(items) {
      const bySession = new Map();
      const byPath = new Map();
      const titles = new Map();
      const paths = new Map();
      for (const workspace of items ?? []) {
        if (workspace === null || workspace === undefined) continue;
        const id = String(workspace.workspaceId ?? workspace.id ?? '');
        if (id === '') continue;
        titles.set(id, workspace.title ?? id);
        paths.set(id, typeof workspace.path === 'string' ? workspace.path : '');
        const key = workspacePathKey(workspace.path);
        if (key !== '') {
          if (!byPath.has(key)) byPath.set(key, new Set());
          byPath.get(key).add(id);
        }
        for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
          const member = String(sessionId);
          if (!bySession.has(member)) bySession.set(member, new Set());
          bySession.get(member).add(id);
        }
      }
      return { bySession, byPath, titles, paths };
    }

    /** Workspaces one session belongs to; membership wins over its cwd. */
    function sessionWorkspaces(sessionId, cwd, index) {
      const byMembership = index?.bySession?.get(String(sessionId));
      if (byMembership !== undefined && byMembership.size > 0) return new Set(byMembership);
      return new Set(index?.byPath?.get(workspacePathKey(cwd)) ?? []);
    }

    /**
     * Derive the archive rows from the two snapshots plus the Host metadata.
     *
     * @param archivedIds - the archive set, in registry order.
     * @param sessions - `{ ids, byId }` from `ctx.sessions.list`.
     * @param workspaces - `{ items }` from `ctx.workspaces.list`.
     * @param meta - the Host answer, or null before the first one lands.
     * @returns rows (newest first), workspace options with counts, the
     *   ungrouped count, and how many internal sessions were hidden.
     */
    function deriveRows({ archivedIds, sessions, workspaces, meta }) {
      const byId = sessions?.byId ?? {};
      const index = indexWorkspaces(workspaces?.items ?? []);
      const excluded = new Set(Array.isArray(meta?.excluded) ? meta.excluded : []);
      const createdAt = meta?.createdAt ?? {};
      const bytes = meta?.bytes ?? {};
      const mtime = meta?.mtime ?? {};
      const rows = [];
      let hidden = 0;
      for (const archivedId of archivedIds ?? []) {
        const id = String(archivedId);
        if (excluded.has(id)) { hidden += 1; continue; }
        const summary = byId[id];
        const size = bytes[id];
        // A row is live when either the snapshot knows the Session or its log
        // is on disk. Only an id with neither is archive-set debris; it still
        // gets a row (flagged) so the cleanup action stays reachable.
        const persisted = summary !== undefined || size !== undefined || mtime[id] !== undefined;
        const cwd = typeof summary?.cwd === 'string' ? summary.cwd : '';
        const owners = sessionWorkspaces(id, cwd, index);
        const workspaceId = owners.size > 0 ? [...owners][0] : '';
        const display = typeof summary?.displayTitle === 'string' ? summary.displayTitle.trim() : '';
        const fallback = typeof summary?.title === 'string' ? summary.title.trim() : '';
        rows.push({
          id,
          title: display !== '' ? display : (fallback !== '' ? fallback : id),
          workspaceId,
          workspaceTitle: workspaceId === '' ? '' : (index.titles.get(workspaceId) ?? workspaceId),
          cwd,
          createdAt: Number.isFinite(createdAt[id]) ? createdAt[id] : undefined,
          updatedAt: Number.isFinite(summary?.updatedAt) ? summary.updatedAt : undefined,
          bytes: size,
          persisted
        });
      }
      // Newest first, by the same key the Host list used; a row whose metadata
      // has not arrived falls back to updatedAt, and the id keeps ties stable.
      const timeOf = (row) => (row.createdAt !== undefined
        ? row.createdAt
        : (row.updatedAt !== undefined ? row.updatedAt : (mtime[row.id] ?? 0)));
      rows.sort((left, right) => timeOf(right) - timeOf(left) || left.id.localeCompare(right.id));
      const counts = new Map();
      let ungroupedCount = 0;
      for (const row of rows) {
        if (row.workspaceId === '') { ungroupedCount += 1; continue; }
        counts.set(row.workspaceId, (counts.get(row.workspaceId) ?? 0) + 1);
      }
      const options = [...counts.entries()]
        .map(([id, count]) => ({ id, title: index.titles.get(id) ?? id, path: index.paths.get(id) ?? '', count }))
        .sort((left, right) => left.title.localeCompare(right.title));
      return { rows, options, ungroupedCount, hidden };
    }

    async function loadTranscript(sessionId) {
      store.set({ selectedId: sessionId, rowPhase: 'loading', rowError: '', transcript: null, notice: '' });
      try {
        const result = await api(`/transcript?sessionId=${encodeURIComponent(sessionId)}`);
        if (store.state.selectedId !== sessionId) return;
        store.set({ transcript: result, rowPhase: 'ready' });
      } catch (error) {
        if (store.state.selectedId !== sessionId) return;
        store.set({ rowPhase: 'error', rowError: error.message });
      }
    }

    const CSS = `
.aav-dialog { width: min(1180px, 94vw); height: min(860px, 88vh); padding: 0; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); overflow: hidden; }
.aav-dialog::backdrop { background: rgba(0,0,0,.45); }
.aav-root { display: flex; flex-direction: column; height: 100%; font-size: 13px; }
.aav-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.aav-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
.aav-headSub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.aav-spacer { flex: 1; }
.aav-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; font: inherit; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; cursor: pointer; }
.aav-btn:hover { border-color: var(--dsw-alias-border-l2); }
.aav-btn:disabled { opacity: .5; cursor: default; }
.aav-btnPrimary { border-color: var(--dsw-alias-brand-primary); }
.aav-body { display: flex; flex: 1; min-height: 0; }
.aav-side { width: 306px; min-width: 306px; display: flex; flex-direction: column; border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1)); }
.aav-sideTop { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
/* Workspace selector row: a short label plus the control, so the control keeps
   the leftover width instead of the label pushing the row out of the column. */
.aav-field { display: flex; align-items: center; gap: 8px; }
.aav-fieldLabel { flex: 0 0 auto; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.aav-fieldNote { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.aav-input { width: 100%; box-sizing: border-box; padding: 6px 9px; font: inherit; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
/* A select is not width:100% here: it takes the row's leftover width, so a long
   workspace title is clipped inside the control rather than widening the label
   row (a native select cannot ellipsize its own value). */
.aav-select { width: auto; flex: 1 1 auto; min-width: 0; }
.aav-list { flex: 1; overflow: auto; padding: 6px; }
/* Windows' "automatically hide scroll bars" setting (and Chromium's overlay
   bars) leaves both panes with no position cue: the bar flashes while you
   scroll and fades. A custom scrollbar is painted regardless of that setting,
   and the reserved gutter keeps the rows from shifting when it appears. */
.aav-list, .aav-flow, .aav-pre { scrollbar-gutter: stable; }
.aav-list::-webkit-scrollbar, .aav-flow::-webkit-scrollbar, .aav-pre::-webkit-scrollbar { width: 10px; height: 10px; }
.aav-list::-webkit-scrollbar-track, .aav-flow::-webkit-scrollbar-track, .aav-pre::-webkit-scrollbar-track { background: transparent; }
.aav-list::-webkit-scrollbar-thumb, .aav-flow::-webkit-scrollbar-thumb, .aav-pre::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, var(--dsw-alias-border-l2, rgb(128 128 128 / 45%)));
  border: 2px solid transparent; border-radius: 999px; background-clip: padding-box; }
.aav-list::-webkit-scrollbar-thumb:hover, .aav-flow::-webkit-scrollbar-thumb:hover,
.aav-pre::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-scrollbar-hover-l2, var(--dsw-alias-label-tertiary, rgb(128 128 128 / 65%)));
  background-clip: padding-box; }
.aav-row { display: block; width: 100%; text-align: left; padding: 8px 9px; margin-bottom: 4px; font: inherit; color: inherit;
  background: transparent; border: 1px solid transparent; border-radius: 9px; cursor: pointer; }
.aav-row:hover { background: var(--dsw-alias-bg-layer-2); }
.aav-rowActive { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.aav-rowTitle { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aav-rowMeta { display: block; margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aav-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.aav-mainHead { padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.aav-banner { display: flex; align-items: center; gap: 10px; padding: 8px 14px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.aav-tag { padding: 1px 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; font-size: 11px; }
.aav-flow { flex: 1; overflow: auto; padding: 14px 16px 40px; }
.aav-msg { margin-bottom: 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); overflow: hidden; }
.aav-msgHead { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.aav-msgBody { padding: 9px 11px; white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
.aav-user { border-color: var(--dsw-alias-border-l2); }
.aav-user .aav-msgHead { color: var(--dsw-alias-label-primary); }
.aav-tool .aav-msgBody { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
/* The tool name is the one thing a tool row must show: badge it so a scan of
   the transcript answers "which tool ran" without expanding anything. */
.aav-toolName { padding: 1px 7px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11.5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.aav-badge { padding: 1px 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; font-size: 10.5px;
  color: var(--dsw-alias-label-secondary); }
.aav-injected { opacity: .72; }
/* A compaction boundary: it is a system event, so it reads quieter than a
   message but stays distinct from the injected-context rows. */
.aav-compaction { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.aav-compaction .aav-msgHead { color: var(--dsw-alias-label-primary); }
.aav-turn { margin: 16px 0 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.aav-pre { margin: 0; padding: 8px 10px; background: var(--dsw-alias-bg-base); border-top: 1px solid var(--dsw-alias-border-l1);
  white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; max-height: 420px; overflow: auto; }
.aav-summary { cursor: pointer; padding: 6px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.aav-err { color: var(--dsw-alias-state-error-primary); }
.aav-hiddenNote { padding: 6px 10px 0; font-size: 11px; }
.aav-rowAction { text-align: center; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.aav-loadMore { text-align: center; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.aav-empty { padding: 24px; color: var(--dsw-alias-label-secondary); text-align: center; }
/* Footer entry: the shipped shape — a full-width row with an icon AND its
   label when the sidebar is expanded, and the same icon alone when it is
   collapsed to the rail. A lone glyph was not self-explanatory; the label is
   what names the panel. The footer wraps (see the :has rule below), so the row
   takes its own line instead of squeezing the neighbouring entries. */
.aav-footerBtn { display: inline-flex; box-sizing: border-box; align-items: center; justify-content: center;
  /* A stacking escape hatch: measured on this machine the footer row is
     264px + 33px + 40px wide inside a 280px column, so the last entry can be
     painted under a sibling or clipped. Raising the z-index keeps this entry
     clickable without changing the row's layout. */
  position: relative; z-index: 5;
  font: inherit; white-space: nowrap; overflow: hidden;
  /* Tertiary label colour matches the quieter glyphs of the shipped foot
     controls; the fallback keeps the icon visible if a future theme renames
     the token instead of silently inheriting an invisible colour. */
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor)); background: transparent;
  border: none; cursor: pointer; }
.aav-footerBtn:hover, .aav-footerBtn:focus-visible { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

/* Collapsed sidebar: no room for text, so the entry is a square glyph. */
.aav-footerBtnRail { width: 40px; min-width: 40px; max-width: 40px; height: 40px; padding: 0; margin: 0;
  border-radius: 8px; font-size: 13px; line-height: 1; }

/* Expanded sidebar: icon + label on one full-width row. The label ellipsizes
   rather than widening the column, and the geometry mirrors the shipped
   session-manager entry so both read as the same kind of control. */
.aav-footerBtnWide { flex: 1 1 100%; width: calc(100% + 8px); height: 34px; margin: 4px -4px;
  padding: 6px 10px; gap: 8px; justify-content: flex-start; border-radius: 12px;
  font-size: 14px; line-height: 22px; }
.aav-footerBtnLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

/* A full-row entry needs the footer to wrap into lines; the shipped entries
   declare the same rule, this copy keeps the row sane on a profile where only
   this plugin is installed. */
[class*=footerActions]:has(.aav-footerBtnWide), [class*=footer-actions]:has(.aav-footerBtnWide),
[class*=footer]:has(> .aav-footerBtnWide), [class*=footer] > div:has(> .aav-footerBtnWide) {
  flex-wrap: wrap; align-content: flex-start; height: auto; }
`;

    /** Icon: an archive box with a magnifier — "read the archive". */
    function Icon(props) {
      const size = props.size || 16;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block', flex: '0 0 auto' }
      },
        h('rect', { x: 3, y: 4, width: 13, height: 4, rx: 1 }),
        h('path', { d: 'M4.5 8v10.5a1.5 1.5 0 0 0 1.5 1.5h5' }),
        h('path', { d: 'M6.5 12h5' }),
        h('circle', { cx: 16, cy: 15, r: 4 }),
        h('path', { d: 'M19 18l2.5 2.5' })
      );
    }

    function MessageCard(props) {
      const item = props.item;
      const t = props.t;
      if (item.kind === 'turn') {
        return h('div', { className: 'aav-turn' }, item.phase === 'start'
          ? t('turn.start', { n: item.turn })
          : t('turn.end', { n: item.turn, reason: item.reason || '' }));
      }
      if (item.kind === 'title') {
        return h('div', { className: 'aav-turn' }, t('title.row', { title: item.text }));
      }
      // A compaction is not a message the user typed: it is the summary DSH
      // wrote into the model context in place of an earlier span. The span
      // itself stays in the log above, so this card explains the boundary
      // instead of pretending to be a prompt.
      if (item.kind === 'compaction') {
        const head = [
          t('compaction.label'),
          item.time ? formatTime(item.time) : '',
          item.shadowed ? t('compaction.shadowed', { n: item.shadowed }) : '',
          item.provider || ''
        ].filter(Boolean).join(' · ');
        return h('div', { className: 'aav-msg aav-compaction' },
          h('div', { className: 'aav-msgHead' }, head),
          h('div', { className: 'aav-msgBody' }, t('compaction.note')),
          item.text
            ? h('details', { className: 'aav-compactionDetails' },
                h('summary', { className: 'aav-summary' }, t('compaction.show')),
                h('pre', { className: 'aav-pre' }, item.text))
            : h('div', { className: 'aav-msgBody' }, t('compaction.empty')));
      }
      // The header carries the tool name as its own badge: the whole point of
      // a tool row is knowing WHICH tool ran, so it must not be buried in a
      // joined metadata string.
      const metaParts = [];
      if (item.time) metaParts.push(formatTime(item.time));
      if (item.model) metaParts.push(item.model);
      if (item.interrupted) metaParts.push(t('badge.interrupted'));
      if (item.error) metaParts.push(item.error);

      let header;
      if (item.kind === 'tool') {
        const badges = [];
        if (item.name && item.name !== '') badges.push(h('span', { key: 'name', className: 'aav-toolName' }, item.name));
        else badges.push(h('span', { key: 'name', className: 'aav-toolName' }, t('tool.unknown')));
        if (item.paired === false) badges.push(h('span', { key: 'state', className: 'aav-badge' }, t('tool.resultOnly')));
        header = h('div', { className: 'aav-msgHead' }, badges, metaParts.join(' · '));
      } else {
        const head = [];
        if (item.kind === 'user') head.push(t('role.user'));
        else if (item.kind === 'assistant') head.push(t('role.assistant'));
        else head.push(item.label || item.kind);
        head.push(...metaParts);
        header = h('div', { className: 'aav-msgHead' }, head.filter(Boolean).join(' · '));
      }

      const className = 'aav-msg' + (item.kind === 'user' ? ' aav-user' : '')
        + (item.kind === 'tool' ? ' aav-tool' : '')
        + (item.kind === 'injected' ? ' aav-injected' : '');

      const body = [];
      if (item.kind === 'assistant' && item.reasoning) {
        body.push(h('details', { key: 'reasoning' },
          h('summary', { className: 'aav-summary' }, t('reasoning.show')),
          h('pre', { className: 'aav-pre' }, item.reasoning)));
      }
      if (item.text && item.text !== '') {
        body.push(h('div', { key: 'text', className: 'aav-msgBody' }, item.text));
      }
      if (item.kind === 'tool') {
        if (item.args && item.args !== '') {
          body.push(h('details', { key: 'args' },
            h('summary', { className: 'aav-summary' }, t('tool.args')),
            h('pre', { className: 'aav-pre' }, item.args)));
        }
        if (item.result !== undefined && item.result !== '') {
          body.push(h('details', { key: 'result' },
            h('summary', { className: 'aav-summary' }, item.error ? t('tool.resultError') : t('tool.result')),
            h('pre', { className: 'aav-pre' }, item.result)));
        } else if (item.error) {
          body.push(h('div', { key: 'err', className: 'aav-msgBody aav-err' }, item.error));
        }
      }
      if (body.length === 0) body.push(h('div', { key: 'empty', className: 'aav-msgBody' }, t('empty.block')));
      return h('div', { className }, header, body);
    }

    function Transcript(props) {
      const t = props.t;
      const state = props.state;
      const session = props.session;
      const onRestore = props.onRestore;
      // One conversation per session: keeping the previous scroll offset would
      // open the next log halfway through. Declared before the early returns so
      // the hook order never changes between phases.
      const flowRef = React.useRef(null);
      const transcriptKey = state.transcript?.sessionId ?? state.selectedId ?? '';
      useEffect(() => {
        const node = flowRef.current;
        if (node !== null) node.scrollTop = 0;
      }, [transcriptKey]);
      if (state.rowPhase === 'loading') return h('div', { className: 'aav-empty' }, t('loading.transcript'));
      if (state.rowPhase === 'error') return h('div', { className: 'aav-empty aav-err' }, state.rowError);
      const transcript = state.transcript;
      if (!transcript) return h('div', { className: 'aav-empty' }, t('empty.select'));
      const header = transcript.header || {};
      const meta = [
        formatTime(header.createdAt),
        header.cwd,
        header.agentPreset ? t('meta.preset', { name: header.agentPreset }) : '',
        t('meta.events', { n: transcript.eventCount }),
        t('meta.rows', { n: transcript.rowCount })
      ].filter(Boolean).join(' · ');
      const head = h('div', { className: 'aav-mainHead' },
        h('div', null, session ? sessionLabel(session) : transcript.sessionId),
        h('div', { className: 'aav-rowMeta' }, meta),
        h('div', { className: 'aav-rowMeta' }, transcript.sessionId));
      const notices = [];
      if (transcript.truncated) notices.push(h('div', { key: 'truncated', className: 'aav-banner' }, t('notice.truncated', { n: transcript.rowCount })));
      const all = transcript.items || [];
      const injectedRows = all.filter(item => item.kind === 'injected').length;
      const items = state.hideInjected ? all.filter(item => item.kind !== 'injected') : all;
      if (state.hideInjected && injectedRows > 0) {
        notices.push(h('div', { key: 'injected', className: 'aav-banner' }, t('notice.injectedHidden', { n: injectedRows })));
      }
      const restoreButton = h('button', {
        type: 'button',
        className: 'aav-btn aav-btnPrimary',
        onClick: () => onRestore(transcript.sessionId, t)
      }, t('action.restore'));
      const injectedToggle = h('button', {
        type: 'button',
        className: 'aav-btn',
        'aria-pressed': state.hideInjected,
        onClick: () => toggleHideInjected()
      }, state.hideInjected ? t('action.showInjected', { n: injectedRows }) : t('action.hideInjected'));
      const banner = h('div', { className: 'aav-banner' },
        h('span', { className: 'aav-tag' }, t('badge.readonly')),
        h('span', null, t('banner.readonly')),
        state.notice ? h('span', null, state.notice) : null,
        h('span', { className: 'aav-spacer' }),
        injectedToggle,
        restoreButton);
      const flow = h('div', { className: 'aav-flow', ref: flowRef },
        notices,
        items.map(item => h(MessageCard, { key: `${item.kind}:${item.seq}`, item, t })));
      return h(React.Fragment, null, head, banner, flow);
    }

    function Panel(props) {
      const t = props.t;
      const state = useStore();
      const onClose = props.onClose;
      const onRestore = props.onRestore;
      const sessions = useSyncExternalStore(subscribeSessions, sessionsSnapshot, sessionsSnapshot);
      const workspaces = useSyncExternalStore(subscribeWorkspaces, workspacesSnapshot, workspacesSnapshot);
      const archivedIds = workspaces.archivedSessionIds ?? [];
      const archivedKey = archivedIds.join('\0');

      // The archive set is live: a Session archived elsewhere appears here, and
      // one restored elsewhere leaves. The Host metadata is fetched when the
      // panel opens and again only when that set changes — never per page,
      // because there is no page.
      useEffect(() => {
        if (state.open) void ensureMeta();
      }, [state.open, archivedKey]);

      const derived = useMemo(
        () => deriveRows({ archivedIds, sessions, workspaces, meta: state.meta }),
        [archivedKey, sessions, workspaces, state.meta]
      );

      // A workspace that lost its last archived Session stops being offered.
      // The list answers as "all" immediately; the effect persists the choice
      // so the selector cannot keep showing a value that is not in force.
      const filterOffered = state.workspaceFilter === ''
        || (state.workspaceFilter === 'ungrouped'
          ? derived.ungroupedCount > 0
          : derived.options.some(option => option.id === state.workspaceFilter));
      const filterValue = filterOffered ? state.workspaceFilter : '';
      const dropped = state.filterDropped || (!filterOffered && state.workspaceFilter !== '');
      useEffect(() => {
        if (!state.open || filterOffered) return;
        store.set({ workspaceFilter: '', filterDropped: true, showCount: LIST_WINDOW });
      }, [state.open, filterOffered, state.workspaceFilter]);

      const query = state.query.trim().toLowerCase();
      const byWorkspace = filterValue === ''
        ? derived.rows
        : derived.rows.filter(row => filterValue === 'ungrouped' ? row.workspaceId === '' : row.workspaceId === filterValue);
      const filtered = query === ''
        ? byWorkspace
        : byWorkspace.filter(row => `${row.title} ${row.id} ${row.workspaceTitle} ${row.cwd}`.toLowerCase().includes(query));
      const shown = filtered.slice(0, state.showCount);
      const selected = derived.rows.find(row => row.id === state.selectedId) ?? null;

      // A different filter or query is a different list: carrying the previous
      // offset into it lands the reader in the middle of rows they did not ask
      // for. The window itself is not a scroll container, so only the scroller
      // is reset.
      const listRef = React.useRef(null);
      const sliceKey = filterValue + '\u0000' + query;
      useEffect(() => {
        const node = listRef.current;
        if (node !== null) node.scrollTop = 0;
      }, [sliceKey]);

      // The two snapshots and the metadata answer at different times; the panel
      // only claims "loading" while there is nothing at all to draw.
      const storesPending = workspaces.phase === 'pending' || sessions.phase === 'pending';
      const listLoading = storesPending || (state.meta === null && state.metaPhase === 'loading');
      const listStatus = [];
      if (listLoading) listStatus.push(h('div', { key: 'loading', className: 'aav-empty' }, t('loading.list')));
      if (state.metaPhase === 'error') {
        listStatus.push(h('div', { key: 'metaError', className: 'aav-fieldNote aav-err' }, t('notice.metaFailed')));
      }
      if (!listLoading && filtered.length === 0) {
        // Three different empties: no archive at all, nothing in the chosen
        // workspace, or the search box excluded everything.
        const emptyKey = derived.rows.length === 0
          ? (filterValue === '' ? 'empty.archive' : 'empty.workspace')
          : 'empty.filtered';
        listStatus.push(h('div', { key: 'empty', className: 'aav-empty' }, t(emptyKey)));
      }

      const hiddenNote = derived.hidden > 0
        ? h('div', { key: 'hidden', className: 'aav-rowMeta aav-hiddenNote' }, t('panel.hidden', { n: derived.hidden }))
        : null;

      // A dropped selection has to be stated where the selector is, not silently
      // applied: otherwise the dropdown just jumps back to "all" on its own.
      const droppedNote = dropped && !listLoading
        ? h('div', { key: 'dropped', className: 'aav-rowMeta aav-hiddenNote' }, t('notice.filterDropped'))
        : null;

      // A rendering window over rows the panel already holds: clicking it asks
      // the Host for nothing, so it cannot run into a request cap.
      const showMore = filtered.length > shown.length
        ? h('button', {
            key: 'more',
            type: 'button',
            className: 'aav-row aav-loadMore',
            onClick: () => store.set({ showCount: store.state.showCount + LIST_WINDOW })
          }, t('action.showMore', { n: filtered.length - shown.length }))
        : null;

      const rows = [];
      for (const session of shown) {
        const dead = session.persisted === false;
        const rowMeta = [
          formatTime(session.createdAt),
          session.workspaceTitle || '',
          formatBytes(session.bytes),
          dead ? t('badge.dead') : ''
        ].filter(Boolean).join(' · ');
        rows.push(h('button', {
          key: session.id,
          type: 'button',
          className: 'aav-row' + (session.id === state.selectedId ? ' aav-rowActive' : ''),
          onClick: () => { if (!dead) loadTranscript(session.id); }
        },
          h('span', { className: 'aav-rowTitle' }, sessionLabel(session)),
          h('span', { className: 'aav-rowMeta' }, rowMeta)));
        // A row whose session is gone everywhere (no directory, no persistence
        // record, no checkpoint) is debris in the archive set: DSH's own session
        // manager cannot even list it. Offer the one useful action — drop it.
        if (dead) {
          rows.push(h('button', {
            key: session.id + ':forget',
            type: 'button',
            className: 'aav-row aav-rowAction',
            onClick: async () => {
              store.set({ notice: '' });
              try {
                const result = await api('/forget', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sessionId: session.id })
                });
                // The archive set is a live snapshot: dropping the id there is
                // what removes the row, so no local list surgery is needed.
                store.set({ notice: t('notice.forgotten', { id: result?.sessionId ?? session.id }) });
              } catch (error) {
                store.set({ notice: t('notice.forgetFailed', { message: error.message }) });
              }
            }
          }, t('action.forget')));
        }
      }

      // The workspace selector sits above the search box: choosing a workspace
      // is the coarse cut, typing is the fine one. Both are applied to the full
      // derived row set, so neither under-reports a workspace larger than the
      // rendering window.
      const workspaceField = h('label', { key: 'workspace', className: 'aav-field' },
        h('span', { className: 'aav-fieldLabel' }, t('filter.workspace')),
        h('select', {
          // No aria-label: the wrapping <label> supplies the accessible name,
          // and an aria-label here would override the visible text.
          className: 'aav-input aav-select',
          value: filterValue,
          onChange: (event) => store.set({
            workspaceFilter: event.target.value,
            filterDropped: false,
            showCount: LIST_WINDOW
          })
        },
          h('option', { value: '' }, derived.rows.length > 0
            ? t('filter.workspace.allN', { n: derived.rows.length })
            : t('filter.workspace.all')),
          derived.ungroupedCount > 0
            ? h('option', { value: 'ungrouped' }, t('filter.workspace.ungrouped', { n: derived.ungroupedCount }))
            : null,
          // The directory is the one thing that tells two same-titled
          // workspaces apart, so it is the option's tooltip.
          derived.options.map(option => h('option', { key: option.id, value: option.id, title: option.path || option.title },
            t('filter.workspace.option', { title: option.title, n: option.count })))
        ));

      const search = h('div', { className: 'aav-sideTop' },
        workspaceField,
        h('input', {
          className: 'aav-input',
          type: 'search',
          value: state.query,
          placeholder: t('search.placeholder'),
          'aria-label': t('search.placeholder'),
          onChange: (event) => store.set({ query: event.target.value })
        }));

      const side = h('div', { className: 'aav-side' }, search, h('div', { className: 'aav-list', ref: listRef }, listStatus, droppedNote, rows, showMore, hiddenNote));
      const main = h('div', { className: 'aav-main' }, h(Transcript, { t, state, session: selected, onRestore }));
      const body = h('div', { className: 'aav-body' }, side, main);

      const header = h('div', { className: 'aav-head' },
        h(Icon, { size: 18 }),
        h('h2', null, t('panel.title')),
        h('span', { className: 'aav-headSub' }, t('panel.count', { shown: shown.length, n: filtered.length })),
        h('span', { className: 'aav-spacer' }),
        h('button', { type: 'button', className: 'aav-btn', onClick: () => { store.set({ showCount: LIST_WINDOW, filterDropped: false }); return ensureMeta(true); } }, t('action.refresh')),
        h('button', { type: 'button', className: 'aav-btn', onClick: onClose }, t('action.close')));

      return h(React.Fragment, null, h('style', null, CSS), h('div', { className: 'aav-root' }, header, body));
    }

    function Dialog(props) {
      const t = props.t;
      const state = useStore();
      const dialogRef = React.useRef(null);
      useEffect(() => {
        const node = dialogRef.current;
        if (!node) return undefined;
        if (state.open && !node.open) { try { node.showModal(); } catch { node.setAttribute('open', ''); } }
        if (!state.open && node.open) { try { node.close(); } catch { node.removeAttribute('open'); } }
        return undefined;
      }, [state.open]);
      useEffect(() => {
        const node = dialogRef.current;
        if (!node) return undefined;
        const onCancel = (event) => { event.preventDefault(); store.set({ open: false }); };
        node.addEventListener('cancel', onCancel);
        return () => node.removeEventListener('cancel', onCancel);
      }, []);
      return h('dialog', { ref: dialogRef, className: 'aav-dialog', 'aria-label': t('panel.title') },
        state.open ? h(Panel, { t, onClose: () => store.set({ open: false }), onRestore: props.onRestore }) : null);
    }

    function FooterAction(props) {
      const t = props.t;
      const state = useStore();
      const wide = props.wide === true;
      const label = t('footer.label');
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          ref: props.buttonRef ?? null,
          className: 'aav-footerBtn ' + (wide ? 'aav-footerBtnWide' : 'aav-footerBtnRail'),
          'aria-label': label,
          title: wide ? undefined : label,
          onClick: () => {
            // Opening is all it takes: the panel derives the list from the live
            // snapshots and asks the Host once for the metadata it lacks.
            store.set({ open: true, filterDropped: false });
          }
        }, h(Icon, { size: wide ? 16 : 20 }),
          wide ? h('span', { className: 'aav-footerBtnLabel' }, label) : null),
        h(Dialog, { t, onRestore: props.onRestore }));
    }

    /**
     * Slot entry wrapper. A throw inside the entry would otherwise be swallowed
     * by the slot's boundary and leave the footer silently empty — the exact
     * symptom that is being chased right now — so the failure is reported back
     * to the Host and a bare icon-only fallback keeps the panel reachable.
     */
    function SlotEntry(props) {
      const t = props.t;
      const wide = props.wide === true;
      const buttonRef = React.useRef(null);
      const announced = React.useRef(false);
      // One mount announcement per page: proves whether the entry really
      // rendered and how much space the sidebar gave it. Never repeats.
      useEffect(() => {
        if (announced.current) return;
        announced.current = true;
        const measure = (stage) => {
          const node = buttonRef.current;
          if (node === null || node === undefined) { report(stage, JSON.stringify({ hasButton: false })); return; }
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle ? window.getComputedStyle(node) : undefined;
          // Walk up from the button so the report covers the whole footer row,
          // not just this entry: the user reports the session-manager button
          // overflowing the sidebar and squashing the memory button, which is
          // container-level, not specific to this plugin.
          const row = node.parentElement;
          const box = (element) => {
            if (element === null || element === undefined) return null;
            const r = element.getBoundingClientRect();
            const s = window.getComputedStyle ? window.getComputedStyle(element) : undefined;
            return {
              cls: String(element.className ?? '').slice(0, 60),
              rect: [Math.round(r.width), Math.round(r.height), Math.round(r.top), Math.round(r.left)],
              display: s?.display,
              flex: s?.flex,
              width: s?.width,
              minWidth: s?.minWidth,
              overflow: s?.overflow,
              whiteSpace: s?.whiteSpace,
              text: String(element.textContent ?? '').trim().slice(0, 18)
            };
          };
          const siblings = row === null || row === undefined ? [] : [...row.children].map(box);
          const findSidebar = () => {
            let current = node.parentElement;
            while (current !== null && current !== undefined) {
              if (/sidebar/i.test(String(current.className ?? '')) || current.hasAttribute?.('data-dsh-sidebar')) return current;
              current = current.parentElement;
            }
            return null;
          };
          const sidebar = findSidebar();
          report(stage, JSON.stringify({
            wide,
            hasButton: true,
            // isConnected separates "React rendered it" from "the shell kept it".
            connected: node.isConnected === true,
            rect: [Math.round(rect.width), Math.round(rect.height), Math.round(rect.top), Math.round(rect.left)],
            clientRects: node.getClientRects ? node.getClientRects().length : undefined,
            display: style?.display,
            position: style?.position,
            cssWidth: style?.width,
            cssHeight: style?.height,
            visibility: style?.visibility,
            opacity: style?.opacity,
            color: style?.color,
            // The resolved painter colour of the glyph itself, so a theme
            // token that failed to resolve shows up as a value, not a guess.
            iconStroke: (() => {
              const svg = node.querySelector('svg');
              return svg === null ? undefined : window.getComputedStyle(svg).stroke;
            })(),
            label: node.getAttribute('aria-label') || '',
            parentClass: String(node.parentElement?.className ?? ''),
            // Whether our own stylesheet reached the document at all.
            styleTags: document.querySelectorAll('style').length,
            hasOurRule: [...document.querySelectorAll('style')].some(tag => String(tag.textContent).includes('.aav-footerBtn')),
            inSidebar: sidebar !== null,
            sidebar: box(sidebar),
            row: box(row),
            siblings
          }));
        };
        const timer = window.setTimeout(() => measure('entry:measured'), 1800);
        return () => window.clearTimeout(timer);
      }, [wide]);
      try {
        return h(React.Fragment, null,
          h('style', null, CSS),
          h(FooterAction, { ...props, buttonRef }));
      } catch (error) {
        report('render:crash', error);
        const label = t('footer.label');
        return h(React.Fragment, null,
          h('style', null, CSS),
          h('button', {
            type: 'button',
            ref: buttonRef,
            className: 'aav-footerBtn ' + (wide ? 'aav-footerBtnWide' : 'aav-footerBtnRail'),
            'aria-label': label,
            title: wide ? undefined : label,
            onClick: () => {
              store.set({ open: true, filterDropped: false });
            }
          }, h(Icon, { size: wide ? 16 : 20 }),
            wide ? h('span', { className: 'aav-footerBtnLabel' }, label) : null));
      }
    }

    return {
      // `sessions` and `workspaces` are the list's data source: the snapshot
      // DSH already holds for the sidebar, which is also where archived
      // sessions live. No list route is declared here on purpose.
      inject: ['slots', 'locale', 'uiWorkspace', 'sessions', 'workspaces'],
      /**
       * Testability seam: the offline harness (client-selftest.mjs) drives this
       * state directly to render the transcript without a browser, and calls
       * the row derivation with synthetic snapshots. A getter, so it always
       * reflects the live store object, and a setter that goes through the real
       * store so subscribers (the rendered tree) update. Nothing in the plugin
       * or the Host reads either.
       */
      get __state() { return store.state; },
      __setState(patch) { store.set(patch); },
      __deriveRows: deriveRows,
      apply(ctx) {
        clientCtx = ctx;
        // The archive set is live, and the metadata describes it: refetch when
        // it changes while the panel is open. The Panel's own subscription
        // repaints the rows; this one refreshes createdAt/size for new ids.
        ctx.effect(() => {
          const model = ctx.workspaces?.list;
          if (model === undefined || typeof model.subscribe !== 'function') return () => {};
          return model.subscribe(() => { if (store.state.open) void ensureMeta(); });
        }, 'archive-viewer: archive set');
        const dictionaries = {
          zh: {
            'panel.title': '归档会话查看器',
            'footer.label': '查看归档',
            'panel.count': '已列出 {shown} / 共 {n} 条',
            'panel.hidden': '已隐藏 {n} 条内部会话（记忆中枢等自动会话）',
            'action.refresh': '刷新',
            'action.showMore': '显示更多（还有 {n} 条）',
            'action.close': '关闭',
            'action.restore': '恢复并继续对话',
            'action.hideInjected': '隐藏注入上下文',
            'action.showInjected': '显示注入上下文（{n}）',
            'search.placeholder': '搜索标题 / ID / 备注',
            'filter.workspace': '工作区',
            'filter.workspace.all': '全部工作区',
            'filter.workspace.allN': '全部工作区（{n}）',
            'filter.workspace.ungrouped': '未分组（{n}）',
            'filter.workspace.option': '{title}（{n}）',
            'notice.filterDropped': '所选工作区已没有归档会话，已切回「全部工作区」。',
            'notice.metaFailed': '未能读取创建时间与日志大小（宿主无响应），列表仍可浏览。',
            'loading.list': '正在读取归档列表…',
            'loading.transcript': '正在读取会话正文…',
            'empty.archive': '当前没有已归档的会话',
            'empty.workspace': '该工作区没有已归档的会话',
            'empty.filtered': '没有匹配的会话',
            'empty.select': '从左侧选择一条归档会话',
            'empty.block': '（无正文）',
            'badge.readonly': '只读',
            'badge.missing': '日志缺失',
            'badge.dead': '会话已不存在',
            'action.forget': '清理这条残留记录',
            'notice.forgotten': '已从归档集移除残留记录 {id}',
            'notice.forgetFailed': '清理失败：{message}',
            'badge.interrupted': '被打断',
            'banner.readonly': '归档状态未被改动，此视图不写入任何会话状态。',
            'notice.truncated': '仅显示最近 {n} 条记录，更早的内容未在此视图加载。',
            'notice.injectedHidden': '已隐藏 {n} 条注入上下文（系统提示、运行时快照、技能目录等）。',
            'compaction.label': '上下文压缩',
            'compaction.shadowed': '折叠了 {n} 条更早的记录',
            'compaction.show': '查看压缩摘要',
            'compaction.note': '这是当时写进模型上下文的压缩摘要，用来替代更早的一段对话；被替代的原文仍按原样保留在上方。',
            'compaction.empty': '（这次压缩没有留下摘要文本）',
            'role.user': '用户',
            'role.assistant': '助手',
            'role.tool': '工具 · {name}',
            'tool.unknown': '(未记录工具名)',
            'tool.resultOnly': '仅结果',
            'reasoning.show': '思考过程',
            'tool.args': '参数',
            'tool.result': '结果',
            'tool.resultError': '结果（错误）',
            'title.row': '会话标题：{title}',
            'turn.start': '──── 第 {n} 轮开始 ────',
            'turn.end': '──── 第 {n} 轮结束（{reason}）────',
            'meta.preset': '预设 {name}',
            'meta.events': '{n} 个事件',
            'meta.rows': '{n} 条记录',
            'restored': '已取消归档，请从左侧会话列表打开它。',
            'restore.failed': '取消归档失败：{message}'
          },
          en: {
            'panel.title': 'Archived session viewer',
            'footer.label': 'View archive',
            'panel.count': '{shown} of {n} listed',
            'panel.hidden': 'Hid {n} internal sessions (auto-created workbench sessions)',
            'action.refresh': 'Refresh',
            'action.showMore': 'Show more ({n} left)',
            'action.close': 'Close',
            'action.restore': 'Restore and continue',
            'action.hideInjected': 'Hide injected context',
            'action.showInjected': 'Show injected context ({n})',
            'search.placeholder': 'Search title / ID / notes',
            'filter.workspace': 'Workspace',
            'filter.workspace.all': 'All workspaces',
            'filter.workspace.allN': 'All workspaces ({n})',
            'filter.workspace.ungrouped': 'Ungrouped ({n})',
            'filter.workspace.option': '{title} ({n})',
            'notice.filterDropped': 'That workspace has no archived sessions left; switched back to all workspaces.',
            'notice.metaFailed': 'Could not read creation times or log sizes from the Host; the list still works.',
            'loading.list': 'Reading the archive list…',
            'loading.transcript': 'Reading the session log…',
            'empty.archive': 'No archived sessions',
            'empty.workspace': 'No archived sessions in this workspace',
            'empty.filtered': 'No matching sessions',
            'empty.select': 'Pick an archived session on the left',
            'empty.block': '(no content)',
            'badge.readonly': 'read-only',
            'badge.missing': 'log missing',
            'badge.dead': 'session no longer exists',
            'action.forget': 'Remove this leftover record',
            'notice.forgotten': 'Removed leftover record {id} from the archive set',
            'notice.forgetFailed': 'Cleanup failed: {message}',
            'badge.interrupted': 'interrupted',
            'banner.readonly': 'Archive state untouched; this view writes no session state.',
            'notice.truncated': 'Showing the {n} most recent rows; earlier content is not loaded here.',
            'notice.injectedHidden': 'Hid {n} injected-context rows (system prompt, runtime snapshot, skill catalog).',
            'compaction.label': 'Context compaction',
            'compaction.shadowed': 'folded {n} earlier records',
            'compaction.show': 'Show the compaction summary',
            'compaction.note': 'This is the summary DSH wrote into the model context in place of an earlier span; those original messages are kept above, verbatim.',
            'compaction.empty': '(this compaction left no summary text)',
            'role.user': 'User',
            'role.assistant': 'Assistant',
            'role.tool': 'Tool · {name}',
            'tool.unknown': '(tool name not logged)',
            'tool.resultOnly': 'result only',
            'reasoning.show': 'Reasoning',
            'tool.args': 'Arguments',
            'tool.result': 'Result',
            'tool.resultError': 'Result (error)',
            'title.row': 'Session title: {title}',
            'turn.start': '──── turn {n} started ────',
            'turn.end': '──── turn {n} ended ({reason}) ────',
            'meta.preset': 'preset {name}',
            'meta.events': '{n} events',
            'meta.rows': '{n} rows',
            'restored': 'Unarchived. Open it from the session list.',
            'restore.failed': 'Unarchive failed: {message}'
          }
        };

        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'archive-viewer: dictionaries');

        const restore = async (sessionId, t) => {
          const translate = typeof t === 'function' ? t : (key) => key;
          try {
            const canOpen = Boolean(ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === 'function');
            if (ctx.uiWorkspace && typeof ctx.uiWorkspace.unarchiveSession === 'function') {
              await ctx.uiWorkspace.unarchiveSession(sessionId);
            } else {
              await api('/unarchive', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId })
              });
            }
            store.set({ open: false });
            if (canOpen) ctx.uiWorkspace.openSession(sessionId);
            else store.set({ notice: translate('restored') });
            // The archive set is a live snapshot: unarchiving removes the row
            // on its own, so there is no local list to refresh here.
          } catch (error) {
            store.set({ notice: translate('restore.failed').replace('{message}', error.message) });
          }
        };

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'archive-viewer-footer',
          order: 31,
          locale: NS
        }, (ownerProps) => h(SlotEntry, { ...ownerProps, onRestore: restore })));
        report('apply:registered');
      }
    };
  }
});













