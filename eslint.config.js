// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'browser-extension/dist/*'],
  },
  // The browser extension in `browser-extension/` is plain JavaScript on purpose: its shared files
  // are classic scripts, because Chrome runs them as a service worker and Firefox as an event page
  // and only one file shape can be declared in both manifests.
  {
    files: ['browser-extension/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
        // The extension APIs, under both namespaces the browsers use.
        chrome: 'readonly',
        browser: 'readonly',
        importScripts: 'readonly',
        // Written into `background/target.js` by scripts/build.mjs, one value per target.
        QUIET_TARGET_NAME: 'readonly',
      },
    },
  },
  {
    files: ['browser-extension/scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['browser-extension/test/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
]);
