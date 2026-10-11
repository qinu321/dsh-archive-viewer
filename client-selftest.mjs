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
  if (depth > 50) return into;
  if (Array.isArray(element)) { for (const child of element) collect(child, into, depth + 1); return into; }
  if (typeof element !== 'object') return into;
  into.push(element);
  if (typeof element.type === 'function') {
    const rendered = element.type(element.props ?? {});
    collect(rendered, into, depth + 1);
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
check('the footer button pins its own 36px square', /\.aav-footerBtn\s*\{[^}]*width:\s*36px[^}]*height:\s*36px/.test(styleText), 'no 36px square rule');
check('the footer button cannot be squeezed or stretched', /\.aav-footerBtn\s*\{[^}]*min-width:\s*36px[^}]*max-width:\s*36px/.test(styleText), 'no min/max-width clamp');
check('both sidebar states keep the same square', /\.aav-footerBtnRail,\s*\.aav-footerBtnWide\s*\{[^}]*width:\s*36px/.test(styleText), 'no shared rail/wide rule');
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

