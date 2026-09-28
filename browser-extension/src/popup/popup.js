/**
 * The popup: the same three things the app's Shield tab shows - is it on, what is it doing to this
 * page, and what has it stopped so far.
 */
(function () {
  'use strict';

  let ui = window.QuietUi;
  let Domains = window.QuietDomains;
  let APP_NAME = ui.appName();

  let elements = {
    appName: document.getElementById('app-name'),
    pill: document.getElementById('status-pill'),
    statusText: document.getElementById('status-text'),
    banner: document.getElementById('banner'),
    summary: document.getElementById('shield-summary'),
    toggle: document.getElementById('toggle'),
    siteHost: document.getElementById('site-host'),
    siteNote: document.getElementById('site-note'),
    siteCount: document.getElementById('site-count'),
    allowSite: document.getElementById('allow-site'),
    today: document.getElementById('today'),
    total: document.getElementById('total'),
    openOptions: document.getElementById('open-options'),
    footnote: document.getElementById('footnote'),
  };

  let tab = { id: null, host: '' };
  let status = null;

  function showBanner(text, tone) {
    elements.banner.hidden = !text;
    elements.banner.className = 'banner ' + (tone || 'warn');
    elements.banner.textContent = text || '';
  }

  function allowedHosts(host) {
    if (!status || !host) return [];
    let names = Domains.suffixes(host);
    return status.allowlist.filter(function (entry) {
      return names.indexOf(entry) >= 0;
    });
  }

  function render() {
    if (!status) return;
    let on = status.enabled;

    elements.pill.className = 'pill ' + (on ? 'on' : 'off');
    elements.statusText.textContent = on ? 'Filtering' : 'Off';

    if (!status.hasPin) {
      elements.summary.textContent =
        APP_NAME +
        ' will not filter anything until it has a PIN. A blocker that can be switched off in a moment is not much of a blocker.';
      elements.toggle.textContent = 'Set a PIN to begin';
      showBanner('Set a PIN first: protection refuses to run without one.', 'warn');
    } else if (on) {
      elements.summary.textContent =
        'Every request this browser makes is checked against your lists before it leaves.';
      elements.toggle.textContent = 'Switch protection off';
      elements.toggle.className = 'wide';
      if (status.commitmentRemaining > 0) {
        showBanner(
          'Commitment lock is on for another ' + ui.formatRemaining(status.commitmentRemaining) + '.',
          'info',
        );
      } else {
        showBanner('', 'info');
      }
    } else {
      elements.summary.textContent =
        'Switched off. Nothing is being filtered, and nothing is stopping you from switching it off again.';
      elements.toggle.textContent = 'Switch protection on';
      elements.toggle.className = 'primary wide';
      showBanner('', 'info');
    }

    if (status.hasPin) {
      elements.toggle.className = on ? 'wide' : 'primary wide';
    }

    let sites = allowedHosts(tab.host);
    if (!tab.host) {
      elements.siteHost.textContent = 'No site here';
      elements.siteNote.textContent = 'Open a website to see what ' + APP_NAME + ' does to it.';
      elements.allowSite.disabled = true;
      elements.allowSite.textContent = 'Allow this site';
    } else if (sites.length > 0) {
      elements.siteHost.textContent = tab.host;
      elements.siteNote.textContent = 'Allowed by your allowlist (' + sites.join(', ') + ').';
      elements.allowSite.disabled = false;
      elements.allowSite.textContent = 'Stop allowing this site';
    } else {
      elements.siteHost.textContent = tab.host;
      elements.siteNote.textContent = 'Checked against your lists like every other name.';
      elements.allowSite.disabled = false;
      elements.allowSite.textContent = 'Allow this site';
    }

    elements.today.textContent = String(status.stats.today);
    elements.total.textContent = String(status.stats.total);

    let footnote = 'No account, no server, no telemetry. Domains ' + (status.generatedAt ? 'built ' + status.generatedAt.slice(0, 10) : 'built into this package') + '.';
    if (!status.capabilities.blockedCountsReliable) {
      footnote += ' This browser does not reliably report blocked loads, so the counts here are a best effort.';
    }
    elements.footnote.textContent = footnote;
  }

  async function refresh() {
    status = await ui.request({ type: 'quiet:status' });
    if (tab.id !== null) {
      try {
        let counted = await ui.request({ type: 'quiet:tab.count', tabId: tab.id });
        elements.siteCount.textContent = String(counted.count || 0);
      } catch (_error) {
        elements.siteCount.textContent = '0';
      }
    }
    render();
  }

  async function withPin(action) {
    let pin;
    try {
      pin = await ui.askPin(action.prompt);
    } catch (_error) {
      return null;
    }
    try {
      let next = await ui.request(action.request(pin));
      status = next;
      render();
      return next;
    } catch (error) {
      showBanner(error.message, 'danger');
      return null;
    }
  }

  elements.toggle.addEventListener('click', async function () {
    if (!status) return;
    if (!status.hasPin) {
      ui.api.runtime.openOptionsPage();
      window.close();
      return;
    }
    if (status.enabled) {
      await withPin({
        prompt: {
          title: 'Switch protection off?',
          body: 'Nothing will be filtered until you switch it back on.',
          confirmLabel: 'Switch off',
        },
        request: function (pin) {
          return { type: 'quiet:shield.off', pin: pin };
        },
      });
    } else {
      await withPin({
        prompt: { title: 'Switch protection on', body: 'Enter your PIN to arm the filter.', confirmLabel: 'Switch on' },
        request: function (pin) {
          return { type: 'quiet:shield.on', pin: pin };
        },
      });
    }
  });

  elements.allowSite.addEventListener('click', async function () {
    if (!tab.host || !status) return;
    let sites = allowedHosts(tab.host);
    if (sites.length > 0) {
      await withPin({
        prompt: {
          title: 'Block ' + sites.join(', ') + ' again?',
          body: 'Removing an allowlist entry puts the domain back under the lists.',
          confirmLabel: 'Remove',
        },
        request: function (pin) {
          return { type: 'quiet:allowlist.remove', domain: sites[0], pin: pin };
        },
      });
    } else {
      await withPin({
        prompt: {
          title: 'Allow ' + tab.host + '?',
          body: 'This site and its sub-domains will be exempt from every list until you remove it.',
          confirmLabel: 'Allow',
        },
        request: function (pin) {
          return { type: 'quiet:allowlist.add', domain: tab.host, pin: pin };
        },
      });
    }
  });

  elements.openOptions.addEventListener('click', function () {
    ui.api.runtime.openOptionsPage();
    window.close();
  });

  ui.api.runtime.onMessage.addListener(function (message) {
    if (message && message.type === 'quiet:changed') {
      refresh().catch(function () {});
    }
    return false;
  });

  (async function start() {
    // The name comes from the manifest, which the build fills in from `expo.name`.
    elements.appName.textContent = APP_NAME;
    document.title = APP_NAME;
    try {
      let tabs = await ui.api.tabs.query({ active: true, currentWindow: true });
      let active = tabs && tabs[0];
      if (active && typeof active.id === 'number') {
        tab.id = active.id;
        tab.host = ui.domainOf(active.url);
      }
      await refresh();
    } catch (error) {
      showBanner(error.message || APP_NAME + ' could not read its own state.', 'danger');
    }
  })();
})();
