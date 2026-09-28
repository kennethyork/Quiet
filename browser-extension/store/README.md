# Publishing to the browser stores

Everything in here is submission material and instructions. The publishing itself is
[../scripts/publish-store.mjs](../scripts/publish-store.mjs), which needs credentials that only the
repository owner can create - this file is the checklist for those.

```
node scripts/publish-store.mjs --dry-run          # print the plan, touch nothing, need no keys
node scripts/publish-store.mjs --store=firefox    # sign and publish the Firefox build
node scripts/publish-store.mjs --store=chrome --store=edge
node scripts/publish-store.mjs --require          # fail instead of skipping when a key is missing
```

A missing credential is a **skip, not a failure**: the script names the variable it wants and exits
0, so a release can run it without pretending to have published anything. `--require` is for CI once
the secrets are in place.

## What is automated, and what is not

| Store | Upload and publish | The first listing | Notes |
| --- | --- | --- | --- |
| **Firefox (AMO)** | fully automated, including signing | *automatable* — the API can create the add-on | free; signing is what turns the `.xpi` from a temporary add-on into a permanent install |
| **Chrome Web Store** | automated, API v2 | **manual, once**, in the developer dashboard | $5 one-time developer registration; the store API cannot create an item |
| **Microsoft Edge** | automated, API v1.1 | **manual, once**, in Partner Center | the API cannot create a product, and it cannot change listing metadata either |
| **Opera** | none — no publishing API | manual | reuse the Chromium package and the listing copy |

## Credentials

Set these as repository secrets (Settings → Secrets and variables → Actions) and the
`extension` job's release pipeline publishes on every tag; or export them locally to publish by hand.

| Store | Variable | Where it comes from |
| --- | --- | --- |
| Firefox | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` | <https://addons.mozilla.org/developers/addon/api/key/> — free, after signing in |
| Chrome | `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` | Google Cloud OAuth client with scope `https://www.googleapis.com/auth/chromewebstore`, then a refresh token for that client |
| Chrome | `CWS_PUBLISHER_ID`, `CWS_ITEM_ID` | the publisher ID on the developer dashboard's Account page, and the item's 32-letter ID |
| Edge | `EDGE_CLIENT_ID`, `EDGE_API_KEY` | Partner Center → Microsoft Edge → Publish API → Create API credentials |
| Edge | `EDGE_PRODUCT_ID` | the GUID of the add-on in Partner Center |

`test/store.test.cjs` checks that every variable named here is also named in the publishing script,
so this table cannot drift away from the code.

To store them for CI, one command per secret (it prompts, so nothing lands in your shell history):

```sh
gh secret set AMO_JWT_ISSUER --repo kennethyork/Quiet
gh secret set AMO_JWT_SECRET --repo kennethyork/Quiet
gh secret set CWS_CLIENT_ID --repo kennethyork/Quiet
gh secret set CWS_CLIENT_SECRET --repo kennethyork/Quiet
gh secret set CWS_REFRESH_TOKEN --repo kennethyork/Quiet
gh secret set CWS_PUBLISHER_ID --repo kennethyork/Quiet
gh secret set CWS_ITEM_ID --repo kennethyork/Quiet
gh secret set EDGE_CLIENT_ID --repo kennethyork/Quiet
gh secret set EDGE_API_KEY --repo kennethyork/Quiet
gh secret set EDGE_PRODUCT_ID --repo kennethyork/Quiet
```

You do not need all of them to start: Firefox/AMO alone gives you a signed, permanently installable
package, and the other two keep skipping until their accounts exist.

## One-time setup

### Firefox

1. Sign in at <https://addons.mozilla.org>, then open the API keys page above and copy the JWT issuer
   and secret.
2. Export them and publish:

   ```sh
   export AMO_JWT_ISSUER='user:12345678:12'
   export AMO_JWT_SECRET='…'
   node scripts/publish-store.mjs --store=firefox
   ```

   With `--channel=unlisted` (the default) this creates the add-on as self-distributed and writes a
   signed `dist/quiet-firefox-<version>-signed.xpi`: the file Firefox installs for good, instead of
   forgetting it on restart. With `--channel=listed` it becomes a public AMO listing and goes through
   review, and the reviewer notes in [listing.md](listing.md) apply.

### Chrome Web Store

1. Register as a developer (<https://chrome.google.com/webstore/devconsole>, one-time $5).
2. Create the item **by hand**: upload `dist/quiet-chromium-<version>.zip` and fill in the store
   listing from [listing.md](listing.md). The API cannot create an item, only update one.
3. In Google Cloud, create an OAuth client (type: Desktop), enable the Chrome Web Store API, and go
   through the consent flow once with scope `https://www.googleapis.com/auth/chromewebstore` to get a
   refresh token. Google's guide: <https://developer.chrome.com/docs/webstore/using-api>.
4. Note the publisher ID (dashboard → Account) and the item ID (the 32-letter string in the item's
   URL), then:

   ```sh
   export CWS_CLIENT_ID='…' CWS_CLIENT_SECRET='…' CWS_REFRESH_TOKEN='…'
   export CWS_PUBLISHER_ID='…' CWS_ITEM_ID='…'
   node scripts/publish-store.mjs --store=chrome
   ```

   Uploads are refused while a review is running; the script checks the item status first and says so
   rather than failing at the store's end.

### Microsoft Edge

1. In Partner Center → Microsoft Edge, create the product by hand with the same package and listing.
2. Under **Publish API**, create API credentials and copy the client ID and API key.
3. Then:

   ```sh
   export EDGE_CLIENT_ID='…' EDGE_API_KEY='…' EDGE_PRODUCT_ID='…'
   node scripts/publish-store.mjs --store=edge
   ```

### Opera

No API. Upload `dist/quiet-chromium-<version>.zip` at <https://addons.opera.com/developer/> and paste
the Chromium copy from [listing.md](listing.md).

## Files here

```
README.md      this checklist
listing.md     the copy for every store, with each store's character limits
assets/*.html  the templates the listing images are rendered from
assets/*.png   the generated images (committed, so a submission needs no build step)
```

## Regenerating the images

```sh
npm run store:assets      # renders store/assets/*.html at each store's exact size
```

It drives the same headless-browser harness the smoke test uses, so the images are reproducible:
change the HTML, re-run, look at the PNG. `test/store.test.cjs` checks that each image exists, that
its pixel size is the size its store requires, and that the PNG is fully opaque (Chrome rejects
screenshots with transparency in the visible area).

## Kept honest by tests

`test/store.test.cjs` fails if the listing copy breaks a store's limits, if a listed image is
missing or the wrong size, if the manifest's own 132-character description creeps over the limit
Chrome's review checklist enforces, if a packaged build carries files that should not ship (READMEs,
tests), or if the credentials named above and the ones the script reads drift apart.
