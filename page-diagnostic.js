/**
 * Paste-once page diagnostic for dsh-archive-viewer.
 *
 * The viewer's icon did not appear in the sidebar footer even though the Host
 * route works and the slot occupant is registered and active. The facts that
 * can only be read from inside the page are: whether the Client factory ever
 * ran, whether its slot entry is in the registry, whether the entry crashed,
 * and what the footer DOM actually contains.
 *
 * Run by pasting the whole file into the browser DevTools console on the DSH
 * page. It only reads page state, reports the result back to the viewer's own
 * Host route, and also logs it locally. Nothing is written to the session.
 */
(async () => {
  const report = { at: new Date().toISOString(), probes: {} };

  // 1. Is the Client factory registered with the module loader?
  try {
    const loader = window.__ModuleLoader__;
    report.probes.loaderPresent = Boolean(loader);
    if (loader) {
      report.probes.loaderKeys = Object.keys(loader);
      const factories = loader.factories ?? loader._factories;
      if (factories) {
        const keys = typeof factories.keys === 'function' ? [...factories.keys()] : Object.keys(factories);
        report.probes.factoryCount = keys.length;
        report.probes.hasOurFactory = keys.includes('dsh-archive-viewer');
        report.probes.sampleFactories = keys.filter(k => /session-manager|archive|skill-hub|meme/.test(k));
      }
    }
  } catch (error) { report.probes.loaderError = String(error && error.message); }

  // 2. Which DSH globals are reachable from the page?
  try {
    report.probes.globals = Object.keys(window).filter(k => /dsh|DSH|slot|Slot|cordis|Cordis/i.test(k)).slice(0, 40);
  } catch (error) { report.probes.globalsError = String(error && error.message); }

  // 3. Crash reports from slot entries, if the page exposes them.
  try {
    const slots = window.__dshSlots ?? window.__DSH_SLOTS__ ?? undefined;
    report.probes.slotsGlobalPresent = slots !== undefined;
    if (slots && typeof slots.reportEntryError === 'function') report.probes.slotsHasReportHook = true;
  } catch (error) { report.probes.slotsError = String(error && error.message); }

  // 4. What does the sidebar footer actually contain in the DOM?
  try {
    const sidebar = document.querySelector('[data-dsh-sidebar], [data-testid=sidebar], .dsw-sidebar');
    report.probes.sidebarFound = Boolean(sidebar);
    if (sidebar) {
      const footerButtons = [...sidebar.querySelectorAll('button')].map(button => ({
        tag: 'button',
        aria: button.getAttribute('aria-label') || '',
        title: button.getAttribute('title') || '',
        cls: button.className || '',
        text: (button.textContent || '').trim().slice(0, 24),
        rect: (() => { const r = button.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()
      })).filter(entry => /会话管理|Session manager|归档|Archive|记忆|Memory|设置|Settings/.test(entry.aria + entry.title + entry.text));
      report.probes.footerButtons = footerButtons;
      report.probes.aavNodes = sidebar.querySelectorAll('[class*=aav-]').length;
      report.probes.footerContainers = [...sidebar.querySelectorAll('[class*=footer], [class*=footArea], [class*=settingsArea]')]
        .map(node => ({ cls: node.className, children: node.children.length }));
    }
  } catch (error) { report.probes.domError = String(error && error.message); }

  // 5. Can the page reach the viewer's Host routes at all?
  try {
    const response = await fetch('/archive-viewer/api/sessions', { cache: 'no-store' });
    const payload = await response.json();
    report.probes.routeStatus = response.status;
    report.probes.routeCount = payload && payload.result ? payload.result.archivedCount : undefined;
  } catch (error) { report.probes.routeError = String(error && error.message); }

  // 6. Errors already recorded by the shell, if there is a console buffer.
  try {
    report.probes.bootFailed = document.querySelectorAll('[class*=failed]').length;
    report.probes.bootText = (document.body.innerText || '').slice(0, 300);
  } catch (error) { report.probes.bootError = String(error && error.message); }

  console.log('[archive-viewer diagnostic]', report);
  try {
    await fetch('/archive-viewer/api/diagnostic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report)
    });
    console.log('[archive-viewer diagnostic] report sent to the Host');
  } catch (error) {
    console.log('[archive-viewer diagnostic] could not send the report:', String(error && error.message));
  }
  return report;
})();
