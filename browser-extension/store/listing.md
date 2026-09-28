# Store listing copy

Everything the store dashboards ask for, written once. Numbers in brackets are the store's own
limits; `test/store.test.cjs` fails if any of these go over them, so the copy cannot quietly rot out
of range.

Links used throughout:

- Homepage and support: <https://kennethyork.github.io/Quiet/>
- Privacy policy: <https://kennethyork.github.io/Quiet/privacy.html>
- Source and issues: <https://github.com/kennethyork/Quiet>
- Releases (the packages themselves): <https://github.com/kennethyork/Quiet/releases/latest>

---

## Name [Chrome/Edge 45, AMO 50]

```
Quiet - adult content filter
```

## Summary [Chrome/Edge 132, AMO 250]

Chrome, Edge and Opera:

```
Blocks adult domains in this browser, locally. The same lists as the Quiet Android app: no account, no server, no telemetry.
```

AMO (it allows a longer line, and the Firefox audience reads it):

```
Blocks adult domains in this browser using the same lists as the Quiet Android app. The lists ship inside the package, so there is no account, no server, no telemetry and no network calls at runtime.
```

## Detailed description [Chrome 16,000, Edge 10,000]

```
Quiet blocks adult domains in this browser, using the domain lists the Quiet Android app ships. All
of the filtering happens on your device: the lists are inside the package, and the extension makes no
network calls at runtime at all.

What it does

- Blocks adult domains from a bundled list of 156,502 domains, and everything under them: a rule for
  example.com also covers cdn.example.com.
- Blocks the hostnames of about 65 public DNS-over-HTTPS and DNS-over-TLS providers, so a site cannot
  dodge the lists by resolving names somewhere else.
- Checks every request the browser makes, not just the page you are on: frames, scripts, images and
  fetches.
- Lets you allow a site you need, and that allowlist wins over every list.
- Shows what it has stopped today and since you installed it, and the current page's count on the
  toolbar badge.

A PIN, on purpose

Protection refuses to start until you set a 4-8 digit PIN, and the PIN is asked for before anything
that would weaken it: switching protection off, changing lists, editing the allowlist, clearing the
statistics. There is also a commitment lock that refuses to switch protection off until a timer runs
out. That is unusual for an extension, and deliberate: a blocker you can switch off in one absent
click is not much of a blocker. The PIN is stored only as a salted PBKDF2 hash, on your device.

What it cannot do

- It only covers this browser, in this profile. Other browsers and other apps are out of its reach.
- There is no family resolver behind it. The Android app can send allowed lookups to a family-safe
  DNS resolver; a browser extension cannot change your DNS, so the lists are the only line of
  defence here.
- Blocking is by domain name. A site reached by IP address, or served from a domain no list knows
  yet, gets through.
- An extension cannot stop you from disabling it. The PIN is a speed bump for the moment you want to
  stop, not a lock on the browser.

Privacy

No account, no server, no analytics, no telemetry, and no network requests at runtime. The extension
stores your settings, the allowlist, a salted hash of your PIN and daily counters locally. It does
not collect or transmit anything, and it has no way to read page content.

Quiet is free software (GPL-3.0), and the Android app it shares its lists with is in the same
repository: https://github.com/kennethyork/Quiet
```

## Category and language

| Store | Category | Language |
| --- | --- | --- |
| Chrome | Well-being (Productivity if the dashboard does not offer it) | English (United States) |
| Edge | Productivity | English (United States) |
| AMO | Privacy & Security | English (United States) |
| Opera | Lifestyle / Productivity as offered | English (United States) |

## Images

All of them are generated from `store/assets/*.html` by `npm run store:assets`, so a UI change means
regenerating rather than re-drawing. Sizes are the stores' own requirements.

