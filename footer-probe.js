/**
 * Paste-once layout probe v3 — measures THIS plugin's own footer button and
 * its ancestor chain.
 *
 * v2 matched every session row's built-in "归档会话" icon (138 hits) and
 * measured the wrong subtree. v3 keys off the plugin's own class instead:
 * `.aav-footerBtn` is unique to this plugin, so there is exactly one candidate
 * (plus the dialog's nodes). It reports the button's box and every ancestor's
 * box, which is what reveals the container that pushes it out of view.
 *
 * Paste the whole file into the browser DevTools console on the DSH page.
 * Read-only: it inspects and reports, and changes nothing.
 */
(async () => {
  const round = (value) => Math.round(value * 10) / 10;
  const box = (element, depth) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      depth,
      tag: element.tagName.toLowerCase(),
      cls: String(element.className ?? '').slice(0, 80),
      // [width, height, top, left, right, bottom] in viewport coordinates.
      rect: [round(rect.width), round(rect.height), round(rect.top), round(rect.left), round(rect.right), round(rect.bottom)],
      display: style.display,
      position: style.position,
      flex: style.flex,
      alignItems: style.alignItems,
      justifyContent: style.justifyContent,
      width: style.width,
      minWidth: style.minWidth,
      maxWidth: style.maxWidth,
      boxSizing: style.boxSizing,
      overflow: style.overflow,
      overflowX: style.overflowX,
      visibility: style.visibility,
      opacity: style.opacity,
      children: element.children.length
    };
  };

  const report = { at: new Date().toISOString(), viewport: [window.innerWidth, window.innerHeight] };

  const button = document.querySelector('.aav-footerBtn');
  report.buttonFound = button !== null;
  if (button === null) {
    report.aavNodes = [...document.querySelectorAll('[class*=aav-]')].map(element => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
    console.log('[archive-viewer probe v3] our button is NOT in the document', report);
    await fetch('/archive-viewer/api/diagnostic', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) }).catch(() => {});
    return report;
  }

  report.button = {
    ...box(button, 0),
    aria: button.getAttribute('aria-label') || '',
    text: String(button.textContent ?? '').trim().slice(0, 20),
    offsetParent: button.offsetParent === null ? null : String(button.offsetParent.className ?? '').slice(0, 60),
    scrollWidth: button.scrollWidth,
    clientWidth: button.clientWidth,
    // Whether the element sits inside the visible viewport at all.
    inViewport: (() => { const r = button.getBoundingClientRect(); return r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight; })()
  };

  const chain = [];
  let current = button.parentElement;
  let depth = 1;
  while (current !== null && depth <= 10) {
    chain.push(box(current, depth));
    current = current.parentElement;
    depth += 1;
  }
  report.ancestors = chain;

  // Our dialog/panel nodes, if the popup ever mounted.
  report.aavNodes = [...document.querySelectorAll('[class*=aav-]')].map(element => ({
    cls: String(element.className).slice(0, 50),
    rect: (() => { const r = element.getBoundingClientRect(); return [round(r.width), round(r.height), round(r.top), round(r.left)]; })()
  }));

  console.log('[archive-viewer probe v3]', report);
  try {
    await fetch('/archive-viewer/api/diagnostic', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    console.log('[archive-viewer probe v3] report sent to the Host');
  } catch (error) {
    console.log('[archive-viewer probe v3] could not send the report:', String(error && error.message));
  }
  return report;
})();
