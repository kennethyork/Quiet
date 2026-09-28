# Quiet for browsers

The app blocks adult domains for every app on an Android phone. This is the same idea in front of a
browser: the same blocklists, the same allowlist-wins rule, the same mandatory PIN, one codebase
building for **Chrome, Edge, Brave, Opera, Vivaldi, Firefox and Safari**.

There is no server and no account, and there are no network calls at runtime at all: the lists are
baked into the package as declarative rules, and the browser's own `declarativeNetRequest` engine
does the matching.

## Built targets

```sh
npm run build          # everything below, plus zip/xpi artefacts in dist/
```

| Target | Browsers | Load it |
| --- | --- | --- |
| `dist/chromium` | Chrome, Edge, Brave, Opera, Vivaldi | `chrome://extensions` → Developer mode → Load unpacked |
| `dist/firefox` | Firefox, LibreWolf, Waterfox | `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `dist/firefox/manifest.json`, or `dist/quiet-firefox-<version>.xpi` |
| `dist/safari` | Safari (macOS, iOS) | needs Xcode: `xcrun safari-web-extension-converter dist/safari`, then run the generated project |
| `dist/safari-content-blocker` | Safari, and any content-blocker host | Apple content-blocker JSON, split to fit the 150,000-rule limit |

`dist/*.zip` and `dist/quiet-firefox-<version>.xpi` are what the stores take. The version comes from
`expo.version` in the app's `app.json`, and so does the name, so the two products cannot drift apart
in name or number.

**No store is required to run any of this.** [docs/installing-without-a-store.md](docs/installing-without-a-store.md)
has the three routes - loading it yourself, signing the Firefox build without listing it (free, and
what turns the `.xpi` into a permanent install), and force-installing by policy on a machine you
manage - with what each one costs.

## What it does

- **Blocks by domain.** Every request the browser makes is checked against the lists. The rules use
  `condition.requestDomains`, so a rule for `example.com` covers `cdn.example.com` exactly like the
  app's DNS matcher does.
- **The allowlist wins.** Allowlisted domains become `allow` rules at a *higher priority* than the
  block rules, which is the extension's version of the app consulting the allowlist first.
- **Encrypted-DNS endpoints are blocked too.** The app ships a list of ~65 DoH/DoT hostnames; a site
  cannot dodge the lists by resolving names through `dns.google` in this browser.
- **A PIN is mandatory before anything is filtered.** A fresh install blocks nothing until a PIN
  exists, and switching protection off, changing lists, editing the allowlist or clearing statistics
  all ask for it. The check lives in the background worker, not in the screens.
- **Commitment lock.** Protection refuses to switch off until the timer runs out, whatever the PIN.
- **Statistics and a badge.** The toolbar badge shows what has been stopped on the current page, and
  the popup shows today's and lifetime counts.
- **Lists are chosen in the UI.** The bundled adult list and the DoH list ship in the package, so
  there is nothing to download and nothing to trust at runtime.

## Honest limitations

A blocker that overpromises is worse than no blocker, so:

- **It only covers this browser, in this profile.** Other browsers, other apps and the rest of the
  machine are out of its reach. On a phone, the app is the real thing.
- **There is no family resolver behind it.** The app relays allowed lookups to a family-safe DNS
  resolver, which catches domains no list knows yet. A browser extension cannot change your DNS, so
  here the lists are the only line of defence.
- **The counts are page loads, not every blocked sub-resource.** Browsers only report the load, and
  the permission that would expose individual matches (`declarativeNetRequestFeedback`) is limited to
  development builds, so it is not shipped. In Firefox the reported error string is documented as
  internal and unstable, so those counts are a best effort and the UI says so.
- **A browser extension cannot stop you switching it off.** `chrome://extensions` is one click away
  and belongs to the browser. The PIN is a speed bump for the moment you want to stop, not a lock.
- **Safari packaging needs macOS and Xcode.** The content-blocker export is a static ruleset: no
  allowlist screen, no statistics. The web extension in `dist/safari` is the full thing.
- **Optional lists are a build-time choice.** OISD NSFW (light and aggressive) is only included when
  the build runs with `--fetch-optional`, because the extension is not allowed to fetch lists at
  runtime. When a list is missing from the build, the UI says so instead of pretending.
- **Incognito/private windows** need the extension to be allowed for them; the lists still apply.

## Layout

```
browser-extension/
  src/
    common/domains.js     the DomainRules.kt port: parsing and suffix matching
    common/lists.js       the list catalogue - the single source of truth for build and UI
    common/settings.js    stored state, the PIN (PBKDF2), the browser API shim
    common/ui.js          messaging helpers and the PIN prompt
    background/           service worker (Chromium/Safari) and event page (Firefox)
    popup/                what is happening right now
    options/              lists, allowlist, statistics, PIN and commitment
    ui/base.css           the app's palette
  scripts/
    generate-rulesets.mjs list files -> declarativeNetRequest rulesets (+ Safari blockers)
    build.mjs             one source tree -> manifest per target, validated before it ships
    smoke.mjs             loads the build in a real browser and drives the real code path
    zip.mjs               a stored-zip writer, so the build needs no dependencies
  test/                   Node tests, including the Kotlin test cases ported one for one
```

## Verifying

```sh
npm test          # parser parity with DomainRules.kt, ruleset generation, store material
npm run build     # fails if a ruleset is malformed or a manifest points at a missing file
npm run smoke     # loads the built extension in a real browser and checks the behaviour
```

`npm test` also checks the store submission material: the listing copy against the stores' own
character limits, every listing image against the pixel size its store requires (and for
transparency), the numbers in those images against the blocklists they came from, and the credential
names in the runbook against the ones the publishing script reads.

`node scripts/smoke.mjs --screenshots` also writes `dist/screenshots/popup.png` and
`dist/screenshots/options.png`, captured from the loaded extension, which is the quickest way to see
what a change did to the UI.

`npm run smoke` is the interesting one. It runs the browser **headful on a virtual display**, because
headless Chrome runs extensions' service workers but does not apply their `declarativeNetRequest`
rules, and it first runs a *control* extension - one match-everything rule plus a `webRequest`
listener - against the same URL. If the control cannot block either, the blocking checks are reported
as skipped with that reason instead of blaming this extension; otherwise they assert that an armed
shield stops a listed page and that switching it off brings the page back.

Note that branded Google Chrome 137 and later ignore `--load-extension` outright, so the smoke test
prefers a Chromium or Chrome-for-Testing build (including the ones Playwright and Puppeteer keep in
`~/.cache`) and can be pointed anywhere with `QUIET_CHROME=/path/to/chrome`.

## Publishing to the stores

[browser-extension/store/](store/) holds the submission material: the listing copy for every store
with each store's character limits, the permission justifications and privacy answers, the reviewer
notes, and the images rendered at exactly the sizes the stores demand.

```sh
npm run store:assets              # regenerate the listing images from store/assets/*.html
npm run store:publish -- --dry-run   # print what publishing would do, need no credentials
```

[store/README.md](store/README.md) is the runbook: which account and which credential each store
needs, and what has to be done once by hand. Two of the three stores cannot be created by their own
API - Chrome and Edge need the first listing made in their dashboards - while **Firefox/AMO can be
fully automated, and signing is what makes the `.xpi` a permanent install** instead of a temporary
add-on Firefox forgets on restart.

On a tagged release, CI runs the same script: a store with no credentials is skipped with a note, a
store with them is published, and a signed Firefox package is attached to the release.

## Keeping it in step with the app

- `src/common/domains.js` is a port of
  `modules/quiet-vpn/android/src/main/java/expo/modules/quietvpn/DomainRules.kt`, and
  `test/domains.test.cjs` contains the same assertions as the Kotlin `DomainRulesTest`. Change one,
  change the other.
- The lists are read from `modules/quiet-vpn/android/src/main/assets/blocklists/`, so the app and the
  extension block the same 156,502 domains from one file.
- The name and version come from `app.json` (`expo.name`, `expo.version`).
- Nothing in `src/` may call the network. If a feature needs a list, it is generated at build time.

## Design notes

- **Why classic scripts?** Chrome wants `background.service_worker`, Gecko has no MV3 service worker
  and wants `background.scripts` (an event page), and Safari prefers scripts. One file shape has to
  work in both, so the shared files avoid modules and the worker pulls them in with `importScripts`
  when it is running as a worker.
- **Why a few hundred rules instead of 156,000?** `requestDomains` takes a list of domains per rule,
  so the list is chunked at 1,000 domains per rule (`DOMAIN_CHUNK`). Chrome's budget is measured in
  rules, not domains, and this keeps the package at ~3 MB.
- **Why `allow` at a higher priority?** Same-priority `allow` already beats `block`, but a higher
  priority makes the intent explicit and survives future rule additions.
- **Why no `declarativeNetRequestFeedback`?** Chrome limits it to unpacked development builds.
  Shipping it would mean either a "not for production" warning or a broken stat on stores, so the
  extension counts page-level blocks from `webNavigation` instead and says what that means.
