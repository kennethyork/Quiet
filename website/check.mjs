/**
 * Checks the website against the things it claims.
 *
 *   node website/check.mjs
 *
 * The site is static and hand-written, so it can rot quietly: a link to a file that moved, a
 * download name that no longer matches what the builds produce, a domain count that changed under
 * it, a version number someone typed by hand. This script fails the build instead, which is the
 * only way a hand-written page stays true.
 *
 * It has no dependencies, like everything else in this repository.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageName } from '../browser-extension/scripts/build.mjs';

const require = createRequire(import.meta.url);
// The parser is a classic script with a CommonJS export, so it is required rather than imported.
const Domains = require('../browser-extension/src/common/domains.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const downloads = require('./downloads.js');

const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

/** Every page the site publishes. The store forms link to the privacy one. */
const PAGES = ['index.html', 'privacy.html'];
const pages = new Map(
  await Promise.all(PAGES.map(async (name) => [name, await readFile(path.join(here, name), 'utf8')])),
);
const html = pages.get('index.html');
const styles = await readFile(path.join(here, 'style.css'), 'utf8');
const scripts = await Promise.all(
  ['app.js', 'downloads.js'].map((file) => readFile(path.join(here, file), 'utf8')),
);
const markup = [...pages.values(), styles, ...scripts].join('\n');

const appJson = JSON.parse(await readFile(path.join(repoRoot, 'app.json'), 'utf8'));
const identity = { name: appJson.expo.name, version: appJson.expo.version };

// -----------------------------------------------------------------------------------------------
// The page is self-contained and honest about where things come from
// -----------------------------------------------------------------------------------------------

const missing = [];
let referenceCount = 0;
const insecure = [];
for (const [name, source] of pages) {
  const refs = [...source.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  referenceCount += refs.length;
  for (const ref of refs) {
    if (ref.startsWith('#')) continue;
    if (ref.startsWith('http') || ref.startsWith('//')) {
      if (!ref.startsWith('https://')) insecure.push(`${name}: ${ref}`);
      continue;
    }
    if (ref.startsWith('mailto:')) continue;
    if (!existsSync(path.join(here, ref.split('#')[0]))) missing.push(`${name}: ${ref}`);
  }
}

check(
  'every local reference exists',
  missing.length === 0,
  missing.length > 0 ? missing.join(', ') : `${referenceCount} references across ${PAGES.length} pages`,
);
check('every external link is HTTPS', insecure.length === 0, insecure.join(', '));

const trackerPatterns = [
  /google-analytics/i,
  /googletagmanager/i,
  /\bgtag\b/i,
  /doubleclick/i,
  /facebook\.net/i,
  /hotjar/i,
  /matomo/i,
  /plausible/i,
  /mixpanel/i,
  /segment\.(com|io)/i,
  /cdn\.jsdelivr/i,
  /unpkg/i,
  /fonts\.googleapis/i,
];
const trackers = trackerPatterns.filter((pattern) => pattern.test(markup));
check(
  'nothing third-party is loaded',
  trackers.length === 0,
  trackers.length > 0 ? trackers.map(String).join(', ') : 'no trackers, no CDNs, no webfonts',
);

// One network call is allowed, and it is named in the page rather than hidden.
check(
  'the only runtime request is disclosed',
  markup.includes('api.github.com') && /GitHub's API/i.test(html),
  "GitHub's release API, named in the privacy section",
);

check(
  'the privacy policy is reachable from the download page',
  /href="privacy\.html"/.test(html),
  'linked from the footer',
);

// The stores are given this URL in their forms, so it has to be the page that ships.
const privacyUrl = 'https://kennethyork.github.io/Quiet/privacy.html';
const listingText = await readFile(path.join(repoRoot, 'browser-extension', 'store', 'listing.md'), 'utf8');
check(
  'the privacy URL the stores are given resolves to the published page',
  listingText.includes(privacyUrl) && existsSync(path.join(here, 'privacy.html')),
  privacyUrl,
);

check(
  'the privacy policy covers both products and this site',
  ['Android app', 'Browser extension', 'website'].every((subject) => pages.get('privacy.html').includes(subject)),
  'extension, app and site, with the permissions spelled out',
);

// -----------------------------------------------------------------------------------------------
// Downloads point at files the builds actually produce
// -----------------------------------------------------------------------------------------------

const fakeVersion = '9.9.9';
for (const target of ['chromium', 'firefox', 'safari']) {
  const expected = packageName({ ...identity, version: fakeVersion }, target);
  const fromSite = downloads.browser(target, fakeVersion);
  check(`the ${target} download name matches the extension build`, expected === fromSite, `${expected}`);
}

const workflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const apkLine = workflow
  .split('\n')
  .find((line) => line.includes('app-release.apk') && line.includes('dist/'));
const apkPattern = apkLine?.match(/"([^"]*\.apk)"/)?.[1];
check(
  'the APK download name matches the release job',
  Boolean(apkPattern) &&
    apkPattern === `dist/\${label}-\${version}.apk` &&
    downloads.apk(fakeVersion, 'Label') === `Label-${fakeVersion}.apk`,
  apkLine?.trim(),
);

