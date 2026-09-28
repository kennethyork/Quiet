# Quiet

An Android-only, open-source porn blocker built with Expo: **https://github.com/kennethyork/Quiet**

It filters DNS on the device, keeps working offline, has no account, no server and no telemetry, and
does not care which app is asking.

```
Shield  →  blocklists + allowlist  →  every DNS lookup on the phone  →  blocked or relayed
```

## What it actually does

Quiet runs a local `VpnService` that captures **only DNS**. Android routes the addresses of
public resolvers into the tunnel, so lookups are intercepted no matter which app asks for them or
whether the app hard-codes `8.8.8.8`. Each query is matched against your blocklists, blocked names
are answered locally, and everything else is relayed to a family-safe resolver you choose.

Because no general traffic enters the tunnel, there is no userspace TCP/IP stack, no throughput
cost and negligible battery impact. Requests to known DNS-over-HTTPS and DNS-over-TLS endpoints
are answered with an ICMP "port unreachable", which makes apps fail fast and fall back to the plain
DNS that *is* filtered.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the details.

## Honest limitations

A blocker that overpromises is worse than no blocker, so:

- **Blocking is by domain name.** A site reached by IP address, or served from a domain no list
  knows yet, gets through. The upstream family resolver is the second line of defence.
- **Android cannot put a password on the uninstall button.** The uninstall dialog belongs to the OS;
  no app can intercept it. Quiet's PIN protects everything *inside* the app, and real uninstall
  protection is available through Android's **device owner** mode, which has to be granted once over
  USB. See [docs/UNINSTALL-PROTECTION.md](docs/UNINSTALL-PROTECTION.md).
- **A custom encrypted-DNS setting bypasses filtering.** If you keep Android's *Private DNS* pointed
  at a hostname, or a browser's own DoH resolver, lookups can go somewhere Quiet cannot see.
  Set *Private DNS* to Off/Automatic and turn off "Use secure DNS" in Chrome and Firefox.
- **Never enable "Block connections without VPN".** Quiet is a DNS filter, not a full tunnel;
  lockdown mode would route all traffic into a tunnel that only understands DNS and take you offline.
- **Hiding the app is not uninstall protection.** It takes the icon away; Android still lists
  Quiet under *Settings → Apps*, where it can be removed like anything else. It is a way to stop
  reminding yourself, not a lock.
- **It is not parental-control software.** Per-app rules, device profiles, remote management and
  tamper-proof installation are out of scope.

## Features

- DNS filtering for every app on the device, from a bundled 156,000-domain adult list
- Additional lists one tap away (OISD NSFW, and any hosts file or domain list by URL)
- Allowlist for domains a list is too aggressive about
- Five resolver presets, all of them family filters, so upstream filtering backs up the lists
- Optional blocking of encrypted-DNS bypass, with a bundled list of ~65 DoH/DoT endpoints
- Choose how blocked names answer: empty answer, `0.0.0.0`, or `NXDOMAIN`
- PIN (4-8 digits) mandatory from the first screen: the tunnel will not start without one, and the
  PIN is required to switch protection off, change lists, edit the allowlist, clear stats, or turn
  off uninstall protection
- Commitment lock: protection refuses to be switched off until a timer you set runs out
- Stats: per-day chart, top blocked domains, session and lifetime counters
- Restarts itself after a reboot when the VPN permission is still granted
- Hide the app from your launcher once setup is done, so the icon stops reminding you it exists
- Optional device-owner mode: uninstall lock plus always-on VPN
- No analytics, no accounts, no network calls other than DNS and list downloads

## Screenshots

Build and run it — the UI is a dark, four-tab app: **Shield**, **Lists**, **Stats**, **Settings**.

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | 20.19+ (or 22.13+, 24.3+) |
| JDK | 17 or 21 |
| Android SDK | platform 36, build-tools 36 |
| Android device or emulator | Android 7.0 (API 24) or newer |

## Build and install

This app contains native code (a Kotlin Expo module), so **Expo Go cannot run it**.

```sh
npm install

# Build the debug APK and install it on the connected device, in one step
npx expo run:android
```

Or produce an APK without a device attached:

```sh
npx expo prebuild -p android
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Release builds

Debug builds are signed with Android's debug key: fine for testing, useless for anything you want to
keep, because an app signed with the debug key can never be updated by a properly signed build. The
repository therefore ships a config plugin, [plugins/withReleaseSigning.js](plugins/withReleaseSigning.js),
which signs release builds with a real key whenever one is configured.

```sh
# One-time. Keep the keystore out of version control, and back it up: losing it means you can
# never update an installed copy again.
keytool -genkeypair -v -storetype PKCS12 -keystore credentials/quiet-release.jks \
  -alias quiet -keyalg RSA -keysize 2048 -validity 10000
cp credentials/keystore.properties.example credentials/keystore.properties   # then fill it in

