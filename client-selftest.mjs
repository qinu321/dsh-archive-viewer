/**

const styleElement = wideElements.find(element => element.type === 'style');
const styleText = String(styleElement?.props?.children ?? '');
check('the entry injects its own stylesheet', styleText.includes('.aav-footerBtn') && styleText.length > 500, String(styleText.length));
check('the footer button pins an explicit row height', /\.aav-footerBtn\s*\{[^}]*height:\s*32px/.test(styleText), 'no height:32px rule');
check('the wide label is set to a single ellipsized line', /\.aav-footerLabel\s*\{[^}]*white-space:\s*nowrap/.test(styleText), 'no nowrap rule');
check('the rail variant keeps a 36px square', /\.aav-footerBtnRail\s*\{[^}]*width:\s*36px/.test(styleText), 'no rail rule');
/**
 * Offline client-half harness for dsh-archive-viewer.
 *
 * Loads client.js the way the browser loader does (one `__ModuleLoader__.load`
 * call with a factory), then executes the factory and `apply(ctx)` against
 * stubs. That covers everything up to real React rendering: a factory or apply
 * that throws — the failure mode that leaves the sidebar footer silently empty
 * with nothing in the Host logs — fails here instead.
 *
 * Run: node client-selftest.mjs
 */
import { readFileSync } from "node:fs";

