/**
 * End-to-end smoke test: loads the built extension in a real browser and drives the real code path
 * - the PIN gate, the shield, the rulesets and the blocking - then reports what happened.
 *
 *   npm run build && node scripts/smoke.mjs
 *   node scripts/smoke.mjs --extension=dist/firefox
 *   QUIET_CHROME=/path/to/chrome node scripts/smoke.mjs
 *
 * Two things make this harness more careful than the usual "load it and hope" test:
 *
 * 1. The browser runs headful on a virtual display (Xvfb) rather than in headless mode. Headless
 *    Chrome loads extensions and runs their service workers but does not apply their
 *    declarativeNetRequest rules, so a headless run would happily report that nothing is blocked.
 * 2. Before asserting anything about blocking, a *control* extension - thirty lines, one
 *    match-everything block rule, plus a webRequest listener to prove the request is even visible
 *    to extensions - is run against the same URL in the same browser. If the control cannot block
 *    either, the blocking checks are reported as skipped with the reason, because the browser is
 *    the problem and not this extension.
 *
 * The block test never uses a real domain from the lists: it appends one rule blocking a domain it
 * also maps to 127.0.0.1, so the whole run stays offline.
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const SMOKE_DOMAIN = 'quiet-smoke.local';
const MARKER = 'QUIET-SMOKE-OK';
const PIN = '1234';

let browserLogs = () => '';

const args = process.argv.slice(2);
const extensionArg = args.find((value) => value.startsWith('--extension='));
const distDir = path.join(extensionRoot, 'dist');
const extensionDir = path.resolve(
  extensionRoot,
  extensionArg ? extensionArg.slice('--extension='.length) : 'dist/chromium',
);
const wantScreenshots = args.includes('--screenshots');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Saves a PNG of a page, so the UI can be looked at rather than imagined. */
async function screenshot(cdp, session, url, file, viewport) {
  if (viewport) {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { ...viewport, deviceScaleFactor: 2, mobile: false },
      session,
    );
  }
  await cdp.send('Page.navigate', { url }, session);
  await sleep(1200);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(data, 'base64'));
  if (viewport) await cdp.send('Emulation.clearDeviceMetricsOverride', {}, session);
  return file;
}

function skipRun(reason) {
  console.log(`\nSmoke test skipped: ${reason}`);
  process.exitCode = 0;
}

// -----------------------------------------------------------------------------------------------
// The browser
// -----------------------------------------------------------------------------------------------

/**
 * Finds a browser that will load an unpacked extension.
 *
 * Branded Chrome 137 and later ignore `--load-extension` outright, so Chromium builds (including the
 * ones Playwright and Puppeteer download) come first. A branded Chrome is still accepted as a last
 * resort, and then the run reports itself as skipped rather than failing.
 */
function findChrome() {
  const override = process.env.QUIET_CHROME;
  if (override && existsSync(override)) return override;

  const caches = [
    { root: path.join(os.homedir(), '.cache', 'ms-playwright'), match: /^chromium-\d+$/, layout: ['chrome-linux64/chrome', 'chrome-linux/chrome', 'Chromium.app/Contents/MacOS/Chromium'] },
    { root: path.join(os.homedir(), '.cache', 'puppeteer', 'chrome'), match: /^linux-/, layout: ['chrome-linux64/chrome', 'chrome-linux/chrome'] },
  ];
  for (const cache of caches) {
    if (!existsSync(cache.root)) continue;
    for (const entry of readdirSync(cache.root).sort().reverse()) {
      if (!cache.match.test(entry)) continue;
      for (const layout of cache.layout) {
        const candidate = path.join(cache.root, entry, layout);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  for (const name of ['chromium', 'chromium-browser']) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
  }
  for (const name of ['google-chrome', 'google-chrome-stable']) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
  }
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(macChrome) ? macChrome : null;
}

/** A virtual display, when there is no real one, so the browser can run headful. */
function startDisplay() {
  if (process.env.DISPLAY) return { display: process.env.DISPLAY, stop: () => {} };
  if (spawnSync('which', ['Xvfb'], { encoding: 'utf8' }).status !== 0) return null;

  const display = `:${99 + Math.floor(Math.random() * 50)}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: true,
  });
  return {
    display,
    stop: () => {
      try {
        process.kill(-xvfb.pid, 'SIGKILL');
      } catch (_error) {
        xvfb.kill('SIGKILL');
      }
    },
  };
}

/**
 * Minimal DevTools Protocol client over the browser's own pipes.
 *
 * With `--remote-debugging-pipe` Chrome reads protocol messages from fd 4 and writes its replies to
 * fd 3 - the opposite way round to what the flag name suggests, and why this class exists instead of
 * a two-line fetch against `--remote-debugging-port`.
 */
class Cdp {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.logs = [];
    child.stdio[4].on('data', (chunk) => this.consume(chunk));
    child.stderr.on('data', (chunk) => this.logs.push(String(chunk)));
  }

  consume(chunk) {
    this.buffer += chunk.toString('utf8');
    let index = this.buffer.indexOf('\0');
    while (index >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\0');
      if (raw.trim() === '') continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch (_error) {
        continue;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      }
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.child.stdio[3].write(JSON.stringify(payload) + '\0');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timed out: ${method}`));
        }
      }, 20000);
    });
  }

  async evaluate(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'evaluation failed';
      throw new Error(text);
    }
    return result.result.value;
  }

  async waitForTarget(predicate, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { targetInfos } = await this.send('Target.getTargets');
      const found = targetInfos.find(predicate);
      if (found) return found;
      await sleep(200);
    }
    throw new Error('timed out waiting for a browser target');
  }
}

