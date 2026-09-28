/**
 * Stored state, the PIN, and the small API shim the rest of the extension shares.
 *
 * Ported habits from the app: everything lives under storage keys prefixed `quiet`, a PIN is
 * mandatory before protection can run, and anything that weakens protection goes through one
 * place - here the service worker - rather than each screen deciding for itself.
 *
 * Unlike the app's PIN, this one is not a security boundary: anyone who can open
 * `chrome://extensions` can switch the extension off without ever seeing this code. It is a
 * speed bump for the moment when you want to switch it off, which is all a browser extension can
 * offer, and the README says so.
 */
(function (root) {
  'use strict';

  let api = root.browser || root.chrome;
  let STATE_KEY = 'quiet.state';
  let PBKDF2_ITERATIONS = 200000;
  let PIN_PATTERN = /^\d{4,8}$/;

  let DEFAULTS = {
    version: 1,
    /** Whether the shield is filtering. Never true without a PIN. */
    enabled: false,
    /** List id -> on/off. `adult-core` is locked on. */
    lists: {},
    /** Domains the user has excused, matched by suffix like everything else. */
    allowlist: [],
    /** { salt, hash, iterations } or null. */
    pin: null,
    /** Epoch ms; while in the future the shield refuses to be switched off. */
    commitmentUntil: 0,
    stats: { total: 0, days: {} },
    installedAt: 0,
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function merge(stored) {
    let state = clone(DEFAULTS);
    if (!stored || typeof stored !== 'object') return state;
    let keys = Object.keys(DEFAULTS);
    for (let i = 0; i < keys.length; i++) {
      let key = keys[i];
      if (stored[key] === undefined || stored[key] === null) continue;
      if (key === 'lists' || key === 'stats') {
        if (typeof stored[key] === 'object') {
          state[key] = Object.assign(clone(DEFAULTS[key]), stored[key]);
        }
      } else {
        state[key] = stored[key];
      }
    }
    state.installId = stored.installId;
    return state;
  }

  function storage() {
    if (!api || !api.storage || !api.storage.local) {
      throw new Error('This browser does not expose extension storage.');
    }
    return api.storage.local;
  }

  async function readState() {
    let bag = await storage().get(STATE_KEY);
    return merge(bag ? bag[STATE_KEY] : null);
  }

  async function writeState(state) {
    await storage().set({ [STATE_KEY]: state });
    return state;
  }

  async function update(mutator) {
    let state = await readState();
    let result = mutator(state);
    await writeState(state);
    return result === undefined ? state : result;
  }

  function isValidPin(pin) {
    return typeof pin === 'string' && PIN_PATTERN.test(pin);
  }

  function toHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function randomHex(byteLength) {
    let bytes = new Uint8Array(byteLength);
    root.crypto.getRandomValues(bytes);
    return toHex(bytes);
  }

  /**
   * Salted PBKDF2-HMAC-SHA256. The app stores a salted SHA-256 of the PIN; a browser has a
   * proper KDF available, so this uses one instead of copying the weaker construction.
   */
  async function hashPin(pin, saltHex, iterations) {
    let material = await root.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pin),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    let bits = await root.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: new TextEncoder().encode(saltHex),
        iterations: iterations || PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      material,
      256,
    );
    return toHex(new Uint8Array(bits));
  }

  async function createPin(pin) {
    let salt = randomHex(16);
    let hash = await hashPin(pin, salt, PBKDF2_ITERATIONS);
    return { salt: salt, hash: hash, iterations: PBKDF2_ITERATIONS };
  }

  async function verifyPin(state, pin) {
    if (!state.pin || !isValidPin(pin)) return false;
    let candidate = await hashPin(pin, state.pin.salt, state.pin.iterations);
    return candidate === state.pin.hash;
  }

  function todayKey(now) {
    let date = new Date(now || Date.now());
    let month = String(date.getMonth() + 1).padStart(2, '0');
    let day = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + month + '-' + day;
  }

  function commitmentRemaining(state, now) {
    let remaining = (state.commitmentUntil || 0) - (now || Date.now());
    return remaining > 0 ? remaining : 0;
  }

  /**
   * The app's own name, read from the manifest the build generated out of `expo.name`.
   *
   * Nothing user-visible may hardcode it, exactly as in the app: changing one line of `app.json`
   * renames both products.
   */
  function appName() {
    try {
      return api.runtime.getManifest().name;
    } catch (_error) {
      return 'This extension';
    }
  }

  let QuietSettings = {
    appName: appName,
    STATE_KEY: STATE_KEY,
    PBKDF2_ITERATIONS: PBKDF2_ITERATIONS,
    DEFAULTS: DEFAULTS,
    isValidPin: isValidPin,
    readState: readState,
    writeState: writeState,
    update: update,
    hashPin: hashPin,
    createPin: createPin,
    verifyPin: verifyPin,
    todayKey: todayKey,
    commitmentRemaining: commitmentRemaining,
    /** The extension's own API namespace, promise based in every browser we support. */
    api: api,
    hasApi: function () {
      return Boolean(api && api.runtime && api.declarativeNetRequest);
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = QuietSettings;
  if (root) root.QuietSettings = QuietSettings;
})(typeof globalThis !== 'undefined' ? globalThis : this);
