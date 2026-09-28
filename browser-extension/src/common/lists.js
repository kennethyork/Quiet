/**
 * The lists the extension can block with.
 *
 * This file is the single source of truth: the build script reads it to know which rulesets to
 * generate, and the popup and options pages read it to render the list picker. Adding a list here
 * is all it takes for it to appear in both.
 *
 * `bundled: true` means the domains are shipped inside the package as a static ruleset, so
 * blocking never needs the network. Optional lists are generated at build time only when the build
 * is run with `--fetch-optional`; when they are missing the UI says so instead of pretending.
 *
 * The ids and the wording mirror `src/lib/lists.ts` in the app so the two stay recognisable.
 */
(function (root) {
  'use strict';

  let QUIET_LISTS = [
    {
      id: 'adult-core',
      title: 'Adult domains',
      description:
        'The list that ships with the app: 156,000 domains of adult material, mirrors and ' +
        'landing pages. Always on, because a blocker you have to configure first blocks nothing.',
      bundled: true,
      default: true,
      locked: true,
    },
    {
      id: 'doh-providers',
      title: 'Encrypted-DNS bypass',
      description:
        'Blocks the hostnames of about 65 public DNS-over-HTTPS and DNS-over-TLS services, so a ' +
        'site cannot dodge the lists by resolving names somewhere else.',
      bundled: true,
      default: true,
      locked: false,
    },
    {
      id: 'oisd-nsfw-small',
      title: 'OISD NSFW (light)',
      description: 'A trimmed build of the OISD adult list. Good balance of size and coverage.',
      source: 'https://nsfw-small.oisd.nl/domainswild',
      bundled: false,
      default: false,
      optional: true,
    },
    {
      id: 'oisd-nsfw',
      title: 'OISD NSFW (aggressive)',
      description: 'Over 460,000 domains, including many mirrors and obscure sites.',
      source: 'https://nsfw.oisd.nl/domainswild',
      bundled: false,
      default: false,
      optional: true,
      heavy: true,
    },
  ];

  function listById(id) {
    for (let i = 0; i < QUIET_LISTS.length; i++) {
      if (QUIET_LISTS[i].id === id) return QUIET_LISTS[i];
    }
    return null;
  }

  let api = { QUIET_LISTS: QUIET_LISTS, listById: listById };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.QUIET_LISTS = QUIET_LISTS;
    root.quietListById = listById;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