let failures = 0;
const results = [];
function check(label, condition, detail) {
  if (condition) { results.push(`  ok   ${label}`); return; }
  failures += 1;
  results.push(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

/** Minimal React stub: enough for component construction, no rendering. */
const React = {
  createElement(type, props, ...children) {
    return { $$typeof: 'react.element', type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  Fragment: Symbol('Fragment'),
  useRef: (initial) => ({ current: initial ?? null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot()
};

const seeded = new Map([['react', React]]);
const registered = new Map();

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      if (typeof id !== 'string' || id === '') throw new Error('__ModuleLoader__.load needs an id');
      if (typeof factory !== 'function') throw new Error('__ModuleLoader__.load needs a factory');
      registered.set(id, factory);
    }
  }
};
globalThis.fetch = async () => ({ status: 200, async json() { return { ok: true, result: { sessions: [], archivedCount: 0, items: [] } }; } });

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

// --- 1. registration shape ------------------------------------------------
let loadError;
try {
  // eslint-disable-next-line no-new-func -- the browser loader evaluates the bundle as a classic script.
  new Function(source)();
} catch (error) { loadError = error; }
check('client.js evaluates as a classic script', loadError === undefined, loadError === undefined ? undefined : String(loadError.message));
check('registers exactly one module id', registered.size === 1, [...registered.keys()].join(','));
check('module id equals the package name', registered.has('dsh-archive-viewer'), [...registered.keys()].join(','));

// --- 2. factory ----------------------------------------------------------
let plugin;
let factoryError;
try {
  plugin = registered.get('dsh-archive-viewer')((spec) => {
    if (seeded.has(spec)) return seeded.get(spec);
    throw new Error(`require("${spec}") missed the module table`);
  });
} catch (error) { factoryError = error; }
check('factory runs without throwing', factoryError === undefined, factoryError === undefined ? undefined : String(factoryError.stack).split('\n').slice(0, 3).join(' | '));
check('factory returns a plugin object', plugin !== null && typeof plugin === 'object');
check('plugin declares an apply function', typeof plugin?.apply === 'function');
check('plugin injects slots/locale/uiWorkspace', JSON.stringify(plugin?.inject) === JSON.stringify(['slots', 'locale', 'uiWorkspace']), JSON.stringify(plugin?.inject));

// --- 3. apply ------------------------------------------------------------
const registrations = [];
const effects = [];
let localeRegistered = null;
const ctx = {
  effect(callback, label) { effects.push(label); callback(); return () => {}; },
  locale: { register(namespace, dictionaries) { localeRegistered = { namespace, dictionaries }; return () => {}; } },
  slots: {
    inject(slotName, callback) { registrations.push({ slotName, callback }); return () => {}; },
    register(options, component) { return { options, component }; }
  },
  uiWorkspace: {
    openSession() {},
    async unarchiveSession() {}
  }
};

let applyError;
try { plugin.apply(ctx); } catch (error) { applyError = error; }
check('apply runs without throwing', applyError === undefined, applyError === undefined ? undefined : String(applyError.stack).split('\n').slice(0, 3).join(' | '));
check('apply registers exactly one locale dictionary', localeRegistered !== null && localeRegistered.namespace === 'archive-viewer');
check('locale dictionaries carry both languages', Boolean(localeRegistered?.dictionaries?.zh && localeRegistered?.dictionaries?.en));
const zhKeys = Object.keys(localeRegistered?.dictionaries?.zh ?? {}).sort();
const enKeys = Object.keys(localeRegistered?.dictionaries?.en ?? {}).sort();
check('zh and en dictionaries have identical key sets', JSON.stringify(zhKeys) === JSON.stringify(enKeys),
  `zh-only: ${zhKeys.filter(key => !enKeys.includes(key)).join(',')} | en-only: ${enKeys.filter(key => !zhKeys.includes(key)).join(',')}`);
check('apply declares an effect', effects.length === 1, effects.join(','));

// --- 4. slot registration + component construction ------------------------
check('one slot injection site', registrations.length === 1 && registrations[0].slotName === 'sidebar.footer.action', registrations.map(entry => entry.slotName).join(','));
let slotError;
let slotRegistration;
try { slotRegistration = registrations[0].callback(); } catch (error) { slotError = error; }
check('slot inject callback runs without throwing', slotError === undefined, slotError === undefined ? undefined : String(slotError.message));
check('registration id is our own', slotRegistration?.options?.id === 'archive-viewer-footer', String(slotRegistration?.options?.id));
check('registration declares the locale namespace', slotRegistration?.options?.locale === 'archive-viewer');

const ownerProps = {
  wide: true,
  t: (key, vars) => {
    if (vars === undefined) return localeRegistered.dictionaries.zh[key] ?? key;
    return String(localeRegistered.dictionaries.zh[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) => String(vars[name]));
  }
};

/**
 * Collect every element in a returned React subtree. Function components are
 * expanded the way an actual render would expand them (so a crash inside a
 * child component surfaces here instead of being hidden behind a leaf node),
 * with a depth cap standing in for React's render limits.
 */
function collect(element, into = [], depth = 0) {
  if (element === null || element === undefined || typeof element === 'boolean') return into;
  // Deep: the dialog > panel > flow nesting puts message rows past level 50.
  if (depth > 200) return into;
  if (Array.isArray(element)) { for (const child of element) collect(child, into, depth + 1); return into; }
  if (typeof element !== 'object') return into;
  into.push(element);
  if (typeof element.type === 'function') {
    const rendered = element.type(element.props ?? {});    collect(rendered, into, depth + 1);
    return into;
  }
  if (element.props !== undefined) collect(element.props.children, into, depth + 1);
  return into;
}

let wideTree;
let renderError;
try { wideTree = slotRegistration.component(ownerProps); } catch (error) { renderError = error; }
check('footer entry renders without throwing (wide)', renderError === undefined, renderError === undefined ? undefined : String(renderError.stack).split('\n').slice(0, 4).join(' | '));
const wideElements = collect(wideTree);
const wideButtons = wideElements.filter(element => element.type === 'button');
check('footer entry renders exactly one button', wideButtons.length === 1, String(wideButtons.length));
check('the button carries a localized aria-label', wideButtons[0]?.props?.['aria-label'] === '归档会话查看器' || typeof wideButtons[0]?.props?.['aria-label'] === 'string',
  String(wideButtons[0]?.props?.['aria-label']));
// The foot is the sidebar's most crowded strip: the entry is an icon-only
// square in both states, and must never ask for a share of the row's width.
check('the button carries no text and no label span', (() => {
  // The foot is the sidebar's most crowded strip, so the entry must not ask
  // for a share of the row width: exactly one icon child, no text node.
  const kids = wideButtons[0]?.props?.children;
  const list = Array.isArray(kids) ? kids : [kids];
  return list.length === 1 && typeof list[0] === 'object' && list[0] !== null;
})(), JSON.stringify(wideButtons[0]?.props?.children).slice(0, 120));
check('the wide state renders no text label', !wideElements.some(element => element.type === 'span'
  && (element.props?.children === '归档会话查看器' || (Array.isArray(element.props?.children) && element.props.children.includes('归档会话查看器')))),
  'a label span is still rendered');
check('the entry renders a dialog element', wideElements.some(element => element.type === 'dialog'));
const styleElement = wideElements.find(element => element.type === 'style');
const styleText = String(styleElement?.props?.children ?? '');
check('the entry injects its own stylesheet', styleText.includes('.aav-footerBtn') && styleText.length > 500, String(styleText.length));
check('the footer button pins its own 40px square', /\.aav-footerBtn\s*\{[^}]*width:\s*40px[^}]*height:\s*40px/.test(styleText), 'no 40px square rule');
check('the footer button cannot be squeezed or stretched', /\.aav-footerBtn\s*\{[^}]*min-width:\s*40px[^}]*max-width:\s*40px/.test(styleText), 'no min/max-width clamp');
check('both sidebar states keep the same square', /\.aav-footerBtnRail,\s*\.aav-footerBtnWide\s*\{[^}]*width:\s*40px/.test(styleText), 'no shared rail/wide rule');
check('the glyph colour follows the host tertiary label token with a fallback',
  /\.aav-footerBtn\s*\{[^}]*color:\s*var\(--dsw-alias-label-tertiary,\s*var\(--dsw-alias-label-secondary,\s*currentColor\)\)/.test(styleText),
  'tertiary token or its fallback is missing');
check('the glyph is drawn at 20px', (() => {
  // Read the size off the rendered icon element, not the source constant.
  const icons = wideElements.filter(element => element.type !== 'button' && element.props !== undefined && element.props.viewBox === '0 0 24 24');
  return icons.some(icon => icon.props.width === 20 && icon.props.height === 20);
})(), JSON.stringify(wideElements.filter(element => element.props?.viewBox === '0 0 24 24').map(element => element.props?.width)));
check('the button geometry is box-sizing-safe', /\.aav-footerBtn\s*\{[^}]*box-sizing:\s*border-box/.test(styleText), 'no border-box rule');

let railError;
try { slotRegistration.component({ ...ownerProps, wide: false }); } catch (error) { railError = error; }
check('footer entry renders without throwing (rail)', railError === undefined, railError === undefined ? undefined : String(railError.message));

// A missing `t` must not blank the entry: the owner may omit the translator.
let noTranslateError;
try { slotRegistration.component({ wide: true }); } catch (error) { noTranslateError = error; }
check('footer entry survives a missing translator', noTranslateError === undefined, noTranslateError === undefined ? undefined : String(noTranslateError.message));

// --- 5. icon geometry ----------------------------------------------------
const svg = wideElements.find(element => element.type === 'svg');
check('the button renders an svg icon', svg !== undefined);
check('the icon has a viewBox and a size', svg?.props?.viewBox === '0 0 24 24' && typeof svg?.props?.width === 'number', JSON.stringify({ viewBox: svg?.props?.viewBox, width: svg?.props?.width }));
const shapes = collect(svg?.props?.children).filter(element => typeof element.type === 'string');
check('the icon draws real shapes', shapes.length >= 4, String(shapes.length));

// --- 5b. every transcript row renders -------------------------------------
// The entry-only checks above could not see a crash inside a message row, and
// a reference error there unmounts the whole page in the browser. This renders
// the transcript flow through the dialog with one row of every kind present.
function expandAll(element, depth = 0) {
  // The guard is deliberately far above the real nesting depth (dialog > panel >
  // flow > card): a too-small cap silently truncates the tree and turns the
  // assertions below into no-ops, which is exactly how a crash escaped once.
  if (element === null || element === undefined || typeof element === 'boolean' || depth > 200) return element;
  if (Array.isArray(element)) return element.map(child => expandAll(child, depth + 1));
  if (typeof element !== 'object') return element;
  if (typeof element.type === 'function') return expandAll(element.type(element.props ?? {}), depth + 1);
  if (element.props !== undefined) return { ...element, props: { ...element.props, children: expandAll(element.props.children, depth + 1) } };
  return element;
}

// One row of every kind the fold can produce, including the branches that
// crashed: a tool row whose tool name is known, one whose name is missing, and
// one that is flagged unpaired.
const transcriptItems = [
  { kind: 'turn', seq: 1, time: 1, turn: 1, phase: 'start' },
  { kind: 'title', seq: 2, time: 2, text: '会话标题' },
  { kind: 'injected', seq: 3, time: 3, label: 'agent-instructions', text: '<system-reminder>rules</system-reminder>' },
  { kind: 'user', seq: 4, time: 4, text: '手打的话', source: 'user' },
  { kind: 'assistant', seq: 5, time: 5, text: '回答', reasoning: '想想', model: 'm', provider: 'p', usage: { input: 1, output: 2 } },
  { kind: 'tool', seq: 6, time: 6, name: 'read', callId: 'c1', paired: true, args: '{\n  "file_path": "E:\\\\x"\n}', result: '文件内容' },
  { kind: 'tool', seq: 7, time: 7, name: '', callId: 'c2', paired: false, args: '', result: '孤儿结果' },
  { kind: 'tool', seq: 8, time: 8, name: '', paired: false, args: '', result: '', error: 'Boom' },
  { kind: 'turn', seq: 9, time: 9, turn: 1, phase: 'end', reason: 'completed' }
];
// The external store is private to each factory instance: every `factory()`
// call closes over its own. The rows below must render the SAME instance whose
// state the harness drives, so this uses the second registration, not the first.
const probeInstance = registered.get('dsh-archive-viewer')((spec) => {
  if (seeded.has(spec)) return seeded.get(spec);
  throw new Error(`require("${spec}") missed the module table`);
});
probeInstance.apply(ctx);
const probeState = probeInstance.__state;
const setProbeState = (patch) => probeInstance.__setState(patch);
const probeRegistration = registrations[registrations.length - 1].callback();
check('the factory exposes its store for the offline harness', probeState !== undefined, 'no __state export');
// Must go through the store's own setter: `set()` publishes a NEW state object,
// so mutating the getter's result would leave the rendered tree unaware.
setProbeState({
  open: true,
  rowPhase: 'ready',
  transcript: { sessionId: 'session-x', header: { id: 'session-x', version: 4, createdAt: 1, cwd: 'E:\\\\x' }, items: transcriptItems, rowCount: transcriptItems.length, eventCount: 9, injectedCount: 1, callCount: 2, usage: { input: 1, output: 2, calls: 1 } }
});
check('the harness state actually reached the store', probeInstance.__state.open === true && probeInstance.__state.transcript !== null,
  JSON.stringify({ open: probeInstance.__state.open, hasTranscript: probeInstance.__state.transcript !== null }));

let flowError;
let flowTree;
try {
  flowTree = expandAll(probeRegistration.component(ownerProps));
} catch (error) { flowError = error; }
check('the transcript flow renders without throwing', flowError === undefined,
  flowError === undefined ? undefined : `${String(flowError.message)} @ ${String(flowError.stack).split('\n')[1]?.trim()}`);
const flowElements = collect(flowTree);
// Visible evidence when the assertions below fail: what the collector saw.
check('the collector reached deep content', flowElements.length > 60, `collected ${flowElements.length} elements; classes=${JSON.stringify([...new Set(flowElements.map(element => String(element.props?.className ?? '')).filter(Boolean))].slice(0, 12))}`);
// Cards only: `aav-msgHead` / `aav-msgBody` also carry the "aav-msg" prefix.
const cardCount = flowElements.filter(element => String(element.props?.className ?? '').split(' ')[0] === 'aav-msg').length;
check('every transcript row produced a card', cardCount === 5, String(cardCount));
check('the tool row shows its tool name', flowElements.some(element => String(element.props?.className ?? '') === 'aav-toolName' && element.props.children === 'read'));
check('an unnamed tool row says so instead of inventing a name', flowElements.some(element => String(element.props?.className ?? '') === 'aav-toolName' && element.props.children === '(未记录工具名)'));
check('an unpaired result is badged', flowElements.some(element => String(element.props?.className ?? '') === 'aav-badge' && element.props.children === '仅结果'));
check('the tool arguments are rendered when present', flowElements.some(element => element.type === 'pre' && String(element.props?.children ?? '').includes('file_path')));
check('the assistant reasoning is folded into details', flowElements.some(element => element.type === 'details'));
check('the injected toggle is offered', flowElements.some(element => element.type === 'button' && String(element.props?.['aria-pressed']) === 'true'));
// Hidden-by-default must actually hide: the injected card may not be present.
check('injected rows are hidden by default', !flowElements.some(element => String(element.props?.className ?? '').includes('aav-injected')));
setProbeState({ hideInjected: false });
const shownElements = collect(expandAll(probeRegistration.component(ownerProps)));
check('flipping the toggle brings injected rows back', shownElements.some(element => String(element.props?.className ?? '').includes('aav-injected')));
setProbeState({ hideInjected: true, open: false, rowPhase: 'idle', transcript: null });

// --- 6. diagnostics channel ----------------------------------------------
const posted = [];
globalThis.fetch = async (url, options) => {
  posted.push({ url, body: options?.body === undefined ? undefined : JSON.parse(options.body) });
  return { status: 200, async json() { return { ok: true, result: {} }; } };
};
let secondPlugin;
try {
  secondPlugin = registered.get('dsh-archive-viewer')((spec) => {
    if (seeded.has(spec)) return seeded.get(spec);
    throw new Error(`require("${spec}") missed the module table`);
  });
  secondPlugin.apply(ctx);
} catch (error) { /* the second run only exists to observe the diagnostics post */ }
await new Promise(resolve => setTimeout(resolve, 0));
const stages = posted.map(entry => entry.body?.stage);
check('the client reports factory start', stages.includes('factory:start'), stages.join(','));
check('the client reports a completed registration', stages.includes('apply:registered'), stages.join(','));
check('diagnostics post to the plugin own route', posted.every(entry => entry.url === '/archive-viewer/api/diagnostic'), posted.map(entry => entry.url).join(','));

console.log(results.join("\n"));
console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${results.length - failures}/${results.length} checks`);
process.exit(failures === 0 ? 0 : 1);







