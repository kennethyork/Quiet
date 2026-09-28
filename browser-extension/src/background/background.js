/**
 * Quiet's service worker (Chrome/Edge/Brave/Opera/Safari) or event page (Firefox).
 *
 * Everything that can weaken protection is decided here, not in the screens, which is the same
 * split the app uses: the UI asks, the background checks the PIN, and only then does a ruleset
 * get disabled or an allowlist entry appear.
 *
 * The extension has no server and makes no network calls at runtime. Rulesets are built from the
 * same list files the app ships (`modules/quiet-vpn/android/src/main/assets/blocklists/`), and the
 * whole of the blocking is done by the browser's own declarativeNetRequest engine.
 */
(function (root) {
  'use strict';

  if (typeof importScripts === 'function' && typeof QuietDomains === 'undefined') {
    importScripts(
      '/background/target.js',
      '/common/domains.js',
      '/common/lists.js',
      '/common/settings.js',
    );
  }

  let api = root.QuietSettings.api;
  let Domains = root.QuietDomains;
  let LISTS = root.QUIET_LISTS;
  let Settings = root.QuietSettings;

  let TARGET = typeof QUIET_TARGET_NAME === 'string' ? QUIET_TARGET_NAME : sniffTarget();
  // The app's own name, never hardcoded: the build puts `expo.name` in the manifest.
  let APP_NAME = Settings.appName();
  let ALLOW_RULE_PRIORITY = 2;
  let RULESET_INDEX_PATH = 'rulesets/index.json';

  /**
   * How a blocked load is reported differs per engine, and the engines document the string as
   * internal and unstable. Chromium reports `net::ERR_BLOCKED_BY_CLIENT`; Gecko reports the
   * NS_ERROR_* form. Safari follows Chromium here.
   */
  let BLOCKED_ERRORS = {
    chromium: /ERR_BLOCKED_BY_CLIENT/,
    safari: /ERR_BLOCKED_BY_CLIENT/,
    firefox: /NS_ERROR_ABORT|NS_ERROR_BLOCKED_URI/,
  };

  /** Per-tab counters, mirrored into storage.session so a sleeping worker does not lose them. */
  let tabCounts = new Map();
  let rulesetIndexCache = null;
  let blockCache = null;

  function sniffTarget() {
    let ua = (root.navigator && root.navigator.userAgent) || '';
    if (ua.indexOf('Firefox') >= 0) return 'firefox';
    if (ua.indexOf('Safari') >= 0 && ua.indexOf('Chrome') < 0) return 'safari';
    return 'chromium';
  }

  function fail(code, message) {
    let error = new Error(message);
    error.code = code;
    return error;
  }

  function session() {
    return api.storage && api.storage.session ? api.storage.session : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Rulesets
  // ---------------------------------------------------------------------------------------------

  /** Metadata written by the build: which rulesets shipped and how many domains each holds. */
  async function rulesetIndex() {
    if (rulesetIndexCache) return rulesetIndexCache;
    try {
      let response = await fetch(api.runtime.getURL(RULESET_INDEX_PATH));
      rulesetIndexCache = await response.json();
    } catch (_error) {
      rulesetIndexCache = { rulesets: [], generatedAt: null };
    }
    return rulesetIndexCache;
  }

  async function availableRulesetIds() {
    let index = await rulesetIndex();
    return index.rulesets.map(function (entry) {
      return entry.id;
    });
  }

  function defaultLists() {
    let lists = {};
    for (let i = 0; i < LISTS.length; i++) {
      lists[LISTS[i].id] = Boolean(LISTS[i].default);
    }
    return lists;
  }

  /** The rulesets that should be enabled for the current settings. */
  function desiredRulesets(state, available) {
    if (!state.enabled) return [];
    let wanted = [];
    for (let i = 0; i < LISTS.length; i++) {
      let list = LISTS[i];
      if (!state.lists[list.id]) continue;
      if (available.indexOf(list.id) < 0) continue;
      wanted.push(list.id);
    }
    return wanted;
  }

  async function syncRulesets(state) {
    let available = await availableRulesetIds();
    let wanted = desiredRulesets(state, available);
    let current = await api.declarativeNetRequest.getEnabledRulesets();

    let toEnable = wanted.filter(function (id) {
      return current.indexOf(id) < 0;
    });
    let toDisable = current.filter(function (id) {
      return wanted.indexOf(id) < 0;
    });
    if (toEnable.length === 0 && toDisable.length === 0) return { enabled: current };

    await api.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: toEnable,
      disableRulesetIds: toDisable,
    });
    return { enabled: wanted };
  }

  /**
   * The allowlist becomes dynamic `allow` rules at a higher priority than the block rules, which
   * is the extension's version of "the allowlist is consulted first and wins".
   */
  async function syncAllowlist(state) {
    let existing = await api.declarativeNetRequest.getDynamicRules();
    let removeRuleIds = existing.map(function (rule) {
      return rule.id;
    });

    let addRules = [];
    let ids = new Set();
    let domains = state.allowlist.slice().sort();
    for (let i = 0; i < domains.length; i++) {
      if (domains[i] === '' || ids.has(domains[i])) continue;
      ids.add(domains[i]);
      addRules.push({
        id: addRules.length + 1,
        priority: ALLOW_RULE_PRIORITY,
        action: { type: 'allow' },
        condition: { requestDomains: [domains[i]] },
      });
    }

    await api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeRuleIds,
      addRules: addRules,
    });
  }

  async function syncAll(state) {
    let next = state || (await Settings.readState());
    await syncRulesets(next);
    await syncAllowlist(next);
    await refreshBadgeForAllTabs(next);
    return next;
  }

  // ---------------------------------------------------------------------------------------------
  // Stats and badge
  // ---------------------------------------------------------------------------------------------

  async function restoreTabCounts() {
    let store = session();
    if (!store) return;
    try {
      let bag = await store.get('quiet.tabCounts');
      let stored = bag ? bag['quiet.tabCounts'] : null;
      if (stored && typeof stored === 'object') {
        tabCounts = new Map(Object.entries(stored));
      }
    } catch (_error) {
      /* session storage is best effort */
    }
  }

  async function persistTabCounts() {
    let store = session();
    if (!store) return;
    try {
      await store.set({ 'quiet.tabCounts': Object.fromEntries(tabCounts) });
    } catch (_error) {
      /* session storage is best effort */
    }
  }

  function countFor(tabId) {
    return tabCounts.get(tabId) || 0;
  }

  function badgeText(count) {
    if (count <= 0) return '';
    return count > 99 ? '99+' : String(count);
  }

  async function setBadge(tabId, count, enabled) {
    let text = enabled ? badgeText(count) : 'off';
    let color = enabled ? '#6366F1' : '#F43F5E';
    try {
      await api.action.setBadgeBackgroundColor({ tabId: tabId, color: color });
      await api.action.setBadgeText({ tabId: tabId, text: text });
    } catch (_error) {
      /* a tab that has gone away needs no badge */
    }
  }

  async function refreshBadgeForAllTabs(state) {
    let current = state || (await Settings.readState());
    let tabs = [];
    try {
      tabs = await api.tabs.query({});
    } catch (_error) {
      return;
    }
    for (let i = 0; i < tabs.length; i++) {
      let tab = tabs[i];
      if (typeof tab.id !== 'number') continue;
      await setBadge(tab.id, countFor(tab.id), current.enabled);
    }
    try {
      await api.action.setTitle({
        title: current.enabled
          ? APP_NAME + ' is filtering this browser'
          : APP_NAME + ' is switched off - open it before trouble starts',
      });
    } catch (_error) {
      /* titles are cosmetic */
    }
  }

  /** Records one blocked top-level load. Sub-resource blocking is not reported by the engines. */
  async function recordBlocked(tabId, url) {
    let next = countFor(tabId) + 1;
    tabCounts.set(tabId, next);
    await persistTabCounts();

    let state = await Settings.readState();
    await setBadge(tabId, next, state.enabled);

    let key = Settings.todayKey();
    await Settings.update(function (draft) {
      draft.stats.total += 1;
      draft.stats.days[key] = (draft.stats.days[key] || 0) + 1;
      return draft;
    });

    // Tell any open popup to redraw.
    try {
      await api.runtime.sendMessage({ type: 'quiet:changed', reason: 'blocked', url: url });
    } catch (_error) {
      /* nobody is listening */
    }
  }

  function wireNavigation() {
    if (!api.webNavigation) return;

    api.webNavigation.onBeforeNavigate.addListener(async function (details) {
      if (details.frameId !== 0) return;
      tabCounts.set(details.tabId, 0);
      await persistTabCounts();
      let state = await Settings.readState();
      await setBadge(details.tabId, 0, state.enabled);
    });

    api.webNavigation.onErrorOccurred.addListener(async function (details) {
      if (details.frameId !== 0) return;
      if (typeof details.tabId !== 'number' || details.tabId < 0) return;
      if (!details.error && !details.url) return;

      let state = await Settings.readState();
      if (!state.enabled) return;

      let pattern = BLOCKED_ERRORS[TARGET] || BLOCKED_ERRORS.chromium;
      let blockedBy = pattern.test('' + (details.error || ''));

      // Engines document their error strings as internal and unstable, so the lists decide when
      // the string does not match: a top-level load that failed, on a domain the active rulesets
      // cover, is a load this extension stopped.
      if (!blockedBy) {
        let rules = await activeBlockRules();
        blockedBy = rules && rules.isBlocked(hostOf(details.url));
      }
      if (!blockedBy) return;

      await recordBlocked(details.tabId, details.url);
    });

    api.tabs.onRemoved.addListener(function (tabId) {
      tabCounts.delete(tabId);
      persistTabCounts();
    });
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (_error) {
      return '';
    }
  }

  /**
   * A matcher built from the shipped rulesets themselves, used when the browser's error string
   * does not name the blocker. Reading the rules back means the fallback cannot disagree with the
   * blocking: both come from one generated file, parsed by one parser.
   */
  async function activeBlockRules() {
    if (blockCache) return blockCache;
    let state = await Settings.readState();
    let available = await availableRulesetIds();
    let wanted = desiredRulesets(state, available);
    let domains = [];
    for (let i = 0; i < wanted.length; i++) {
      try {
        let response = await fetch(api.runtime.getURL('rulesets/' + wanted[i] + '.json'));
        let rules = await response.json();
        for (let j = 0; j < rules.length; j++) {
          let list = rules[j].condition && rules[j].condition.requestDomains;
          if (list) domains.push(list);
        }
      } catch (_error) {
        /* a ruleset we cannot read only costs us the fallback, never the blocking */
      }
    }
    blockCache = Domains.DomainRules.fromLists(domains, state.allowlist);
    return blockCache;
  }

  // ---------------------------------------------------------------------------------------------
  // Messages from the popup and the options page
  // ---------------------------------------------------------------------------------------------

  async function requirePin(state, pin, action) {
    if (!state.pin) {
      throw fail('pin-required', 'Set a PIN before ' + action + '.');
    }
    let ok = await Settings.verifyPin(state, pin);
    if (!ok) throw fail('pin-invalid', 'That PIN is not right.');
  }

  async function status() {
    let state = await Settings.readState();
    let index = await rulesetIndex();
    let byId = {};
    for (let i = 0; i < index.rulesets.length; i++) byId[index.rulesets[i].id] = index.rulesets[i];

    let lists = LISTS.map(function (list) {
      let entry = byId[list.id];
      return {
        id: list.id,
        title: list.title,
        description: list.description,
        locked: Boolean(list.locked),
        optional: Boolean(list.optional),
        heavy: Boolean(list.heavy),
        source: list.source || null,
        included: Boolean(entry),
        domains: entry ? entry.domains : 0,
        on: Boolean(state.lists[list.id]),
      };
    });

    return {
      ok: true,
      target: TARGET,
      version: api.runtime.getManifest().version,
      enabled: state.enabled,
      hasPin: Boolean(state.pin),
      commitmentUntil: state.commitmentUntil || 0,
      commitmentRemaining: Settings.commitmentRemaining(state),
      allowlist: state.allowlist.slice(),
      stats: {
        total: state.stats.total || 0,
        today: state.stats.days[Settings.todayKey()] || 0,
        days: state.stats.days,
      },
      lists: lists,
      generatedAt: index.generatedAt || null,
      capabilities: {
        blockedCountsReliable: TARGET !== 'firefox',
      },
    };
  }

  async function createPin(pin) {
    if (!Settings.isValidPin(pin)) {
      throw fail('pin-invalid', 'A PIN is 4 to 8 digits.');
    }
    let state = await Settings.readState();
    if (state.pin) throw fail('pin-exists', 'A PIN already exists.');
    let record = await Settings.createPin(pin);
    await Settings.update(function (draft) {
      draft.pin = record;
      draft.installedAt = draft.installedAt || Date.now();
      return draft;
    });
    return status();
  }

  async function changePin(currentPin, newPin) {
    if (!Settings.isValidPin(newPin)) {
      throw fail('pin-invalid', 'A PIN is 4 to 8 digits.');
    }
    let state = await Settings.readState();
    await requirePin(state, currentPin, 'change the PIN');
    let record = await Settings.createPin(newPin);
    await Settings.update(function (draft) {
      draft.pin = record;
      return draft;
    });
    return status();
  }

  /** Removing the PIN stops protection and releases the lock, exactly as the app does. */
  async function removePin(pin) {
    let state = await Settings.readState();
    await requirePin(state, pin, 'remove the PIN');
    await Settings.update(function (draft) {
      draft.pin = null;
      draft.enabled = false;
      draft.commitmentUntil = 0;
      return draft;
    });
    let next = await Settings.readState();
    await syncAll(next);
    return status();
  }

  async function shieldOn(pin) {
    let state = await Settings.readState();
    await requirePin(state, pin, 'switch protection on');
    await Settings.update(function (draft) {
      draft.enabled = true;
      return draft;
    });
    let next = await Settings.readState();
    await syncAll(next);
    return status();
  }

  async function shieldOff(pin) {
    let state = await Settings.readState();
    await requirePin(state, pin, 'switch protection off');
    let remaining = Settings.commitmentRemaining(state);
    if (remaining > 0) {
      throw fail('commitment', 'Commitment lock is on for another ' + describeRemaining(remaining) + '.');
    }
    await Settings.update(function (draft) {
      draft.enabled = false;
      return draft;
    });
    let next = await Settings.readState();
    await syncAll(next);
    return status();
  }

  async function setList(id, on, pin) {
    let list = null;
    for (let i = 0; i < LISTS.length; i++) if (LISTS[i].id === id) list = LISTS[i];
    if (!list) throw fail('unknown-list', 'That list is not part of this build.');
    if (list.locked && !on) throw fail('locked-list', 'This list cannot be switched off.');
    if (on) {
      let available = await availableRulesetIds();
      if (available.indexOf(id) < 0) {
        throw fail('list-unavailable', 'This build did not include that list.');
      }
    }
    let state = await Settings.readState();
    await requirePin(state, pin, 'change the lists');
    await Settings.update(function (draft) {
      draft.lists[id] = Boolean(on);
      return draft;
    });
    blockCache = null;
    let next = await Settings.readState();
    await syncAll(next);
    return status();
  }

  async function allowlistAdd(rawDomain, pin) {
    let domain = Domains.normalize(rawDomain);
    if (!domain) throw fail('bad-domain', 'That is not a domain ' + APP_NAME + ' can allow.');
    let state = await Settings.readState();
    await requirePin(state, pin, 'change the allowlist');
    await Settings.update(function (draft) {
      if (draft.allowlist.indexOf(domain) < 0) draft.allowlist.push(domain);
      return draft;
    });
    blockCache = null;
    let next = await Settings.readState();
    await syncAll(next);
    return status();
  }

  async function allowlistRemove(rawDomain, pin) {
    let domain = Domains.normalize(rawDomain) || String(rawDomain).trim().toLowerCase();
    let state = await Settings.readState();
    await requirePin(state, pin, 'change the allowlist');
    await Settings.update(function (draft) {
      draft.allowlist = draft.allowlist.filter(function (entry) {
        return entry !== domain;
      });
      return draft;
    });
    blockCache = null;
    let next = await Settings.readState();
    await syncAll(next);
    return status();
  }

  async function clearStats(pin) {
    let state = await Settings.readState();
    await requirePin(state, pin, 'clear the statistics');
    await Settings.update(function (draft) {
      draft.stats = { total: 0, days: {} };
      return draft;
    });
    tabCounts = new Map();
    await persistTabCounts();
    let next = await Settings.readState();
    await refreshBadgeForAllTabs(next);
    return status();
  }

  async function setCommitment(hours, pin) {
    let state = await Settings.readState();
    await requirePin(state, pin, 'change the commitment');
    let until = hours > 0 ? Date.now() + hours * 3600000 : 0;
    await Settings.update(function (draft) {
      draft.commitmentUntil = until;
      return draft;
    });
    return status();
  }

  function describeRemaining(ms) {
    let minutes = Math.ceil(ms / 60000);
    if (minutes < 60) return minutes + ' minute' + (minutes === 1 ? '' : 's');
    let hours = Math.ceil(minutes / 60);
    if (hours < 48) return hours + ' hour' + (hours === 1 ? '' : 's');
    return Math.ceil(hours / 24) + ' days';
  }

  async function handle(message) {
    if (!message || typeof message.type !== 'string') throw fail('bad-request', 'Unknown request.');
    switch (message.type) {
      case 'quiet:status':
        return status();
      case 'quiet:pin.create':
        return createPin(message.pin);
      case 'quiet:pin.change':
        return changePin(message.currentPin, message.newPin);
      case 'quiet:pin.remove':
        return removePin(message.pin);
      case 'quiet:pin.check': {
        let state = await Settings.readState();
        return { ok: true, valid: await Settings.verifyPin(state, message.pin) };
      }
      case 'quiet:shield.on':
        return shieldOn(message.pin);
      case 'quiet:shield.off':
        return shieldOff(message.pin);
      case 'quiet:lists.set':
        return setList(message.id, message.on, message.pin);
      case 'quiet:allowlist.add':
        return allowlistAdd(message.domain, message.pin);
      case 'quiet:allowlist.remove':
        return allowlistRemove(message.domain, message.pin);
      case 'quiet:stats.clear':
        return clearStats(message.pin);
      case 'quiet:commitment.set':
        return setCommitment(message.hours, message.pin);
      case 'quiet:tab.count': {
        if (typeof message.tabId !== 'number') return { ok: true, count: 0 };
        if (!tabCounts.has(message.tabId)) await restoreTabCounts();
        return { ok: true, count: countFor(message.tabId) };
      }
      case 'quiet:changed':
        return { ok: true }; // broadcast from this worker; nothing to do
      default:
        throw fail('bad-request', 'Unknown request: ' + message.type);
    }
  }

  function wireMessages() {
    api.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      handle(message).then(
        function (response) {
          sendResponse(response);
        },
        function (error) {
          sendResponse({
            ok: false,
            error: error.code || 'error',
            message: error.message || 'Something went wrong.',
          });
        },
      );
      return true;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  async function install() {
    let state = await Settings.readState();
    let lists = Object.assign(defaultLists(), state.lists);
    lists['adult-core'] = true; // never off
    await Settings.update(function (draft) {
      draft.lists = lists;
      draft.installedAt = draft.installedAt || Date.now();
      if (!draft.pin) draft.enabled = false; // no PIN, no protection
      return draft;
    });
    let next = await Settings.readState();
    await syncAll(next);
  }

  api.runtime.onInstalled.addListener(function (details) {
    install().then(
      function () {
        if (details.reason === 'install') {
          // The first thing the user sees is the PIN, the same gate the app opens with.
          api.runtime.openOptionsPage();
        }
      },
      function () {},
    );
  });

  api.runtime.onStartup.addListener(function () {
    restoreTabCounts().then(
      function () {
        return syncAll();
      },
      function () {},
    );
  });

  restoreTabCounts().then(
    function () {
      return syncAll();
    },
    function () {},
  );

  wireMessages();
  wireNavigation();
})(typeof globalThis !== 'undefined' ? globalThis : this);