const keys = [...html.matchAll(/data-download="([^"]+)"/g)].map((match) => match[1]);
const unknown = [...new Set(keys)].filter((key) => !downloads.targets[key]);
check('every download button maps to a package', unknown.length === 0, unknown.join(', '));

const unusedTargets = Object.keys(downloads.targets).filter((key) => !keys.includes(key));
check('every package is offered on the page', unusedTargets.length === 0, unusedTargets.join(', '));

// Versions are read from the release at runtime; a hardcoded file name on the page would go stale
// the moment a release happens, and nobody would notice.
const hardcodedAsset = html.match(/[A-Za-z]+-\d+\.\d+\.\d+\.(apk|zip|xpi)/);
check(
  'no download file name is hardcoded with a version',
  !hardcodedAsset,
  hardcodedAsset ? hardcodedAsset[0] : 'names come from the release API',
);

// No published page names a version at all, for the same reason: the site is not rebuilt per
// release. The pattern ignores anything with a fourth part, so an address like 0.0.0.0 - which the
// page mentions as an answer mode - is not mistaken for a version.
const versionPattern = /(?<![\d.])\d+\.\d+\.\d+(?![\d.])/;
const versionedPage = [...pages.entries()].find(([, source]) => versionPattern.test(source));
check(
  'no page hardcodes a version number',
  !versionedPage,
  versionedPage ? versionedPage[0] : `${PAGES.join(', ')} stay true across releases`,
);

// -----------------------------------------------------------------------------------------------
// The buttons really do hand out the app and the extensions
// -----------------------------------------------------------------------------------------------

/**
 * Runs `app.js` against a fake DOM and a fake release, so the wiring is tested rather than assumed:
 * which link each button ends up with, and what the page says when a release is missing a package.
 */
