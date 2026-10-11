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

    /** Small external store so the dialog and the footer button stay in sync. */
    const store = {
      state: {
        open: false,
        sessions: [],
        listPhase: 'idle',
        listError: '',
        query: '',
        selectedId: '',
        transcript: null,
        rowPhase: 'idle',
        rowError: '',
        notice: '',
        workspaces: {}
      },
      listeners: new Set(),
      set(patch) {
        store.state = { ...store.state, ...patch };
        for (const listener of store.listeners) listener();
      },
      subscribe(listener) {
        store.listeners.add(listener);
        return () => { store.listeners.delete(listener); };
      },
      snapshot() { return store.state; }
    };

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

    async function loadSessions() {
      store.set({ listPhase: 'loading', listError: '' });
      try {
        const result = await api('/sessions');
        store.set({ sessions: result.sessions || [], listPhase: 'ready' });
      } catch (error) {
        store.set({ listPhase: 'error', listError: error.message });
      }
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
.aav-sideTop { padding: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.aav-input { width: 100%; box-sizing: border-box; padding: 6px 9px; font: inherit; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.aav-list { flex: 1; overflow: auto; padding: 6px; }
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
.aav-injected { opacity: .72; }
.aav-turn { margin: 16px 0 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.aav-pre { margin: 0; padding: 8px 10px; background: var(--dsw-alias-bg-base); border-top: 1px solid var(--dsw-alias-border-l1);
  white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; max-height: 420px; overflow: auto; }
.aav-summary { cursor: pointer; padding: 6px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.aav-err { color: var(--dsw-alias-state-error-primary); }
.aav-empty { padding: 24px; color: var(--dsw-alias-label-secondary); text-align: center; }
.aav-footerBtn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 32px; padding: 0 10px;
  font: inherit; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid transparent; border-radius: 8px; cursor: pointer; }
.aav-footerBtn:hover { background: var(--dsw-alias-bg-layer-2); }
.aav-footerBtnRail { width: 36px; height: 36px; padding: 0; }
.aav-footerBtnWide { width: 100%; justify-content: flex-start; }
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
      const head = [];
      if (item.kind === 'user') head.push(t('role.user'));
      else if (item.kind === 'assistant') head.push(t('role.assistant'));
      else if (item.kind === 'tool') head.push(t('role.tool', { name: item.name || '' }));
      else head.push(item.label || item.kind);
      if (item.time) head.push(formatTime(item.time));
      if (item.model) head.push(item.model);
      if (item.interrupted) head.push(t('badge.interrupted'));
      if (item.error) head.push(item.error);

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
      return h('div', { className }, h('div', { className: 'aav-msgHead' }, head.filter(Boolean).join(' · ')), body);
    }

    function Transcript(props) {
      const t = props.t;
      const state = props.state;
      const session = props.session;
      const onRestore = props.onRestore;
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
      if (transcript.surfaceAvailable === false) notices.push(h('div', { key: 'raw', className: 'aav-banner' }, t('notice.raw')));
      const restoreButton = h('button', {
        type: 'button',
        className: 'aav-btn aav-btnPrimary',
        onClick: () => onRestore(transcript.sessionId, t)
      }, t('action.restore'));
      const banner = h('div', { className: 'aav-banner' },
        h('span', { className: 'aav-tag' }, t('badge.readonly')),
        h('span', null, t('banner.readonly')),
        state.notice ? h('span', null, state.notice) : null,
        h('span', { className: 'aav-spacer' }),
        restoreButton);
      const flow = h('div', { className: 'aav-flow' },
        notices,
        (transcript.items || []).map(item => h(MessageCard, { key: `${item.kind}:${item.seq}`, item, t })));
      return h(React.Fragment, null, head, banner, flow);
    }

    function Panel(props) {
      const t = props.t;
      const state = useStore();
      const onClose = props.onClose;
      const onRestore = props.onRestore;

      useEffect(() => { loadSessions(); }, []);

      const filtered = useMemo(() => {
        const query = state.query.trim().toLowerCase();
        if (query === '') return state.sessions;
        return state.sessions.filter(session => {
          const haystack = `${session.title || ''} ${session.id} ${session.workspaceTitle || ''} ${session.cwd || ''}`.toLowerCase();
          return haystack.includes(query);
        });
      }, [state.query, state.sessions]);

      const selected = state.sessions.find(session => session.id === state.selectedId) || null;

      const listStatus = [];
      if (state.listPhase === 'loading') listStatus.push(h('div', { key: 'loading', className: 'aav-empty' }, t('loading.list')));
      if (state.listPhase === 'error') listStatus.push(h('div', { key: 'error', className: 'aav-empty aav-err' }, state.listError));
      if (state.listPhase === 'ready' && filtered.length === 0) {
        listStatus.push(h('div', { key: 'empty', className: 'aav-empty' },
          state.sessions.length === 0 ? t('empty.archive') : t('empty.filtered')));
      }

      const rows = filtered.map(session => {
        const meta = [
          formatTime(session.createdAt),
          session.workspaceTitle || '',
          formatBytes(session.bytes),
          session.persisted ? '' : t('badge.missing')
        ].filter(Boolean).join(' · ');
        return h('button', {
          key: session.id,
          type: 'button',
          className: 'aav-row' + (session.id === state.selectedId ? ' aav-rowActive' : ''),
          onClick: () => loadTranscript(session.id)
        },
          h('span', { className: 'aav-rowTitle' }, sessionLabel(session)),
          h('span', { className: 'aav-rowMeta' }, meta));
      });

      const search = h('div', { className: 'aav-sideTop' },
        h('input', {
          className: 'aav-input',
          type: 'search',
          value: state.query,
          placeholder: t('search.placeholder'),
          'aria-label': t('search.placeholder'),
          onChange: (event) => store.set({ query: event.target.value })
        }));

      const side = h('div', { className: 'aav-side' }, search, h('div', { className: 'aav-list' }, listStatus, rows));
      const main = h('div', { className: 'aav-main' }, h(Transcript, { t, state, session: selected, onRestore }));
      const body = h('div', { className: 'aav-body' }, side, main);

      const header = h('div', { className: 'aav-head' },
        h(Icon, { size: 18 }),
        h('h2', null, t('panel.title')),
        h('span', { className: 'aav-headSub' }, t('panel.count', { n: state.sessions.length })),
        h('span', { className: 'aav-spacer' }),
        h('button', { type: 'button', className: 'aav-btn', onClick: () => loadSessions() }, t('action.refresh')),
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
            store.set({ open: true });
            if (store.state.listPhase !== 'loading') loadSessions();
          }
        }, h(Icon, { size: wide ? 15 : 18 }), wide ? h('span', null, label) : null),
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
          report(stage, JSON.stringify({
            wide,
            hasButton: true,
            // isConnected separates "React rendered it" from "the shell kept it".
            connected: node.isConnected === true,
            rect: [Math.round(rect.width), Math.round(rect.height), Math.round(rect.top), Math.round(rect.left)],
            clientRects: node.getClientRects ? node.getClientRects().length : undefined,
            display: style?.display,
            visibility: style?.visibility,
            opacity: style?.opacity,
            color: style?.color,
            label: node.getAttribute('aria-label') || '',
            parentClass: String(node.parentElement?.className ?? '')
          }));
        };
        const timer = window.setTimeout(() => measure('entry:measured'), 1800);
        return () => window.clearTimeout(timer);
      }, [wide]);
      try {
        return h(FooterAction, { ...props, buttonRef });
      } catch (error) {
        report('render:crash', error);
        const label = t('footer.label');
        return h('button', {
          type: 'button',
          ref: buttonRef,
          className: 'aav-footerBtn ' + (wide ? 'aav-footerBtnWide' : 'aav-footerBtnRail'),
          'aria-label': label,
          title: wide ? undefined : label,
          onClick: () => {
            store.set({ open: true });
            if (store.state.listPhase !== 'loading') loadSessions();
          }
        }, h(Icon, { size: wide ? 15 : 18 }), wide ? h('span', null, label) : null);
      }
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        const dictionaries = {
          zh: {
            'panel.title': '归档会话查看器',
            'footer.label': '归档会话查看器',
            'panel.count': '共 {n} 条已归档',
            'action.refresh': '刷新',
            'action.close': '关闭',
            'action.restore': '恢复并继续对话',
            'search.placeholder': '搜索标题 / ID / 备注',
            'loading.list': '正在读取归档列表…',
            'loading.transcript': '正在读取会话正文…',
            'empty.archive': '当前没有已归档的会话',
            'empty.filtered': '没有匹配的会话',
            'empty.select': '从左侧选择一条归档会话',
            'empty.block': '（无正文）',
            'badge.readonly': '只读',
            'badge.missing': '日志缺失',
            'badge.interrupted': '被打断',
            'banner.readonly': '归档状态未被改动，此视图不写入任何会话状态。',
            'notice.truncated': '仅显示最近 {n} 条记录，更早的内容未在此视图加载。',
            'notice.raw': '未能读取当前会话面，以下为原始日志视图。',
            'role.user': '用户',
            'role.assistant': '助手',
            'role.tool': '工具 · {name}',
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
            'footer.label': 'Archived sessions',
            'panel.count': '{n} archived',
            'action.refresh': 'Refresh',
            'action.close': 'Close',
            'action.restore': 'Restore and continue',
            'search.placeholder': 'Search title / ID / notes',
            'loading.list': 'Reading the archive list…',
            'loading.transcript': 'Reading the session log…',
            'empty.archive': 'No archived sessions',
            'empty.filtered': 'No matching sessions',
            'empty.select': 'Pick an archived session on the left',
            'empty.block': '(no content)',
            'badge.readonly': 'read-only',
            'badge.missing': 'log missing',
            'badge.interrupted': 'interrupted',
            'banner.readonly': 'Archive state untouched; this view writes no session state.',
            'notice.truncated': 'Showing the {n} most recent rows; earlier content is not loaded here.',
            'notice.raw': 'The current session surface could not be read; showing the raw log.',
            'role.user': 'User',
            'role.assistant': 'Assistant',
            'role.tool': 'Tool · {name}',
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
            loadSessions();
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
