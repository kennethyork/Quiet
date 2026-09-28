/**
 * Domain list parsing and matching for the browser extension.
 *
 * This is a JavaScript port of `DomainRules.kt` from the Android module
 * (`modules/quiet-vpn/android/src/main/java/expo/modules/quietvpn/DomainRules.kt`), and it is
 * deliberately a line-by-line port rather than a re-implementation: the extension must block
 * exactly the domains the app blocks, or the two products drift.
 *
 * Keep it free of browser APIs so it can run in a service worker, an event page, a popup and in
 * Node unit tests. It is a classic script: it attaches the API to `globalThis.QuietDomains` and
 * exports it through `module.exports` when Node loads it.
 *
 * Matching semantics (same as the app): a name is blocked when the name or any of its suffixes is
 * in a list, so a rule for `example.com` also covers `cdn.example.com`. The allowlist is
 * consulted first and wins.
 */
(function (root) {
  'use strict';

  let MAX_LENGTH = 253;

  /** True for IPv4/IPv6 literals, which are never blocked: lists are about names. */
  function isIpLiteral(value) {
    let seenColon = false;
    let digits = 0;
    for (let i = 0; i < value.length; i++) {
      let ch = value[i];
      if (ch === ':') {
        seenColon = true;
      } else if (ch >= '0' && ch <= '9') {
        digits++;
      } else if (ch === '.' || (ch >= 'a' && ch <= 'f')) {
        // hex digit or separator: tentatively fine
      } else {
        return false;
      }
    }
    if (seenColon) return digits > 0; // bare IPv6
    return /^[0-9.]+$/.test(value) && value.split('.').length === 4;
  }

  /** Turns one token of a list file into a domain, or null when it is not one. */
  function normalizeToken(raw) {
    let token = String(raw).trim();
    if (token === '') return null;
    if (token.startsWith('@')) return null; // adblock exception rule: never block
    if (token.startsWith('||')) token = token.slice(2);
    // dnsmasq style: address=/example.com/0.0.0.0
    if (token.startsWith('address=/')) {
      let end = token.indexOf('/', 9);
      if (end > 9) token = token.slice(9, end);
    }
    // A whole URL is accepted too: keep the host part only.
    let scheme = token.indexOf('://');
    if (scheme >= 0) token = token.slice(scheme + 3);
    let cut = token.search(/[\^$/?:]/);
    if (cut >= 0) token = token.slice(0, cut);
    if (token.startsWith('*.')) token = token.slice(2);
    while (token.endsWith('.')) token = token.slice(0, -1);
    token = token.toLowerCase();
    if (token === '' || token.length > MAX_LENGTH) return null;
    if (token.indexOf('.') < 0) return null; // single labels ("localhost") are never blocked
    if (isIpLiteral(token)) return null;
    if (token.startsWith('-') || token.endsWith('-')) return null;
    if (token.indexOf('..') >= 0) return null;
    for (let i = 0; i < token.length; i++) {
      let ch = token[i];
      let ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '.' || ch === '_';
      if (!ok) return null;
    }
    return token;
  }

  /** Splits one line of a hosts/adblock/domain list into the domains it blocks. */
  function parseLine(raw) {
    let line = String(raw).trim();
    if (line === '') return [];
    let first = line[0];
    if (first === '#' || first === '!' || first === '[' || first === ':' || first === '@') return [];
    let comment = line.indexOf('#');
    if (comment > 0) line = line.slice(0, comment).trim();
    if (line === '') return [];

    let tokens = line.split(/[ \t]+/).filter(function (token) {
      return token.length > 0;
    });
    if (tokens.length === 0) return [];
    let candidates = isIpLiteral(tokens[0]) ? tokens.slice(1) : [tokens[0]];
    if (candidates.length === 0) return [];

    let domains = [];
    for (let i = 0; i < candidates.length; i++) {
      let domain = normalizeToken(candidates[i]);
      if (domain) domains.push(domain);
    }
    return domains;
  }

  /** Normalises a plain domain typed by the user. */
  function normalize(raw) {
    let domains = parseLine(String(raw).trim());
    return domains.length > 0 ? domains[0] : null;
  }

  /** Parses a whole list file into a deduplicated, sorted array of domains. */
  function parseList(text) {
    let seen = Object.create(null);
    let domains = [];
    let lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let parsed = parseLine(lines[i]);
      for (let j = 0; j < parsed.length; j++) {
        let domain = parsed[j];
        if (!seen[domain]) {
          seen[domain] = true;
          domains.push(domain);
        }
      }
    }
    return domains;
  }

  /** Every suffix of a host name, longest first: `a.b.example.com` -> a.b.example.com, b.example.com, ... */
  function suffixes(host) {
    let name = String(host).toLowerCase();
    if (name.endsWith('.')) name = name.slice(0, -1);
    let out = [];
    if (name === '') return out;
    let index = 0;
    while (index < name.length) {
      out.push(name.slice(index));
      let dot = name.indexOf('.', index);
      if (dot < 0) break;
      index = dot + 1;
    }
    return out;
  }

  /** True when `host` or any of its suffixes is in `set`. */
  function hits(set, host) {
    if (!set || set.size === 0) return false;
    let names = suffixes(host);
    for (let i = 0; i < names.length; i++) {
      if (set.has(names[i])) return true;
    }
    return false;
  }

  function DomainRules(blocked, allowed) {
    this.blocked = blocked instanceof Set ? blocked : new Set(blocked || []);
    this.allowed = allowed instanceof Set ? allowed : new Set(allowed || []);
  }

  DomainRules.prototype.blockedCount = function () {
    return this.blocked.size;
  };

  DomainRules.prototype.allowedCount = function () {
    return this.allowed.size;
  };

  /** The app's answer to "would this DNS lookup have been blocked?". */
  DomainRules.prototype.isBlocked = function (host) {
    if (!host) return false;
    if (hits(this.allowed, host)) return false;
    return hits(this.blocked, host);
  };

  DomainRules.prototype.isAllowed = function (host) {
    return hits(this.allowed, host);
  };

  DomainRules.fromLists = function (blockedLists, allowed) {
    let blocked = new Set();
    for (let i = 0; i < blockedLists.length; i++) {
      let list = blockedLists[i];
      for (let j = 0; j < list.length; j++) blocked.add(list[j]);
    }
    return new DomainRules(blocked, allowed);
  };

  let QuietDomains = {
    MAX_LENGTH: MAX_LENGTH,
    isIpLiteral: isIpLiteral,
    normalizeToken: normalizeToken,
    parseLine: parseLine,
    normalize: normalize,
    parseList: parseList,
    suffixes: suffixes,
    DomainRules: DomainRules,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = QuietDomains;
  if (root) root.QuietDomains = QuietDomains;
})(typeof globalThis !== 'undefined' ? globalThis : this);