/** Starts a browser with one unpacked extension, and hands back a usable CDP session. */
async function openBrowser({ chromePath, extensionPath, display, hostResolverRules }) {
  const displayName = typeof display === 'string' ? display : display.display;
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'quiet-smoke-'));
  const child = spawn(
    chromePath,
    [
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--enable-logging=stderr',
      '--remote-debugging-pipe',
      `--user-data-dir=${path.join(workDir, 'profile')}`,
      `--load-extension=${extensionPath}`,
      ...(hostResolverRules ? [`--host-resolver-rules=${hostResolverRules}`] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], env: { ...process.env, DISPLAY: displayName } },
  );

  // Killing the browser closes its pipes; without these handlers Node treats that as an unhandled
  // error and takes the whole test run down with it.
  for (const stream of [child.stdout, child.stderr, child.stdio[3], child.stdio[4]]) {
    stream?.on('error', () => {});
  }

  const cdp = new Cdp(child);
  const result = {
    cdp,
    workDir,
    async close() {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
      await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
    },
    async workerSession(match) {
      const target = await cdp.waitForTarget(
        (info) => info.type === 'service_worker' && info.url.includes(match),
      );
      const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, attached.sessionId);
      return { session: attached.sessionId, extensionId: new URL(target.url).host };
    },
    async pageSession() {
      const target = await cdp.waitForTarget((info) => info.type === 'page');
      const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await cdp.send('Page.enable', {}, attached.sessionId);
      await cdp.send('Runtime.enable', {}, attached.sessionId);
      return attached.sessionId;
    },
  };
  return result;
}

// -----------------------------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------------------------

async function prepareExtension(blockDomain) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'quiet-ext-'));
  const target = path.join(workDir, 'extension');
  await cp(extensionDir, target, { recursive: true });

  // One extra rule, so the test can block a domain that could never be in a shipped list.
  const rulesetPath = path.join(target, 'rulesets', 'adult-core.json');
  const rules = JSON.parse(await readFile(rulesetPath, 'utf8'));
  const maxId = rules.reduce((highest, rule) => Math.max(highest, rule.id), 0);
  rules.push({
    id: maxId + 1,
    priority: 1,
    action: { type: 'block' },
    condition: { requestDomains: [blockDomain] },
  });
  await writeFile(rulesetPath, JSON.stringify(rules));
  return { workDir, target };
}

/**
 * A deliberately tiny extension that blocks everything and reports what its webRequest listener
 * sees. It answers one question: does this browser apply declarativeNetRequest at all?
 */
async function prepareControlExtension() {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'quiet-control-'));
  const target = path.join(workDir, 'extension');
  await mkdir(path.join(target, 'rulesets'), { recursive: true });
  await writeFile(
    path.join(target, 'rulesets', 'rules.json'),
    JSON.stringify([{ id: 1, priority: 1, action: { type: 'block' }, condition: {} }]),
  );
  await writeFile(
    path.join(target, 'sw.js'),
    [
      '// Control worker: record that requests are visible to extensions at all.',
      'try {',
      '  chrome.webRequest.onBeforeRequest.addListener((details) => {',
      '    chrome.storage.local.get({ seen: 0 }).then((bag) => {',
      '      chrome.storage.local.set({ seen: bag.seen + 1 });',
      '    });',
      '  }, { urls: ["<all_urls>"] });',
      '} catch (error) {',
      '  chrome.storage.local.set({ listenerError: String(error) });',
      '}',
    ].join('\n'),
  );
  await writeFile(
    path.join(target, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 3,
        name: 'quiet-dnr-control',
        version: '1.0.0',
        permissions: ['declarativeNetRequest', 'webRequest', 'storage'],
        host_permissions: ['<all_urls>'],
        background: { service_worker: 'sw.js' },
        declarative_net_request: {
          rule_resources: [{ id: 'rules', enabled: true, path: 'rulesets/rules.json' }],
        },
      },
      null,
      2,
    ),
  );
  return { workDir, target };
}

