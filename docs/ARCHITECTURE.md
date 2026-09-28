# How Quiet works

## Why a VPN service at all

Android gives an app three ways to see what other apps are doing on the network:

1. **A hosts file** — needs root.
2. **A proxy or browser extension** — only covers the app that opts in.
3. **`VpnService`** — the only mechanism a normal app can use to sit in front of *all* traffic.

Quiet uses the third, but deliberately in the narrowest possible way.

## A tunnel that only carries DNS

Most DNS blockers route `0.0.0.0/0` into their tunnel and then have to implement a user-space
TCP/IP stack to put non-DNS traffic back out on the wire: hundreds of kilobytes of code, extra
battery drain, and a large attack surface.

Quiet instead adds routes only for the addresses that DNS actually uses:

- the well-known public resolvers (`8.8.8.8`, `1.1.1.1`, the family variants, Quad9, OpenDNS,
  AdGuard, CleanBrowsing, NextDNS, Control D, and the regional resolvers apps hard-code),
- plus any resolver the user configured,
- plus, optionally, endpoints that exist only to serve DNS-over-HTTPS and DNS-over-TLS.

Everything else keeps using the normal network path. The tunnel therefore carries nothing but UDP
port 53 packets, and the whole data plane is: parse, match, answer or relay.

```
app asks for a name
        │
        ▼
  DNS packet enters the tunnel (route match on the resolver address)
        │
        ├── name is in the allowlist ──────────────► relay to the chosen resolver
        ├── name is in a blocklist ────────────────► answer locally and count it
        ├── answer is in the 60s cache ────────────► answer from cache
        └── anything else ─────────────────────────► relay, cache if positive
```

## Blocking without breaking things

A blocked name is answered one of three ways (Settings → Blocked answers):

| Mode | Answer | Why you would pick it |
| --- | --- | --- |
| Empty answer (default) | `NOERROR`, no records | Best compatibility; apps fail immediately without retry storms |
| Sinkhole | `A 0.0.0.0`, `AAAA ::` | Some apps treat this as a failed connection and show their own error |
| `NXDOMAIN` | Name does not exist | Cleanest semantics, occasionally triggers search-suffix retries |

Malformed or unusual messages (multi-question queries, compression pointers inside the question,
non-`IN` classes) are never guessed at: they are relayed untouched, so exotic-but-legitimate traffic
keeps working.

## Blocking encrypted DNS

Plain DNS filtering is trivially defeated by an app that speaks DoH to its own resolver. Quiet
handles that in two layers:

1. **Routes.** Resolvers that also serve DoH/DoT are already inside the tunnel. A TLS connection to
   `1.1.1.1:443` therefore arrives as a packet the app cannot use, and it is answered with an ICMP
   "destination unreachable, port unreachable". Clients fail immediately instead of waiting for a
   timeout, and fall back to the plain DNS they were sending anyway.
2. **Names.** The bundled `doh-providers` list blocks the hostnames of roughly 65 public
   DoH/DoT services (`dns.google`, `cloudflare-dns.com`, `mozilla.cloudflare-dns.com`,
   `dns.nextdns.io`, `doh.opendns.com`, …). A client that cannot resolve its resolver cannot use it.

What this cannot stop: a user-configured *Private DNS* hostname on a domain we do not route, or a
browser's own DoH endpoint on shared CDN infrastructure. Those are documented rather than pretended
away.

## Matching semantics

Lists are normalised into plain, lower-case, deduplicated domain-per-line files. A query matches
when the name **or any of its suffixes** is in a list, which is what hosts-file users expect: a rule
for `example.com` also covers `cdn.example.com`. The allowlist is consulted first and wins.

Supported input formats: plain domains, hosts files (`0.0.0.0 example.com`, including several hosts
per line), adblock syntax (`||example.com^`), wildcards (`*.example.com`), dnsmasq
(`address=/example.com/0.0.0.0`), and full URLs.