async function runWiring(release) {
  const nodes = [];
  const make = (attrs) => {
    const node = {
      attrs: { ...attrs },
      dataset: { ...attrs },
      hidden: true,
      textContent: '',
      href: '',
      getAttribute: (name) => (name in node.attrs ? node.attrs[name] : null),
      setAttribute(name, value) {
        node.attrs[name] = value;
        if (name === 'download') node.dataset.download = value;
      },
      classList: { add() {} },
      querySelector: (selector) => node.children?.[selector] || null,
    };
    nodes.push(node);
    return node;
  };

  const buttons = Object.keys(downloads.targets).map((key) => make({ 'data-download': key }));
  buttons[0].children = { '[data-size]': make({}) };
  const versionNodes = [make({ 'data-version': '' })];
  const releaseNote = make({ 'data-release-note': '' });
  const missingNote = make({ 'data-missing-note': '' });

  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-download]') return buttons;
      if (selector === '[data-version]') return versionNodes;
      if (selector === '[data-release-note]') return [releaseNote];
      if (selector === '[data-missing-note]') return [missingNote];
      const exact = selector.match(/^\[data-download="(.+)"\]$/);
      if (exact) return buttons.filter((button) => button.getAttribute('data-download') === exact[1]);
      return [];
    },
    querySelector(selector) {
      if (selector === '[data-missing-note]') return missingNote;
      return null;
    },
  };

  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    fetch: globalThis.fetch,
  };
  globalThis.window = { QUIET_DOWNLOADS: downloads };
  globalThis.document = document;
  globalThis.navigator = { userAgent: 'Mozilla/5.0 Firefox/130.0' };
  globalThis.fetch = async () => ({ ok: true, json: async () => release });

  try {
    const source = await readFile(path.join(here, 'app.js'), 'utf8');
    new Function(source)();
    for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    return { buttons, versionNodes, releaseNote, missingNote };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

const partial = await runWiring({
  tag_name: 'v1.0.6',
  name: 'Quiet v1.0.6',
  published_at: '2026-09-28T00:00:00Z',
  assets: [{ name: 'Quiet-1.0.6.apk', size: 12345678, browser_download_url: 'https://example.invalid/Quiet-1.0.6.apk' }],
});
check(
  'the APK button links straight at the release asset',
  partial.buttons[0].href === 'https://example.invalid/Quiet-1.0.6.apk' && partial.buttons[0].dataset.download === 'Quiet-1.0.6.apk',
  partial.buttons[0].href,
);
check(
  'the version is filled in from the release',
  partial.versionNodes[0].textContent === '1.0.6',
  partial.versionNodes[0].textContent,
);
check(
  'a package missing from the release is reported, not linked',
  partial.missingNote.hidden === false && /Chromium/.test(partial.missingNote.textContent),
  partial.missingNote.textContent,
);
check(
  'a missing package keeps the button on the release page',
  partial.buttons.slice(1).every((button) => button.href === '' && !button.dataset.resolved),
  'browser buttons still point at /releases/latest from the markup',
);

const complete = await runWiring({
  tag_name: 'v1.0.6',
  name: 'Quiet v1.0.6',
  published_at: '2026-09-28T00:00:00Z',
  assets: [
    { name: 'Quiet-1.0.6.apk', size: 12345678, browser_download_url: 'https://example.invalid/apk' },
    { name: downloads.browser('chromium', '1.0.6'), size: 3386056, browser_download_url: 'https://example.invalid/chromium' },
    { name: downloads.browser('firefox', '1.0.6'), size: 3386275, browser_download_url: 'https://example.invalid/firefox' },
    { name: downloads.browser('safari', '1.0.6'), size: 3386231, browser_download_url: 'https://example.invalid/safari' },
  ],
});
check(
  'a complete release resolves every button',
  complete.buttons.every((button) => button.dataset.resolved === 'true') && complete.missingNote.hidden === true,
  complete.buttons.map((button) => button.dataset.download).join(', '),
);

// -----------------------------------------------------------------------------------------------
// The claims on the page are the facts in the repository
// -----------------------------------------------------------------------------------------------

const listedDomains = Domains.parseList(
  await readFile(
    path.join(repoRoot, 'modules', 'quiet-vpn', 'android', 'src', 'main', 'assets', 'blocklists', 'adult-core.txt'),
    'utf8',
  ),
).length;
const claimedDomains = Number((html.match(/data-domain-count>([\d,]+)</) || [])[1]?.replace(/,/g, ''));
check(
  'the domain count on the page is the list in the repository',
  claimedDomains === listedDomains,
  `page says ${claimedDomains?.toLocaleString()}, list holds ${listedDomains.toLocaleString()}`,
);

const dohEndpoints = (
  await readFile(
    path.join(repoRoot, 'modules', 'quiet-vpn', 'android', 'src', 'main', 'assets', 'blocklists', 'doh-providers.txt'),
    'utf8',
  )
)
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.startsWith('#')).length;
const claimedDoh = Number((html.match(/~(\d+) DoH\/DoT/) || [])[1]);
check(
  'the encrypted-DNS count is right',
  Number.isFinite(claimedDoh) && Math.abs(claimedDoh - dohEndpoints) <= 5,
  `page says ~${claimedDoh}, list holds ${dohEndpoints}`,
);

check(
  'the page uses the app name from app.json',
  html.includes(identity.name),
  `${identity.name} (from expo.name)`,
);

// -----------------------------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} website check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nAll website checks passed');
}