npm run android:release
# -> android/app/build/outputs/apk/release/app-release.apk
```

With no `credentials/keystore.properties` present the generated project is left exactly as Expo
produced it, so a fresh clone still builds a release APK (signed with the debug key). `credentials/`
is gitignored; only the `.example` template is committed.

The `android:release` script builds `arm64-v8a` and `armeabi-v7a`, which covers every real phone and
keeps the download small. Drop the `-PreactNativeArchitectures` flag to include `x86`/`x86_64` for
emulators.

### Builds from CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) has two jobs. `verify` runs the type check, the
JS bundle, a prebuild and the unit tests on every push and pull request. `apk` builds the release
APK and attaches it to the run, so a testable build needs nothing but a push: open the run under
**Actions** and download it from **Artifacts**.

It signs with the debug key unless you add two repository secrets, which is enough for testing and
nothing more:

| Secret | Contents |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 credentials/quiet-release.jks` |
| `ANDROID_KEYSTORE_PROPERTIES` | the four lines of `credentials/keystore.properties`, with `storeFile=credentials/quiet-release.jks` |

With those in place the job signs with your real key, and the APK it produces can update an installed
copy. Note that an app signed with the debug key can never be updated by one signed with the release
key; uninstall and reinstall when you switch.

The `android/` directory is generated by `expo prebuild` and is not checked in. Everything specific
to this app lives in `modules/quiet-vpn/`.

## The same lists in a browser

The repository also builds a browser extension from the same blocklists, for the times when you are
not on the phone: Chrome, Edge, Brave, Opera, Vivaldi, Firefox and Safari, from one source tree in
[browser-extension/](browser-extension/).

It blocks the same 156,502 domains, keeps the same mandatory PIN and commitment lock, and never
makes a network call at runtime - the lists are built into the package as declarative rules.

```sh
cd browser-extension
npm test        # parser parity with DomainRules.kt, ruleset generation
npm run build   # dist/chromium, dist/firefox, dist/safari, dist/safari-content-blocker
npm run smoke   # loads the build in a real browser and drives the real code path
```

There is a landing page for both halves of the product in [website/](website/), published at
<https://kennethyork.github.io/Quiet/>: one page, no build step, and it hands out the APK and the
browser packages from the latest release.

The submission material for the browser stores lives in
[browser-extension/store/](browser-extension/store/): the listing copy with each store's limits, the
permission justifications, the reviewer notes, and images rendered at exactly the sizes the stores
require. `npm run store:publish` uploads and signs; CI runs it on each tagged release for whichever
stores have credentials configured, and skips the rest with a note.

What it cannot do is as important as what it can: it only covers that browser, and there is no family
resolver behind it, so the lists are the only line of defence there. The full list of limits is in
[browser-extension/README.md](browser-extension/README.md).

## First run

The app opens on a three-step setup and does not let you past it without a PIN. That is not a
nag screen: native code refuses to create the tunnel while no PIN is set, so "no PIN" and "no
protection" are the same state by construction.

1. **Choose a PIN** (4-8 digits, entered twice). It cannot be recovered, and clearing the app data
   is the only reset.
2. **Grant the VPN permission.** Android shows its one-time consent dialog.
3. **Finish.** The bundled adult list is already installed and filtering starts immediately.

Two consequences worth knowing:

- Removing the PIN stops protection and releases the uninstall lock. The setup screen comes back
  until a new PIN exists.
- Reaching the end of setup does not require starting protection: choosing *Not now* leaves the PIN
  in place and the app usable, with the shield ready when you want it.

Setup changes nothing else: after the last step the app behaves like any other app, with its icon in
your launcher.

### The name it shows

The app is called **Quiet**: the launcher, the notification header, Android's VPN entry, its row under
*Settings → Apps*, and every string inside it.

The name comes from one place, `expo.name` in `app.json`, and nothing hardcodes it: the UI reads it
through `Application.applicationName`, native code through `loadLabel`, down to the user agent sent when
fetching blocklists. Renaming the app again is a one-line change plus `npm run android:release`.

The package name, `dev.quiet.app`, is the one identifier a rename cannot reach cheaply: Android treats a
new package as a different app, so changing it means a fresh install and an update to the device owner
command in `docs/UNINSTALL-PROTECTION.md`. It only shows up under *Settings → Apps → App info → Advanced*.

### Hiding the icon

Hiding is opt-in, under **Settings → Visibility**. When it is on, Quiet has no launcher icon: not on
your home screen, not in the app drawer, and no reminder every time you swipe past. Turn it off from
that same screen, or from any of the ways back in below.

