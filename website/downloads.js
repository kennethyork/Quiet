/**
 * Where the downloads come from, in one place.
 *
 * The site never invents a file name: the Android APK and the browser packages are built by CI and
 * attached to a GitHub release, and the names here must match what those builds produce. That is
 * not a comment, it is checked - `website/check.mjs` compares these templates against the naming in
 * `browser-extension/scripts/build.mjs` and `.github/workflows/ci.yml`, so a rename on either side
 * fails the build instead of shipping a dead link.
 *
 * A classic script, so the page and Node can both read it.
 */
(function (root) {
  'use strict';

  let REPO = 'kennethyork/Quiet';
  let RELEASES_LATEST = 'https://github.com/' + REPO + '/releases/latest';
  let RELEASES_API = 'https://api.github.com/repos/' + REPO + '/releases/latest';

  let DOWNLOADS = {
    repo: REPO,
    releasesLatest: RELEASES_LATEST,
    releasesApi: RELEASES_API,

    /** The APK job names the file after the app's own label: `<label>-<version>.apk`. */
    apk: function (version, label) {
      return label + '-' + version + '.apk';
    },

    /** The extension build names each package `quiet-<target>-<version>.<zip|xpi>`. */
    browser: function (target, version) {
      let extension = target === 'firefox' ? 'xpi' : 'zip';
      return 'quiet-' + target + '-' + version + '.' + extension;
    },

    /** Which package each install button points at, and what to call it in the page's own words. */
    targets: {
      apk: { kind: 'apk', label: 'the Android APK' },
      chromium: { kind: 'browser', target: 'chromium', label: 'the Chromium package' },
      firefox: { kind: 'browser', target: 'firefox', label: 'the Firefox package' },
      safari: { kind: 'browser', target: 'safari', label: 'the Safari package' },
    },
  };

  DOWNLOADS.describe = function (key) {
    let target = DOWNLOADS.targets[key];
    return target && target.label ? target.label : key;
  };

  DOWNLOADS.assetFor = function (key, version, label) {
    let target = DOWNLOADS.targets[key];
    if (!target) return null;
    if (target.kind === 'apk') return DOWNLOADS.apk(version, label);
    return DOWNLOADS.browser(target.target, version);
  };

  /** Direct link to one asset of a release, which is what the buttons end up pointing at. */
  DOWNLOADS.assetUrl = function (version, assetName) {
    return 'https://github.com/' + REPO + '/releases/download/v' + version + '/' + assetName;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DOWNLOADS;
  if (root) root.QUIET_DOWNLOADS = DOWNLOADS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