Memory is proportional to the number of loaded domains, roughly 100 bytes each. The bundled list
(156k domains) costs about 18 MB; the opt-in OISD list (466k) costs about 50 MB, which is why it is
a download rather than a default.

## Caching and counters

Positive answers are cached for 60 seconds and re-stamped with the caller's query id. The cache
keeps lookups that do not hit the local lists from paying a network round trip twice.

Counters live in two places on purpose:

- **Native** (`SharedPreferences`) accumulates per-day blocked/allowed totals, so the numbers
  survive a process kill while the service is running.
- **SQLite** keeps the last seven days of individual blocked domain names for the log and the
  "most blocked" list. Rows older than seven days are pruned; only names are stored, never the app
  that asked.

## Process and lifecycle

The service is a foreground service (`specialUse` type — Android 14 has no VPN type) with a
persistent notification. It is `START_STICKY`, survives the UI being swiped away, and is restarted
by a `BOOT_COMPLETED` receiver when the user enabled that behaviour and the VPN permission is still
granted.

The JavaScript side never decides what to block: it writes configuration and lists to disk, and the
native tunnel applies them. That keeps the fast path free of bridge traffic.

## Code map

| File | Responsibility |
| --- | --- |
| `QuietVpnService.kt` | Tunnel lifecycle, packet loop, DNS relay, cache, counters |
| `DnsWire.kt` | Question parsing, synthesised answers, EDNS clamping |
| `IpWire.kt` | IPv4/IPv6/UDP/ICMP parsing and reply construction with checksums |
| `DomainRules.kt` | List parsing, normalisation, suffix matching |
| `NetworkConstants.kt` | Which addresses get routed into the tunnel |
| `ListStore.kt` | Bundled lists, downloads, atomic rewrites |
| `Store.kt` | Settings, daily counters, PIN hash, commitment |
| `QuietVpnModule.kt` | The JavaScript API, PIN enforcement, device owner actions |

## The browser extension

`browser-extension/` is the same lists in front of a browser, and the same shape of decision: the
browser's own `declarativeNetRequest` engine matches, the extension only supplies rules.

| App | Extension |
| --- | --- |
| `DomainRules.kt` suffix matcher, ported to `src/common/domains.js` | `condition.requestDomains`, chunked 1,000 domains per rule |
| Allowlist consulted first, wins | dynamic `allow` rules at a higher priority than the block rules |
| Bundled lists in `assets/blocklists/` | the same files turned into rulesets by `scripts/build.mjs` |
| PIN enforced in Kotlin before anything is weakened | PIN enforced in the background worker, PBKDF2 instead of salted SHA-256 |
| Every app on the phone | Only the browser it is installed in |
| Allowed lookups relayed to a family resolver | No relay is possible: the lists do all the work |
| Per-day counters from the DNS path | Counters from blocked top-level loads, which is what browsers report |

There is no runtime network traffic in the extension at all, and the optional OISD lists are baked in
at build time rather than fetched: a blocker that downloads its own rules is a blocker with a
network dependency it can be talked out of.

The one thing the extension cannot do is see past its own browser, which is why the app remains the
real product and the extension is described as the same lists in one browser. See
[browser-extension/README.md](../browser-extension/README.md).

The landing page in `website/` presents both halves on one page and hands out the APK and the
packages from the latest release; it is checked against this repository by `website/check.mjs`.

## Names and identifiers

The app is called Quiet everywhere a user can see it, and the identifiers match:

| Identifier | Value |
| --- | --- |
| `expo.name` - launcher, notification header, app list | Quiet |
| Package | `dev.quiet.app` |
| Kotlin package | `expo.modules.quietvpn` |
| Module directory | `modules/quiet-vpn` |
| JavaScript module | `QuietVpn` |
| Deep link | `quiet://open` |
| Dialer code | `*#*#78438#*#*` |

The package name is the one that cannot be changed without cost. Android treats a new package as a
different app: the old copy stays installed, the new one starts with no lists, no PIN and no history, and
the device owner component in `docs/UNINSTALL-PROTECTION.md` has to be updated. Everything else is
internal and free to change.
