# quiet site

The landing page for both halves of the product: the Android app and the browser extensions. Plain
HTML, one stylesheet, two small scripts — no framework, no build step, no dependencies, and no
third-party requests.

It is published to GitHub Pages by [.github/workflows/website.yml](../.github/workflows/website.yml)
on every push to `main`:

**https://kennethyork.github.io/Quiet/**

(Pages has to exist first, because creating it needs repository admin: once, either in Settings →
Pages → Source: *GitHub Actions*, or with
`gh api -X POST repos/kennethyork/Quiet/pages -f build_type=workflow`. It is enabled for this
repository now.)

## Looking at it

```sh
cd website
python3 -m http.server 8899
# http://localhost:8899
```

## How the downloads work

The site does not store binaries. The APK and the browser packages are built by CI and attached to a
GitHub release, and the page links to those files, which keeps one copy of each artefact and one
place to update it:

- Every download button already points at
  `https://github.com/kennethyork/Quiet/releases/latest`, so the page works with JavaScript disabled.
- [app.js](app.js) then asks GitHub's API for the latest release, turns those links into direct
  links with the exact asset names, and reports the version. It is the page's only network request,
  and the privacy section of the page says so.
- If a release is missing a package (say the extension was added after the last tag), the button keeps
  pointing at the release page and the page says which packages are still to come, rather than
  linking to a file that is not there.

Asset names live in [downloads.js](downloads.js) and must match what the builds produce. That is not
a convention, it is enforced — see below.

## The checks

```sh
node website/check.mjs
```

A hand-written page rots quietly, so the site is checked against the repository it describes:

| Check | Why |
| --- | --- |
| Every local reference exists | A renamed icon or script is a broken page |
| Every external link is HTTPS | No plaintext links out |
| No trackers, CDNs or webfonts | The page makes no third-party requests, and should not start |
| The one runtime request is disclosed | If it fetches the release list, the page must say so |
| Download names match the builds | `downloads.js` is compared against `browser-extension/scripts/build.mjs` and the APK step in `.github/workflows/ci.yml` |
| No versioned file name is hardcoded | Versions come from the release API, not from someone's memory |
| The domain count is the list in the repository | The headline number is parsed out of `adult-core.txt` |
| The encrypted-DNS count is right | Same, for `doh-providers.txt` |
| The page uses `expo.name` | Renaming the app renames the site, and the check notices if it does not |

It runs in CI on every pull request, and again before the site is published.

## Contents

```
index.html     the page
style.css      the app's palette, one file
app.js         fills the download buttons in from the latest release
downloads.js   the asset names, shared with the checks
check.mjs      the checks above (no dependencies)
assets/        icon.png (from the app's icon), popup.png (a real capture of the extension)
```

`assets/popup.png` is a capture of the shipped extension's popup. To refresh it:

```sh
cd browser-extension
npm run build
node scripts/smoke.mjs --screenshots
cp dist/screenshots/popup.png ../website/assets/popup.png
```

## What the page promises

The same thing the app does: it says what the software can do, what it cannot, and where the data
goes. If a claim on this page cannot be checked, it should not be on the page — and `check.mjs` is
the place to add the check that keeps it that way.