function startServer() {
  return new Promise((resolve) => {
    const hits = [];
    const server = createServer((request, response) => {
      hits.push(request.url);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>smoke</title><p>${MARKER}</p>`);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits }));
  });
}

// -----------------------------------------------------------------------------------------------
// The run
// -----------------------------------------------------------------------------------------------

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    return skipRun('no Chrome or Chromium on this machine (set QUIET_CHROME to point at one)');
  }
  if (!existsSync(extensionDir)) {
    throw new Error(`nothing built at ${extensionDir}; run npm run build first`);
  }

  const display = startDisplay();
  if (!display) {
    return skipRun('no display and no Xvfb (install xvfb, or run this from a desktop session)');
  }

  const hostResolverRules = `MAP ${SMOKE_DOMAIN} 127.0.0.1`;
  const { server, port, hits } = await startServer();
  const smokeUrl = `http://${SMOKE_DOMAIN}:${port}/`;
  const checks = [];
  const note = (message) => console.log(`  ·  ${message}`);
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    const label = ok === 'skip' ? 'skip' : ok ? 'ok  ' : 'FAIL';
    console.log(`  ${label} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const fixtures = [];
  let browser = null;

  try {
    // ---- Is this browser even able to apply declarativeNetRequest rules? ----------------------
    const control = await prepareControlExtension();
    fixtures.push(control.workDir);
    let dnrApplies = false;
    let controlNote = '';
    {
      note('checking whether this browser applies declarativeNetRequest rules (control extension)');
      const run = await openBrowser({ chromePath, extensionPath: control.target, display: display.display, hostResolverRules });
      browser = run;
      const worker = await run.workerSession('sw.js');
      const page = await run.pageSession();
      await run.cdp.send('Page.navigate', { url: smokeUrl }, page);
      await sleep(1800);
      const text = String(await run.cdp.evaluate(page, 'document.documentElement.innerText'));
      const seen = await run.cdp.evaluate(
        worker.session,
        'chrome.storage.local.get({ seen: 0 }).then((bag) => bag.seen)',
      );
      dnrApplies = !text.includes(MARKER);
      controlNote = dnrApplies
        ? 'a match-everything control extension blocked the page'
        : `a control extension with a match-everything rule did not block the page (its webRequest listener saw ${seen} request(s), so requests are visible but the rule was not applied)`;
      await run.close();
      browser = null;
    }

    // ---- The extension itself -----------------------------------------------------------------
    note('loading the built extension');
    const fixture = await prepareExtension(SMOKE_DOMAIN);
    fixtures.push(fixture.workDir);
    const run = await openBrowser({ chromePath, extensionPath: fixture.target, display: display.display, hostResolverRules });
    browser = run;
    browserLogs = () => run.cdp.logs.join('');

    const worker = await run.workerSession('background/background.js');
    const page = await run.pageSession();
    const optionsUrl = `chrome-extension://${worker.extensionId}/options/options.html`;

    record('the built package loads in the browser', true, `extension ${worker.extensionId.slice(0, 8)}…`);

    const openOptions = async () => {
      await run.cdp.send('Page.navigate', { url: optionsUrl }, page);
      await run.cdp.waitForTarget(
        (info) => info.type === 'page' && info.url === optionsUrl,
        10000,
      );
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const ready = await run.cdp
          .evaluate(page, 'typeof window.QuietUi === "object"')
          .catch(() => false);
        if (ready) return;
        await sleep(150);
      }
      throw new Error('the options page never finished loading');
    };

    await openOptions();
    const fresh = JSON.parse(
      await run.cdp.evaluate(
        page,
        'window.QuietUi.request({ type: "quiet:status" }).then((s) => JSON.stringify({ enabled: s.enabled, hasPin: s.hasPin }))',
      ),
    );
    record(
      'a fresh install filters nothing and has no PIN',
      fresh.enabled === false && fresh.hasPin === false,
      `enabled: ${fresh.enabled}, PIN: ${fresh.hasPin}`,
    );

    const withoutPin = JSON.parse(
      await run.cdp.evaluate(
        page,
        `window.QuietUi.request({ type: 'quiet:shield.on', pin: '${PIN}' })
          .then(() => JSON.stringify({ ok: true }))
          .catch((error) => JSON.stringify({ ok: false, code: error.code }))`,
      ),
    );
    record('the shield refuses to arm without a PIN', withoutPin.ok === false && withoutPin.code === 'pin-required', withoutPin.code);

    const armed = JSON.parse(
      await run.cdp.evaluate(
        page,
        `(async () => {
          await window.QuietUi.request({ type: 'quiet:pin.create', pin: '${PIN}' });
          const state = await window.QuietUi.request({ type: 'quiet:shield.on', pin: '${PIN}' });
          return JSON.stringify({ enabled: state.enabled, hasPin: state.hasPin });
        })()`,
      ),
    );
    record('the options page can set a PIN and arm the shield', armed.enabled === true, JSON.stringify(armed));

    const listedArmed = JSON.parse(
      await run.cdp.evaluate(
        worker.session,
        'chrome.declarativeNetRequest.getEnabledRulesets().then((ids) => JSON.stringify(ids))',
      ),
    );
    record(
      'arming enables the list rulesets',
      listedArmed.includes('adult-core') && listedArmed.includes('doh-providers'),
      `enabled: ${listedArmed.join(', ')}`,
    );

    const wrongPin = JSON.parse(
      await run.cdp.evaluate(
        page,
        `window.QuietUi.request({ type: 'quiet:shield.off', pin: '9999' })
          .then(() => JSON.stringify({ ok: true }))
          .catch((error) => JSON.stringify({ ok: false, code: error.code }))`,
      ),
    );
    record('a wrong PIN cannot switch protection off', wrongPin.ok === false && wrongPin.code === 'pin-invalid', wrongPin.code);

    // ---- Blocking (only meaningful when this browser applies DNR rules) -----------------------
    if (!dnrApplies) {
      record('a listed domain does not load while the shield is on', 'skip', controlNote);
      record('switching the shield off puts the page back', 'skip', 'not verifiable in this browser');
    } else {
      hits.length = 0;
      await run.cdp.send('Page.navigate', { url: smokeUrl }, page);
      await sleep(1800);
      const blockedText = String(await run.cdp.evaluate(page, 'document.documentElement.innerText'));
      record(
        'a listed domain does not load while the shield is on',
        !blockedText.includes(MARKER) && hits.length === 0,
        `server hits: ${hits.length}, page text: ${JSON.stringify(blockedText.slice(0, 40))}`,
      );

      await openOptions();
      await run.cdp.evaluate(
        page,
        `window.QuietUi.request({ type: 'quiet:shield.off', pin: '${PIN}' }).then(() => true)`,
      );
      hits.length = 0;
      await run.cdp.send('Page.navigate', { url: smokeUrl }, page);
      await sleep(1800);
      const allowedText = String(await run.cdp.evaluate(page, 'document.documentElement.innerText'));
      record(
        'switching the shield off puts the page back',
        allowedText.includes(MARKER) && hits.length === 1,
        `server hits: ${hits.length}`,
      );
    }

    if (wantScreenshots) {
      const shots = [];
      shots.push(await screenshot(run.cdp, page, optionsUrl, path.join(distDir, 'screenshots', 'options.png')));
      shots.push(
        await screenshot(
          run.cdp,
          page,
          `chrome-extension://${worker.extensionId}/popup/popup.html`,
          path.join(distDir, 'screenshots', 'popup.png'),
          { width: 360, height: 640 },
        ),
      );
      record('screenshots captured', true, shots.map((file) => path.relative(extensionRoot, file)).join(', '));
    }

    const noisy = run.cdp.logs
      .join('')
      .split('\n')
      .filter((line) => /ruleset|manifest|invalid rule|extension error/i.test(line) && !/DevTools/i.test(line));
    record('no ruleset or manifest complaints in the browser log', noisy.length === 0, noisy.slice(0, 2).join(' | '));

    await run.close();
    browser = null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    display.stop();
    server.close();
    for (const dir of fixtures) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
    }
  }

  const failed = checks.filter((check) => check.ok === false);
  const skipped = checks.filter((check) => check.ok === 'skip');
  console.log(
    `\n${checks.length - failed.length - skipped.length}/${checks.length} smoke checks passed` +
      (skipped.length > 0 ? `, ${skipped.length} skipped` : ''),
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  if (/refuses --load-extension|--load-extension is not allowed/.test(error.message + browserLogs())) {
    skipRun('this browser is branded Google Chrome 137+, which ignores --load-extension; use a Chromium or Chrome for Testing build, or set QUIET_CHROME');
    return;
  }
  console.error(`\nSmoke test failed: ${error.message}`);
  const log = browserLogs().split('\n').filter(Boolean).slice(-25);
  if (log.length > 0) console.error('Last browser log lines:\n' + log.map((line) => '  ' + line).join('\n'));
  process.exitCode = 1;
});
