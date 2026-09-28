# Installing Quiet without a store

Nobody has to use a store to run this extension. There are three routes, and they differ in who has
to do work and how often.

The files are on the release page (the site's buttons point there too), built by CI from a tagged
commit. Every asset carries a SHA-256 digest on that page, which is the thing worth checking if you
install from a file: off-store installs mean trusting the file's source instead of a store's review.

## 1. Load it yourself, no account and no keys

| Browser | How | Does it survive a restart? |
| --- | --- | --- |
| Chrome, Edge, Brave, Opera, Vivaldi | Unzip `quiet-chromium-<version>.zip`, open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, **Load unpacked**, pick the folder | Yes, as long as the folder stays where it is |
| Firefox | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick the `.xpi` | **No.** Firefox forgets unsigned add-ons when it restarts: use route 2 |
| Safari (macOS) | Convert and build with Xcode, then Safari's **Develop → Allow Unsigned Extensions** | Yes, until Safari restarts; the menu item has to be set again each session |
| Safari, without Xcode | Use `dist/safari-content-blocker` (Apple's content-blocker JSON, split at the 150,000-rule limit) with any content-blocker host | Yes |

Two things about the Chromium route, both worth knowing before you hand it to someone:

- Chrome now keeps unpacked extensions tied to developer mode: switching developer mode off disables
  them, and Chrome shows its "Disable developer mode extensions" warning. Nothing is wrong with the
  extension; that is Chrome's rule for unpacked code.
- Unpacked extensions do not update themselves. Replacing the folder is the update.

## 2. Firefox without a listing: sign it, host it yourself

Firefox requires a signature for a permanent install, but signing and publishing are separate things.
Uploading as **unlisted** ("self-distributed") gets the file signed, keeps it off the public listings,
and skips the human review that a listed add-on goes through. Signed, it installs for good and updates
itself from Mozilla's update service.

```sh
export AMO_JWT_ISSUER='user:12345678:12'
export AMO_JWT_SECRET='…'
npm run sign:firefox          # writes dist/quiet-firefox-<version>-signed.xpi
```

The release you can download is signed exactly this way, so the published `.xpi` installs for good.

That is also why it is worth doing even if you never list anything: the API key is free, the whole
route is automated, and it turns "temporary add-on" into "installed".

## 3. Machines you manage: force-install by policy

If the browser is managed (a school, a workplace, your own laptop with policies you set), you can
install without any interaction and keep it updated. Both browsers take a JSON `ExtensionSettings`
policy; Firefox also accepts a `policies.json` in the Firefox install directory.

Firefox, with the signed XPI hosted wherever you like (any HTTPS URL, or a `file:` path):

```json
{
  "policies": {
    "ExtensionSettings": {
      "browser-extension@quiet.app": {
        "installation_mode": "force_installed",
        "install_url": "https://example.com/quiet-firefox-<version>-signed.xpi"
      }
    }
  }
}
```

Chromium, with a self-hosted CRX (or the store URL, if you did go the store route):

```json
{
  "ExtensionSettings": {
    "*": { "installation_mode": "blocked" },
    "abcdefghijklmnopabcdefghijklmnop": {
      "installation_mode": "force_installed",
      "update_url": "https://example.com/updates.xml"
    }
  }
}
```

`force_installed` means the user cannot remove it, which is the point for a blocker and also the
reason to be sure before you set it. Firefox's `normal_installed` installs it but leaves the user in
charge. Chrome cannot install off-store code without a policy like this: it blocks dragging a `.crx`
into a normal profile, so "pack it and drag it in" is not a route that works for other people.

## What skipping the store costs

- **Friction for other people.** Unpacked loading is a handful of steps, and a blocker that takes a
  handful of steps is a blocker most people never finish installing.
- **No listing, so no discovery or reviews.** The store route is about being findable, not about
  being allowed to run.
- **Updates.** An AMO-signed XPI updates itself; a force-installed CRX from your own `update_url`
  updates itself; an unpacked folder and a temporary Firefox add-on do not.
- **Policy.** Some managed browsers block off-store extensions outright. If that is your machine,
  route 3 is the way through it, and it needs the administrator.

## Verifying what you downloaded

```sh
sha256sum quiet-firefox-<version>.xpi        # compare with the digest on the release page
unzip -p quiet-chromium-<version>.zip manifest.json | head -20
```

The manifests and rulesets in those files are the ones this repository builds: `npm test` regenerates
the rulesets and compares them against the app's blocklists, so a package that does not match would
fail the build rather than ship.
