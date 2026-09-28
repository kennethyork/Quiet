/**
 * The settings page: lists, allowlist, statistics, PIN and the commitment lock.
 *
 * Every button here sends the PIN with its request and lets the service worker decide. This page
 * never writes storage itself, so there is exactly one place where protection can be weakened.
 */
(function () {
  'use strict';

  let ui = window.QuietUi;
  let Domains = window.QuietDomains;
  let APP_NAME = ui.appName();

  let el = {
    pill: document.getElementById('status-pill'),
    statusText: document.getElementById('status-text'),
    banner: document.getElementById('banner'),

    setupSection: document.getElementById('setup-section'),
    pinNew: document.getElementById('pin-new'),
    pinConfirm: document.getElementById('pin-confirm'),
    pinCreate: document.getElementById('pin-create'),
    pinCreateError: document.getElementById('pin-create-error'),

    protectionSection: document.getElementById('protection-section'),
    protectionNote: document.getElementById('protection-note'),
    shieldToggle: document.getElementById('shield-toggle'),
    commitmentNote: document.getElementById('commitment-note'),
    commitmentHours: document.getElementById('commitment-hours'),
    commitmentStart: document.getElementById('commitment-start'),
    commitmentRelease: document.getElementById('commitment-release'),

    listsSection: document.getElementById('lists-section'),
    lists: document.getElementById('lists'),

    allowlistSection: document.getElementById('allowlist-section'),
    allowInput: document.getElementById('allow-input'),
    allowAdd: document.getElementById('allow-add'),
    allowItems: document.getElementById('allow-items'),

    statsSection: document.getElementById('stats-section'),
    statToday: document.getElementById('stat-today'),
    statTotal: document.getElementById('stat-total'),
    history: document.getElementById('history'),
    statsNote: document.getElementById('stats-note'),
    statsClear: document.getElementById('stats-clear'),

    pinSection: document.getElementById('pin-section'),
    pinCurrent: document.getElementById('pin-current'),
    pinNext: document.getElementById('pin-next'),
    pinChange: document.getElementById('pin-change'),
    pinRemove: document.getElementById('pin-remove'),
    pinError: document.getElementById('pin-error'),

    aboutLines: document.getElementById('about-lines'),
  };

  let status = null;

  function showBanner(text, tone) {
    el.banner.hidden = !text;
    el.banner.className = 'banner ' + (tone || 'warn');
    el.banner.textContent = text || '';
  }

  function showError(target, text) {
    target.textContent = text || '';
  }

  function describeCommitment(remaining) {
    return remaining > 0
      ? 'Locked for another ' + ui.formatRemaining(remaining) + ', until ' + ui.formatWhen(status.commitmentUntil) + '.'
      : 'Protection can be switched off freely.';
  }

  /** Runs a PIN-gated action, then redraws from the state the worker returns. */
  async function withPin(prompt, buildRequest, errorTarget) {
    let pin;
    try {
      pin = await ui.askPin(prompt);
    } catch (_error) {
      return false;
    }
    try {
      status = await ui.request(buildRequest(pin));
      render();
      return true;
    } catch (error) {
      if (errorTarget) showError(errorTarget, error.message);
      else showBanner(error.message, 'danger');
      return false;
    }
  }

  function renderLists() {
    el.lists.textContent = '';
    status.lists.forEach(function (list) {
      let item = document.createElement('div');
      item.className = 'list-item row row-start';

      let info = document.createElement('div');
      info.className = 'grow stack';
      info.style.gap = '4px';

      let title = document.createElement('h2');
      title.textContent = list.title;
      info.appendChild(title);

      let body = document.createElement('p');
      body.className = 'muted tiny';
      body.style.margin = '0';
      body.textContent = list.description;
      info.appendChild(body);

      let meta = document.createElement('p');
      meta.className = 'faint tiny';
      meta.style.margin = '0';
      let facts = [];
      if (list.included) facts.push(list.domains.toLocaleString() + ' domains');
      else facts.push('not included in this build');
      if (list.locked) facts.push('always on');
      if (list.heavy) facts.push('large list');
      if (list.source) facts.push(list.source);
      meta.textContent = facts.join(' · ');
      info.appendChild(meta);

      item.appendChild(info);

      let toggle = document.createElement('label');
      toggle.className = 'switch';
      let box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = list.on;
      box.disabled = list.locked || !list.included;
      box.addEventListener('change', function () {
        let wanted = box.checked;
        box.checked = list.on; // the worker has the last word
        withPin(
          {
            title: wanted ? 'Turn on ' + list.title + '?' : 'Turn off ' + list.title + '?',
            body: wanted
              ? 'More domains blocked, and more chances of blocking something you wanted.'
              : 'Domains on this list will be allowed again.',
            confirmLabel: wanted ? 'Turn on' : 'Turn off',
          },
          function (pin) {
            return { type: 'quiet:lists.set', id: list.id, on: wanted, pin: pin };
          },
        );
      });
      toggle.appendChild(box);
      item.appendChild(toggle);
      el.lists.appendChild(item);
    });
  }

  function renderAllowlist() {
    el.allowItems.textContent = '';
    if (status.allowlist.length === 0) {
      let empty = document.createElement('p');
      empty.className = 'faint tiny';
      empty.style.margin = '0';
      empty.textContent = 'Nothing is allowed. Every name is checked against the lists.';
      el.allowItems.appendChild(empty);
      return;
    }

    status.allowlist
      .slice()
      .sort()
      .forEach(function (domain) {
        let row = document.createElement('div');
        row.className = 'list-item row';

        let name = document.createElement('span');
        name.className = 'grow wrap';
        name.textContent = domain;
        row.appendChild(name);

        let remove = document.createElement('button');
        remove.className = 'ghost';
        remove.textContent = 'Block again';
        remove.addEventListener('click', function () {
          withPin(
            {
              title: 'Put ' + domain + ' back on the lists?',
              body: 'It will be blocked again, along with its sub-domains.',
              confirmLabel: 'Block again',
            },
            function (pin) {
              return { type: 'quiet:allowlist.remove', domain: domain, pin: pin };
            },
          );
        });
        row.appendChild(remove);
        el.allowItems.appendChild(row);
      });
  }

  function renderStats() {
    el.statToday.textContent = String(status.stats.today);
    el.statTotal.textContent = String(status.stats.total);

    let days = Object.keys(status.stats.days).sort().slice(-14);
    el.history.textContent = '';
    if (days.length === 0) {
      let empty = document.createElement('p');
      empty.className = 'faint tiny';
      empty.style.margin = '0';
      empty.textContent = 'Nothing has been stopped yet.';
      el.history.appendChild(empty);
    } else {
      days.forEach(function (day) {
        let row = document.createElement('div');
        row.className = 'history-row';
        let label = document.createElement('span');
        label.className = 'muted tiny';
        label.textContent = day;
        let value = document.createElement('span');
        value.className = 'tiny';
        value.textContent = String(status.stats.days[day]);
        row.appendChild(label);
        row.appendChild(value);
        el.history.appendChild(row);
      });
    }

    el.statsNote.textContent = status.capabilities.blockedCountsReliable
      ? 'Counts are page loads ' + APP_NAME + ' stopped, not every blocked sub-resource: browsers only report the load.'
      : 'This browser does not reliably report which loads were blocked, so these counts are a best effort.';
  }

  function renderAbout() {
    let lines = [
      ['Version', status.version],
      ['Built for', status.target],
      ['Lists generated', status.generatedAt || 'at build time, inside this package'],
      ['Network calls at runtime', 'none'],
      ['Lists loaded', status.lists.filter(function (list) { return list.on && list.included; }).length + ' of ' + status.lists.length],
    ];
    el.aboutLines.textContent = '';
    lines.forEach(function (pair) {
      let row = document.createElement('div');
      row.className = 'row';
      let key = document.createElement('span');
      key.className = 'muted';
      key.textContent = pair[0];
      let value = document.createElement('span');
      value.className = 'wrap';
      value.style.textAlign = 'right';
      value.textContent = pair[1];
      row.appendChild(key);
      row.appendChild(value);
      el.aboutLines.appendChild(row);
    });
  }

  function render() {
    if (!status) return;
    let on = status.enabled;
    let hasPin = status.hasPin;

    el.pill.className = 'pill ' + (on ? 'on' : 'off');
    el.statusText.textContent = on ? 'Filtering' : 'Off';

    el.setupSection.hidden = hasPin;
    el.protectionSection.hidden = !hasPin;
    el.listsSection.hidden = !hasPin;
    el.allowlistSection.hidden = !hasPin;
    el.statsSection.hidden = !hasPin;
    el.pinSection.hidden = !hasPin;

    if (!hasPin) {
      showBanner('Protection stays off until a PIN exists.', 'warn');
      if (location.hash === '#setup') el.pinNew.focus();
    } else if (on) {
      showBanner('', 'info');
    } else {
      showBanner(APP_NAME + ' is switched off. Nothing is being filtered right now.', 'danger');
    }

    if (hasPin) {
      el.protectionNote.textContent = on
        ? 'Filtering this browser. Every list below is in force.'
        : 'Ready, and doing nothing.';
      el.shieldToggle.textContent = on ? 'Switch protection off' : 'Switch protection on';
      el.shieldToggle.className = on ? 'danger' : 'primary';
      el.commitmentNote.textContent = describeCommitment(status.commitmentRemaining);
      el.commitmentRelease.disabled = status.commitmentRemaining === 0 && status.commitmentUntil === 0;

      renderLists();
      renderAllowlist();
      renderStats();
    }

    renderAbout();
  }

  async function refresh() {
    status = await ui.request({ type: 'quiet:status' });
    render();
  }

  el.pinCreate.addEventListener('click', async function () {
    let pin = el.pinNew.value.trim();
    let confirm = el.pinConfirm.value.trim();
    showError(el.pinCreateError, '');
    if (!/^\d{4,8}$/.test(pin)) {
      showError(el.pinCreateError, 'A PIN is 4 to 8 digits.');
      return;
    }
    if (pin !== confirm) {
      showError(el.pinCreateError, 'The two PINs do not match.');
      return;
    }
    try {
      status = await ui.request({ type: 'quiet:pin.create', pin: pin });
      status = await ui.request({ type: 'quiet:shield.on', pin: pin });
      el.pinNew.value = '';
      el.pinConfirm.value = '';
      render();
    } catch (error) {
      showError(el.pinCreateError, error.message);
    }
  });

  el.shieldToggle.addEventListener('click', async function () {
    if (status.enabled) {
      await withPin(
        {
          title: 'Switch protection off?',
          body: APP_NAME + ' will stop filtering until you switch it back on.',
          confirmLabel: 'Switch off',
        },
        function (pin) {
          return { type: 'quiet:shield.off', pin: pin };
        },
      );
    } else {
      await withPin(
        { title: 'Switch protection on', body: 'Enter your PIN to arm the filter.', confirmLabel: 'Switch on' },
        function (pin) {
          return { type: 'quiet:shield.on', pin: pin };
        },
      );
    }
  });

  el.commitmentStart.addEventListener('click', async function () {
    let hours = Number(el.commitmentHours.value);
    await withPin(
      {
        title: 'Lock protection on for ' + el.commitmentHours.options[el.commitmentHours.selectedIndex].text + '?',
        body: 'Until the timer runs out, ' + APP_NAME + ' will refuse to switch off, even with the PIN.',
        confirmLabel: 'Lock it',
      },
      function (pin) {
        return { type: 'quiet:commitment.set', hours: hours, pin: pin };
      },
    );
  });

  el.commitmentRelease.addEventListener('click', async function () {
    await withPin(
      { title: 'Release the commitment lock?', body: 'You will be able to switch protection off again.', confirmLabel: 'Release' },
      function (pin) {
        return { type: 'quiet:commitment.set', hours: 0, pin: pin };
      },
    );
  });

  el.allowAdd.addEventListener('click', async function () {
    let raw = el.allowInput.value.trim();
    let domain = Domains.normalize(raw);
    if (!domain) {
      showBanner('That is not a domain ' + APP_NAME + ' can allow.', 'danger');
      return;
    }
    let added = await withPin(
      {
        title: 'Allow ' + domain + '?',
        body: 'This domain and its sub-domains will be exempt from every list.',
        confirmLabel: 'Allow',
      },
      function (pin) {
        return { type: 'quiet:allowlist.add', domain: domain, pin: pin };
      },
    );
    if (added) {
      el.allowInput.value = '';
      showBanner('', 'info');
    }
  });

  el.statsClear.addEventListener('click', async function () {
    await withPin(
      { title: 'Clear the statistics?', body: 'Day, session and lifetime counters go back to zero.', confirmLabel: 'Clear' },
      function (pin) {
        return { type: 'quiet:stats.clear', pin: pin };
      },
    );
  });

  el.pinChange.addEventListener('click', async function () {
    let current = el.pinCurrent.value.trim();
    let next = el.pinNext.value.trim();
    showError(el.pinError, '');
    if (!/^\d{4,8}$/.test(next)) {
      showError(el.pinError, 'A PIN is 4 to 8 digits.');
      return;
    }
    try {
      status = await ui.request({ type: 'quiet:pin.change', currentPin: current, newPin: next });
      el.pinCurrent.value = '';
      el.pinNext.value = '';
      render();
    } catch (error) {
      showError(el.pinError, error.message);
    }
  });

  el.pinRemove.addEventListener('click', async function () {
    showError(el.pinError, '');
    let removed = await withPin(
      {
        title: 'Remove the PIN?',
        body: 'Protection stops immediately and the commitment lock is released. The setup screen comes back until a new PIN exists.',
        confirmLabel: 'Remove',
      },
      function (pin) {
        return { type: 'quiet:pin.remove', pin: pin };
      },
      el.pinError,
    );
    if (removed) render();
  });

  ui.api.runtime.onMessage.addListener(function (message) {
    if (message && message.type === 'quiet:changed') refresh().catch(function () {});
    return false;
  });

  // The name comes from the manifest, which the build fills in from `expo.name`.
  document.title = APP_NAME + ' settings';
  document.querySelectorAll('[data-app-name]').forEach(function (node) {
    node.textContent = APP_NAME;
  });

  refresh().catch(function (error) {
    showBanner(error.message || APP_NAME + ' could not read its own state.', 'danger');
  });
})();