It works by moving the launcher entry onto an `<activity-alias>`
([plugins/withLauncherAlias.js](plugins/withLauncherAlias.js)) and disabling that alias. The app's real
activity is never disabled, and that detail is the whole reason this is safe: an app whose *launcher
activity* is switched off cannot be started by anything at all - not by its own notification, not by a
deep link, not even by adb. The first version of this feature did that and locked people out of their
own app, which is also why the alias exists rather than a plain "disable the icon" toggle.

Hiding is only allowed while **notifications are enabled** for Quiet, because the ongoing
notification is how most people get back. With notifications off, hiding would be a trap, so it is
refused with an explanation instead.

### Getting back in when the app is hidden

| Way in | When it works |
| --- | --- |
| Tap the ongoing **Protection** notification | Whenever filtering is running, which is the normal case. |
| Open `quiet://open` (any browser, bookmark, or QR code) | Always. |
| **Recents** - swipe up and pick Quiet | Whenever it is still in the recent-tasks list. |
| Dial `*#*#78438#*#*` | On dialers that still dispatch secret codes; device dependent. Also brings the icon back. |
| `adb shell am start -n dev.quiet.app/.MainActivity` | From a computer with adb and USB debugging. |
| *Settings → Apps → Quiet → Uninstall* | Always. Reinstalling loses your lists and statistics. |

Inside the app, **Settings → Visibility** switches hiding off again, as does the secret code.

If the vault ever fails to open the app, it shows a plain screen with a retry button rather than
disappearing silently, because a silent failure there means being locked out of your own app.

Optionally set up uninstall protection (**Settings → Uninstall protection**) and a commitment lock
(**Settings → PIN & commitment**).

## Development

```sh
npm run typecheck                                      # TypeScript
cd android && ./gradlew :quiet-vpn:testDebugUnitTest    # Kotlin unit tests (19 tests)
cd browser-extension && npm test && npm run build       # extension tests and packages
node website/check.mjs                                 # the site still matches the repository
```

The DNS wire format, the matcher and the list parser are pure Kotlin with no Android imports, so
they are covered by JVM unit tests: `modules/quiet-vpn/android/src/test/`. The browser extension
carries a line-for-line port of the matcher and runs the same test cases against it, so the two
cannot disagree about what is blocked.

## Project layout

```
app/                              screens (expo-router)
  (tabs)/index.tsx                shield, today's counters, recent blocks
  (tabs)/lists.tsx                blocklists, custom lists, allowlist
  (tabs)/stats.tsx                history and top domains
  (tabs)/settings.tsx             resolver, blocking mode, network, behaviour
  settings/security.tsx           PIN and commitment lock
  settings/uninstall.tsx          device owner setup, uninstall lock
src/                              app logic: state, PIN, SQLite history, theme
modules/quiet-vpn/           the local Expo module (Kotlin)
  android/src/main/java/...       VpnService, DNS/IP wire format, matcher, store
  android/src/main/assets/        bundled blocklists (shared with the extension)
  android/src/test/               JVM unit tests
browser-extension/                the same lists in front of a browser, for every browser
website/                          the landing page, which hands out the APK and the packages
docs/                             architecture and uninstall-protection notes
```

## Privacy

Everything happens on the device.

- **Leaves the device:** the DNS queries themselves, relayed to the resolver you picked, and
  blocklist downloads from URLs you added. Nothing else, ever.
- **Stored on the device:** your settings, the list files, a rolling seven-day log of blocked
  domain names, daily counters, and the SHA-256 of your PIN (the PIN itself is never stored).
- **Not collected:** which app made a request, page contents, identifiers, crash reports, analytics.

The browser extension keeps the same rule with less to say: it stores your settings, the allowlist,
the PIN's PBKDF2 hash and daily counters locally, makes no network requests at runtime, and has no
analytics of any kind.

Clearing the app's data resets all of it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Setup will not let me continue | A PIN is required; there is no way past that screen, by design. |
| The app vanished from my launcher | That is the hiding feature. Open it from the ongoing notification, `quiet://open`, Recents, or `*#*#78438#*#*`. |
| I hid the app and cannot get back in | `adb shell am start -n dev.quiet.app/.MainActivity`, or `quiet://open`, or uninstall and reinstall. Settings → Apps always lists it. |
| Protection stops after a while | Exclude Quiet from battery optimisation. |
| A site still loads | Add it to a custom list; check Private DNS is Off/Automatic and browser DoH is disabled. |
| Some app broke | Add its domain to the allowlist, or switch the resolver preset. |
| Nothing loads at all | Turn off "Block connections without VPN" in the system VPN settings. |
| DNS feels slow | Your upstream resolver is slow; pick a closer preset in Settings. |

## Contributing

```sh
git clone https://github.com/kennethyork/Quiet.git
cd Quiet
npm install
npx expo run:android
```

Issues and pull requests are welcome at <https://github.com/kennethyork/Quiet>. Please keep the
promises honest: if a change makes the app claim protection it cannot deliver, it will not be
merged.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
