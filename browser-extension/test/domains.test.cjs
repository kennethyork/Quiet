/**
 * The DomainRulesTest cases from the Android module, run against the JavaScript port.
 *
 * These are deliberately the same assertions as
 * `modules/quiet-vpn/android/src/test/java/expo/modules/quietvpn/DnsEngineTest.kt`
 * (class `DomainRulesTest`): if the port ever drifts from the app, this file fails.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Domains = require('../src/common/domains.js');

function load(lines) {
  const blocked = Domains.parseList(lines.join('\n'));
  return new Domains.DomainRules(blocked, []);
}

test('normalises every list format it claims to support', () => {
  assert.deepEqual(Domains.parseLine('example.com'), ['example.com']);
  assert.deepEqual(Domains.parseLine('0.0.0.0 example.com'), ['example.com']);
  assert.deepEqual(Domains.parseLine('127.0.0.1 example.com # comment'), ['example.com']);
  assert.deepEqual(Domains.parseLine('||example.com^'), ['example.com']);
  assert.deepEqual(Domains.parseLine('*.example.com'), ['example.com']);
  assert.deepEqual(Domains.parseLine('0.0.0.0 a.com b.com'), ['a.com', 'b.com']);
  assert.deepEqual(Domains.parseLine('  EXAMPLE.COM  '), ['example.com']);

  assert.deepEqual(Domains.parseLine('# comment'), []);
  assert.deepEqual(Domains.parseLine(''), []);
  assert.deepEqual(Domains.parseLine('0.0.0.0'), []);
  assert.deepEqual(Domains.parseLine('localhost'), []);
  assert.deepEqual(Domains.parseLine('127.0.0.1'), []);
  assert.deepEqual(Domains.parseLine('@@||example.com^'), []);
  assert.deepEqual(Domains.parseLine('address=/example.com/0.0.0.0'), ['example.com']);
  assert.deepEqual(Domains.parseLine('https://example.com/path?q=1'), ['example.com']);
});

test('blocks a domain and everything under it', () => {
  const rules = load(['0.0.0.0 porn.example', '||tubes.example^']);
  assert.equal(rules.isBlocked('porn.example'), true);
  assert.equal(rules.isBlocked('www.porn.example'), true);
  assert.equal(rules.isBlocked('a.b.c.tubes.example'), true);
  assert.equal(rules.isBlocked('example'), false);
  assert.equal(rules.isBlocked('notporn.example'), false);
  assert.equal(rules.isBlocked('porn.example.evil.net'), false);
});

test('trailing dots and case do not matter', () => {
  const rules = load(['porn.example']);
  assert.equal(rules.isBlocked('WWW.Porn.Example.'), true);
  assert.equal(rules.isBlocked('porn.example.'), true);
});

test('the allowlist wins over the blocklist', () => {
  const blocked = Domains.parseList('porn.example');
  const rules = new Domains.DomainRules(blocked, ['safe.porn.example']);
  assert.equal(rules.isBlocked('porn.example'), true);
  assert.equal(rules.isBlocked('safe.porn.example'), false);
  assert.equal(rules.isBlocked('other.porn.example'), true);
});

test('domains from the user are normalised too', () => {
  assert.equal(Domains.normalize('https://example.com/path'), 'example.com');
  assert.equal(Domains.normalize('EXAMPLE.com.'), 'example.com');
  assert.equal(Domains.normalize('not a domain'), null);
});

test('a downloaded list is rewritten as plain deduplicated domains', () => {
  const source = [
    '# Title: test',
    '0.0.0.0 adult.example',
    '0.0.0.0 adult.example',
    '127.0.0.1 localhost',
    '||tubes.example^',
    'something else',
  ].join('\n');
  assert.deepEqual(Domains.parseList(source), ['adult.example', 'tubes.example']);
});

test('the bundled list parses to plain lower-case domains', () => {
  const domains = Domains.parseList('0.0.0.0 A.Example\n||b.example^\n');
  assert.deepEqual(domains, ['a.example', 'b.example']);
  for (const domain of domains) assert.match(domain, /^[a-z0-9._-]+$/);
});

test('suffixes walk every label boundary', () => {
  assert.deepEqual(Domains.suffixes('a.b.example.com'), ['a.b.example.com', 'b.example.com', 'example.com', 'com']);
  assert.deepEqual(Domains.suffixes('example.com.'), ['example.com', 'com']);
  assert.deepEqual(Domains.suffixes(''), []);
});
