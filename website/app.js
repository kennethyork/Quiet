/**
 * Fills the download buttons in from the latest GitHub release.
 *
 * The page works without this file: every button already links to
 * `https://github.com/kennethyork/Quiet/releases/latest`, which always has the current files. This
 * script only turns those into direct links with the exact asset names, and says which version is
 * current, so nobody has to hunt through a release page.
 *
 * It is the page's only network request, it goes to GitHub's API, and it carries no identifiers.
 */
(function () {
  'use strict';

  let downloads = window.QUIET_DOWNLOADS;

  function setVersion(version, publishedAt) {
    document.querySelectorAll('[data-version]').forEach(function (node) {
      node.textContent = version;
    });
    document.querySelectorAll('[data-release-note]').forEach(function (node) {
      node.hidden = false;
      let when = publishedAt ? new Date(publishedAt).toLocaleDateString() : '';
      node.textContent = when
        ? 'Latest release: ' + version + ', published ' + when + '.'
        : 'Latest release: ' + version + '.';
    });
  }

  function wire(version, label, assets) {
    let missing = [];
    let seen = [];

    document.querySelectorAll('[data-download]').forEach(function (node) {
      let key = node.getAttribute('data-download');
      if (seen.indexOf(key) >= 0) return;
      seen.push(key);

      let name = downloads.assetFor(key, version, label);
      let asset = name
        ? assets.find(function (candidate) {
            return candidate.name === name;
          })
        : null;

      // A release carries only what its build produced. Rather than point at a file that is not
      // there, the button keeps going to the release page and the page says what is still to come.
      if (!asset) {
        missing.push(downloads.describe(key));
        return;
      }

      document.querySelectorAll('[data-download="' + key + '"]').forEach(function (button) {
        button.href = asset.browser_download_url;
        button.setAttribute('download', name);
        button.dataset.resolved = 'true';
        let size = button.querySelector('[data-size]');
        if (size) size.textContent = formatSize(asset.size);
      });
    });

    if (missing.length > 0) {
      let note = document.querySelector('[data-missing-note]');
      if (note) {
        note.hidden = false;
        note.textContent =
          'Not in release ' +
          version +
          ' yet: ' +
          missing.join(', ') +
          '. Those buttons open the release page instead; the next tagged build adds the extension packages.';
      }
    }
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** Marks the visitor's own platform, so the right card is obvious without any tracking. */
  function markVisitor() {
    let ua = navigator.userAgent;
    let platform = ua.includes('Firefox')
      ? 'firefox'
      : /Edg|OPR|Chrome|Chromium/.test(ua)
        ? 'chromium'
        : ua.includes('Safari')
          ? 'safari'
          : ua.includes('Android')
            ? 'apk'
            : '';
    if (!platform) return;
    document.querySelectorAll('[data-platform="' + platform + '"]').forEach(function (node) {
      node.classList.add('is-yours');
      let badge = node.querySelector('.badge.yours');
      if (badge) badge.hidden = false;
    });
  }

  markVisitor();

  // No custom headers on purpose: a plain request is a CORS "simple request", so there is no
  // preflight to fail, and the API answers with JSON anyway.
  fetch(downloads.releasesApi)
    .then(function (response) {
      if (!response.ok) throw new Error('GitHub answered ' + response.status);
      return response.json();
    })
    .then(function (release) {
      let version = String(release.tag_name || '').replace(/^v/, '');
      if (!version) throw new Error('no version in the release');
      let assets = release.assets || [];
      setVersion(version, release.published_at);
      wire(version, labelOf(version, assets, release.name), assets);
    })
    .catch(function () {
      // The buttons already point at the releases page, so a failure here costs nothing.
      document.querySelectorAll('[data-release-note]').forEach(function (node) {
        node.hidden = false;
        node.textContent = 'Download links open the latest release on GitHub.';
      });
    });

  /**
   * The APK is named after the app's own label, so read it back out of the asset the build actually
   * produced rather than hardcoding a name the build is free to change.
   */
  function labelOf(version, assets, releaseName) {
    let apk = assets.find(function (asset) {
      return /\.apk$/.test(asset.name);
    });
    if (!apk) return String(releaseName || '').split(' ')[0];
    return apk.name.slice(0, apk.name.length - ('-' + version + '.apk').length);
  }
})();
