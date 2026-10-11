/**
 * Paste-once footer layout probe for the DSH sidebar (structure-agnostic).
 *
 * The first version keyed off the shipped sidebar's class hashes and found
 * nothing, because this machine runs a third-party sidebar. This version finds
 * the buttons by their accessible names instead, walks up the ancestor chain,
 * and reports the geometry of every step — that shows which ancestor forces
 * the overflow regardless of class names.
 *
 * Paste the whole file into the browser DevTools console on the DSH page.
 * Read-only: it inspects and reports, and changes nothing.
 */
(async () => {
  const round = (value) => Math.round(value * 10) / 10;
  const describe = (element, depth) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      depth,
      tag: element.tagName.toLowerCase(),
      cls: String(element.className ?? '').slice(0, 70),
      rect: [round(rect.width), round(rect.height), round(rect.top), round(rect.left), round(rect.right)],
      display: style.display,
      position: style.position,
      flex: style.flex,
      width: style.width,
      minWidth: style.minWidth,
      maxWidth: style.maxWidth,
      overflow: style.overflow,
      overflowX: style.overflowX,
      whiteSpace: style.whiteSpace,
      gap: style.gap,
      children: element.children.length
    };
  };

  const report = { at: new Date().toISOString(), viewport: [window.innerWidth, window.innerHeight] };

  // 1. Every button in the document whose accessible name matches the footer
  //    entries, wherever the sidebar puts them.
  const wanted = /归档|Archive|会话管理|Session manager|记忆|Memory/i;
  const buttons = [...document.querySelectorAll('button, [role=button], a')]
    .filter(element => wanted.test(`${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${element.textContent ?? ''}`));
  report.matchedButtons = buttons.length;

  report.buttons = [];
  for (const button of buttons.slice(0, 12)) {
    const rect = button.getBoundingClientRect();
    const chain = [];
    let current = button.parentElement;
    let depth = 1;
    while (current !== null && depth <= 8) {
      chain.push(describe(current, depth));
      current = current.parentElement;
      depth += 1;
    }
    report.buttons.push({
      ...describe(button, 0),
      aria: button.getAttribute('aria-label') || '',
      title: button.getAttribute('title') || '',
      text: String(button.textContent ?? '').trim().slice(0, 20),
      childTags: [...button.children].map(child => `${child.tagName.toLowerCase()}.${String(child.className).slice(0, 24)}`),
      chain
    });
  }

  // 2. The sidebar column itself: the widest ancestor that is still narrower
  //    than half the viewport and whose height spans most of the window.
  let column = null;
  if (buttons.length > 0) {
    let current = buttons[0].parentElement;
    while (current !== null) {
      const rect = current.getBoundingClientRect();
      if (rect.width > 40 && rect.width < window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.6) { column = current; break; }
      current = current.parentElement;
    }
  }
  report.column = column === null ? null : describe(column, 0);
  const columnRight = column === null ? null : column.getBoundingClientRect().right;

  // 3. Anything inside the column that sticks out past its right edge — the
  //    overflow that pushes entries out of sight.
  report.overflowing = [];
  if (column !== null) {
    for (const element of column.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && columnRight !== null && rect.right > columnRight + 1) {
        report.overflowing.push({ ...describe(element, 0), overhang: round(rect.right - columnRight), text: String(element.textContent ?? '').trim().slice(0, 20) });
        if (report.overflowing.length >= 25) break;
      }
    }
  }

  // 4. Sanity: is our own entry anywhere in the document?
  report.ourEntryPresent = [...document.querySelectorAll('[aria-label="归档会话查看器"], .aav-footerBtn, [class*=aav-]')].length;
  report.ourStyleInDocument = [...document.querySelectorAll('style')].some(tag => String(tag.textContent).includes('.aav-footerBtn'));

  console.log('[archive-viewer footer probe v2]', report);
  try {
    await fetch('/archive-viewer/api/diagnostic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report)
    });
    console.log('[archive-viewer footer probe v2] report sent to the Host');
  } catch (error) {
    console.log('[archive-viewer footer probe v2] could not send the report:', String(error && error.message));
  }
  return report;
})();
