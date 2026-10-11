/**
 * Paste-once footer layout probe for the DSH sidebar.
 *
 * The sidebar footer row is misbehaving for every entry (the session-manager
 * button overflows the column and squashes the memory button, and this
 * plugin's entry disappears entirely). This reads the real DOM geometry of the
 * whole column — the sidebar box, the foot area, the action row, and every
 * child in it — and posts the result to the viewer's own Host route so it can
 * be read from outside the browser.
 *
 * Paste the whole file into the browser DevTools console on the DSH page.
 * Read-only: it inspects and reports, and changes nothing.
 */
(async () => {
  const round = (value) => Math.round(value * 10) / 10;
  const describe = (element) => {
    if (element === null || element === undefined) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName.toLowerCase(),
      cls: String(element.className ?? '').slice(0, 80),
      rect: [round(rect.width), round(rect.height), round(rect.top), round(rect.left)],
      display: style.display,
      position: style.position,
      flex: style.flex,
      width: style.width,
      minWidth: style.minWidth,
      maxWidth: style.maxWidth,
      overflow: style.overflow,
      overflowX: style.overflowX,
      whiteSpace: style.whiteSpace,
      fontSize: style.fontSize,
      childCount: element.children.length,
      text: String(element.textContent ?? '').trim().slice(0, 24)
    };
  };

  const report = { at: new Date().toISOString(), viewport: [window.innerWidth, window.innerHeight] };

  // Find the sidebar column by the shell's own class prefix rather than by a
  // guessed selector: the column root carries `_root` and its own class hash.
  const column = [...document.querySelectorAll('div')].find(element => /_root/.test(String(element.className)) && /sidebar/i.test(String(element.className))) ?? null;
  report.column = describe(column);

  const footArea = column === null ? null : [...column.querySelectorAll('div')].find(element => /footArea/.test(String(element.className))) ?? null;
  report.footArea = describe(footArea);

  const row = column === null ? null : [...column.querySelectorAll('div')].find(element => /footerActions/.test(String(element.className))) ?? null;
  report.row = describe(row);

  const settingsArea = column === null ? null : [...column.querySelectorAll('div')].find(element => /settingsArea/.test(String(element.className))) ?? null;
  report.settingsArea = describe(settingsArea);

  // Every button in the foot, with the full parent chain so an overflow source
  // shows up even when the leaf itself looks reasonable.
  report.footButtons = [];
  const scope = footArea ?? column;
  if (scope !== null) {
    for (const button of scope.querySelectorAll('button')) {
      const chain = [];
      let current = button.parentElement;
      let depth = 0;
      while (current !== null && depth < 6) {
        chain.push({ cls: String(current.className ?? '').slice(0, 60), width: round(current.getBoundingClientRect().width) });
        current = current.parentElement;
        depth += 1;
      }
      report.footButtons.push({
        ...describe(button),
        aria: button.getAttribute('aria-label') || '',
        // A button whose right edge sits past the column's right edge is the
        // overflow the user is seeing.
        overflowsColumn: column === null ? null : round(button.getBoundingClientRect().right - column.getBoundingClientRect().right),
        chain
      });
    }
  }

  // Anything else in the column that is wider than the column itself.
  report.widerThanColumn = [];
  if (column !== null) {
    const columnRight = column.getBoundingClientRect().right;
    for (const element of column.querySelectorAll('button, div, span')) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.right > columnRight + 1) {
        report.widerThanColumn.push({ ...describe(element), overhang: round(rect.right - columnRight) });
        if (report.widerThanColumn.length >= 20) break;
      }
    }
  }

  console.log('[archive-viewer footer probe]', report);
  try {
    await fetch('/archive-viewer/api/diagnostic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report)
    });
    console.log('[archive-viewer footer probe] report sent to the Host');
  } catch (error) {
    console.log('[archive-viewer footer probe] could not send the report:', String(error && error.message));
  }
  return report;
})();