| File | Size | Where it goes |
| --- | --- | --- |
| `store/assets/icon-128x128.png` | 128×128 | Store icon (Chrome, Edge, Opera). Opaque, because Chrome asks for no transparency |
| `store/assets/screenshot-1-browser-1280x800.png` | 1280×800 | First screenshot: blocks in the browser, with the settings page |
| `store/assets/screenshot-2-pin-1280x800.png` | 1280×800 | Second screenshot: the PIN, with the popup |
| `store/assets/screenshot-3-lists-1280x800.png` | 1280×800 | Third screenshot: the lists ship in the package, with the list picker |
| `store/assets/promo-small-440x280.png` | 440×280 | Chrome small promo tile |
| `store/assets/promo-marquee-1400x560.png` | 1400×560 | Chrome marquee (optional, used when featured) |

The two UI captures the screenshots embed (`popup.png`, `options.png`) are copies of what the
smoke test screenshots out of the running extension, so they cannot be older than the last time
someone ran that. The icon comes from the app's own icon asset.

## Chrome: permission justifications

The dashboard asks for a written reason for each permission, and reviewers read it.

- **declarativeNetRequest** — this is the extension's whole purpose: it blocks the domains its
  bundled lists cover. The API is the only way to block a request without reading it, and the rules
  are static files inside the package: no remote rules, no remote code.
- **storage** — keeps the user's settings, the allowlist, the PIN's PBKDF2 hash and the daily
  counters on the device. Nothing is synced anywhere.
- **webNavigation** — counts the top-level loads that were stopped, which is the only signal browsers
  report for a blocked page, and updates the badge. It does not read page content.
- **activeTab** — when the user opens the popup, read the current tab's domain so "Allow this site"
  refers to the page in front of them. Nothing is read before that click.

## Chrome: privacy practices answers

- **Single purpose:** Quiet blocks adult domains in the browser from a fixed list that ships inside
  the package. That is the only thing it does.
- **Data collection:** none. Every category (personal communications, health, financial,
  authentication, location, web history, user activity, website content, personally identifiable
  information) is answered "not collected".
- **Certifications:** no data is sold to third parties; nothing is used or transferred for purposes
  unrelated to the single purpose; nothing is used to determine creditworthiness or for lending.
- **Remote code:** not used. The package contains JavaScript, the rulesets, and nothing else.
- **Privacy policy URL:** <https://kennethyork.github.io/Quiet/privacy.html>

## AMO: notes for the reviewer

```
Quiet is a domain blocker. Everything it does is a static declarativeNetRequest ruleset generated at
build time from the blocklists the project's Android app ships (modules/quiet-vpn/android/src/main/
assets/blocklists/). There is no remote code, no remote ruleset and no network request at runtime:
the extension fetches nothing.

The extension asks for a PIN before it will filter anything, and before anything that weakens it
(switching protection off, changing lists, editing the allowlist, clearing statistics). That is a
deliberate product decision for a blocker that is meant to be hard to switch off in a weak moment; it
is stored only as a salted PBKDF2 hash in storage.local. It is not an authentication feature and it
grants no privileges.

Permissions: declarativeNetRequest (blocking), storage (local settings), webNavigation (count
blocked top-level loads for the badge), activeTab (read the current tab's domain when the user opens
the popup, nothing more).

The source is at https://github.com/kennethyork/Quiet, including the build that produces the package
(browser-extension/scripts/build.mjs) and the tests.
```

## Opera: notes

Opera has no publishing API, so this one is manual. Upload `dist/quiet-chromium-<version>.zip`, reuse
the Chromium copy above, and use the 1280×800 screenshots and the 128×128 icon. Opera's dashboard may
ask for its own screenshot size; the images are regenerated from `store/assets/*.html`, so adding a
size is a change to one file.

## Before you submit

1. `npm test` and `npm run build` in `browser-extension/` — the listing checks run with the tests.
2. Confirm the version in the listing matches `expo.version` (the packages carry it in their
   manifest, and `store/README.md` says where the store sees it).
3. Confirm the privacy policy URL resolves, and that it still describes what the extension does.
4. Answer the store's data-usage form from the section above, not from memory.
