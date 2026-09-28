/**
 * Small helpers shared by the popup and the options page.
 *
 * Both screens talk to the service worker for anything that matters, and neither of them decides
 * whether an action is allowed: they send the PIN along and show whatever comes back.
 */
(function (root) {
  'use strict';

  let api = root.browser || root.chrome;

  function sendMessage(message) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      function done(response) {
        if (settled) return;
        settled = true;
        resolve(response);
      }
      try {
        let maybePromise = api.runtime.sendMessage(message, function (response) {
          let error = api.runtime.lastError;
          if (error) {
            if (!settled) {
              settled = true;
              reject(new Error(error.message));
            }
            return;
          }
          done(response);
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(done, function (error) {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });
  }

  /** The app's own name, from the manifest the build generated out of `expo.name`. */
  function appName() {
    try {
      return api.runtime.getManifest().name;
    } catch (_error) {
      return 'This extension';
    }
  }

  /** Sends a request and throws the background's own message, so screens can just show it. */
  async function request(message) {
    let response = await sendMessage(message);
    if (!response) throw new Error(appName() + ' did not answer. Try reopening this window.');
    if (response.ok === false) {
      let error = new Error(response.message || 'Something went wrong.');
      error.code = response.error;
      throw error;
    }
    return response;
  }

  function domainOf(url) {
    try {
      let parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.hostname;
    } catch (_error) {
      return '';
    }
  }

  function plural(count, word) {
    return count === 1 ? '1 ' + word : count + ' ' + word + 's';
  }

  function formatRemaining(ms) {
    let minutes = Math.ceil(ms / 60000);
    if (minutes < 60) return plural(minutes, 'minute');
    let hours = Math.ceil(minutes / 60);
    if (hours < 48) return plural(hours, 'hour');
    return plural(Math.ceil(hours / 24), 'day');
  }

  function formatWhen(timestamp) {
    return new Date(timestamp).toLocaleString();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[character];
    });
  }

  /** A tiny PIN prompt: every action that weakens protection goes through one of these. */
  function askPin(options) {
    let settings = options || {};
    return new Promise(function (resolve, reject) {
      let overlay = document.createElement('div');
      overlay.className = 'modal';
      overlay.innerHTML =
        '<div class="modal-panel stack">' +
        '<h2>' +
        escapeHtml(settings.title || 'Enter your PIN') +
        '</h2>' +
        '<p class="muted tiny" style="margin:0">' +
        escapeHtml(settings.body || 'The PIN is what stands between a bad moment and switching this off.') +
        '</p>' +
        '<input type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]*" maxlength="8" placeholder="4-8 digits" />' +
        '<div class="row">' +
        '<button type="button" class="ghost" data-role="cancel">Cancel</button>' +
        '<button type="button" class="primary" data-role="ok">' +
        escapeHtml(settings.confirmLabel || 'Confirm') +
        '</button>' +
        '</div>' +
        '</div>';

      let input = overlay.querySelector('input');
      function close() {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
      function submit() {
        let value = input.value.trim();
        if (!/^\d{4,8}$/.test(value)) {
          input.focus();
          input.select();
          return;
        }
        close();
        resolve(value);
      }
      function onKey(event) {
        if (event.key === 'Escape') {
          close();
          reject(new Error('cancelled'));
        }
      }

      overlay.querySelector('[data-role="cancel"]').addEventListener('click', function () {
        close();
        reject(new Error('cancelled'));
      });
      overlay.querySelector('[data-role="ok"]').addEventListener('click', submit);
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') submit();
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      input.focus();
    });
  }

  root.QuietUi = {
    api: api,
    appName: appName,
    request: request,
    sendMessage: sendMessage,
    domainOf: domainOf,
    formatRemaining: formatRemaining,
    formatWhen: formatWhen,
    escapeHtml: escapeHtml,
    askPin: askPin,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
