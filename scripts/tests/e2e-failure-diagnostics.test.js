#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createFailureDiagnostics } = require('../e2e-failure-diagnostics');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Execute the actual module with only filesystem and network boundaries mocked.
// No server, browser, or artifact containing the synthetic secrets is needed.
function fixture({ baseUrl = 'https://example.test', probeFailure = false, synchronousFailure = false } = {}) {
  const writes = new Map();
  const networkURLs = [];
  const vm = require('vm');
  const module = { exports: {} };
  const network = { get(url, options, callback) {
    networkURLs.push(url);
    if (synchronousFailure) throw sensitiveError();
    const request = new EventEmitter();
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => {
      if (probeFailure) request.emit('error', sensitiveError());
      else callback({ statusCode: 200, resume() {} });
    });
    return request;
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../e2e-failure-diagnostics.js'), 'utf8'), {
    module, URL, require: name => {
      if (name === 'fs') return { mkdirSync() {}, writeFileSync: (file, data) => writes.set(path.basename(file), data) };
      if (name === 'http' || name === 'https') return network;
      return require(name);
    },
  });
  const page = new EventEmitter();
  const diagnostics = module.exports.createFailureDiagnostics({
    page, context: new EventEmitter(), browser: new EventEmitter(),
    baseUrl, outputDir: '/mock-artifacts',
  });
  return { page, writes, networkURLs, async capture(error = new Error('navigation failed')) {
    await diagnostics.capture({ test: 'navigation regression', error });
    assert.strictEqual(writes.size, 2, 'capture must await both artifact writes');
    return JSON.parse(writes.get('e2e-navigation-diagnostics.json'));
  } };
}

const secrets = ['query-token-sentinel', 'private-fragment-sentinel', 'userinfo-sentinel', 'password-sentinel', 'nonURL-secret-sentinel'];
const privateURL = 'https://userinfo-sentinel:password-sentinel@example.test/navigation?token=query-token-sentinel#private-fragment-sentinel';
function sensitiveError() {
  const error = new Error(`goto ${privateURL}; nonURL-secret-sentinel`);
  error.name = 'TimeoutError';
  error.code = 'nonURL-secret-sentinel';
  return error;
}
function assertPrivate(writes) {
  for (const [file, text] of writes) {
    for (const secret of secrets) assert(!text.includes(secret), `${file} leaked ${secret}`);
  }
}

test('base URL persists only origin and pathname', async () => {
  const f = fixture({ baseUrl: privateURL });
  const evidence = await f.capture();
  assertPrivate(f.writes);
  assert.strictEqual(evidence.baseUrl, 'https://example.test/navigation');
});
test('page errors omit arbitrary messages and retain bounded type', async () => {
  const f = fixture();
  f.page.emit('pageerror', sensitiveError());
  const evidence = await f.capture();
  assertPrivate(f.writes);
  assert.strictEqual(evidence.events[0].error, 'TimeoutError');
});
test('goto capture errors omit arbitrary messages and retain bounded type', async () => {
  const f = fixture();
  const evidence = await f.capture(sensitiveError());
  assertPrivate(f.writes);
  assert.strictEqual(evidence.error, 'TimeoutError');
});
test('request failures reject arbitrary error text', async () => {
  const f = fixture();
  f.page.emit('requestfailed', { url: () => privateURL, resourceType: () => 'script',
    failure: () => ({ errorText: sensitiveError().message }) });
  const evidence = await f.capture();
  assertPrivate(f.writes);
  assert.strictEqual(evidence.events[0].error, 'unknown');
});
test('successful probes persist sanitized URLs', async () => {
  const f = fixture({ baseUrl: privateURL });
  await f.capture();
  const text = f.writes.get('e2e-http-probes.txt');
  for (const secret of secrets) assert(!text.includes(secret), `probe leaked ${secret}`);
  assert.strictEqual(f.networkURLs.length, 2);
  assert.match(text, /https:\/\/example\.test\/navigation status=200/);
});
test('failed probes omit URL secrets and non-URL error messages', async () => {
  const f = fixture({ baseUrl: privateURL, probeFailure: true });
  await f.capture();
  const text = f.writes.get('e2e-http-probes.txt');
  for (const secret of secrets) assert(!text.includes(secret), `probe leaked ${secret}`);
  assert.match(text, /error=TimeoutError/);
});
test('synchronous probe errors still produce both safe artifacts', async () => {
  const f = fixture({ synchronousFailure: true });
  await f.capture();
  assertPrivate(f.writes);
  assert.match(f.writes.get('e2e-http-probes.txt'), /error=TimeoutError/);
});
test('untrusted error names and malformed URLs fail closed', async () => {
  const f = fixture({ baseUrl: 'userinfo-sentinel:password-sentinel@invalid?query-token-sentinel#private-fragment-sentinel' });
  const error = sensitiveError();
  error.name = 'nonURL-secret-sentinel';
  f.page.emit('pageerror', error);
  const evidence = await f.capture(error);
  assertPrivate(f.writes);
  assert.strictEqual(evidence.baseUrl, '[invalid URL]');
  assert.strictEqual(evidence.error, 'Error');
  assert.strictEqual(evidence.events[0].error, 'Error');
});

async function main() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL ${name}: ${error.stack || error.message}`);
      process.exitCode = 1;
    }
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corescope-e2e-diagnostics-'));
  try {
    const page = new EventEmitter();
    const context = new EventEmitter();
    const browser = new EventEmitter();
    const cdp = new EventEmitter();
    cdp.send = async () => {};
    const diagnostics = createFailureDiagnostics({
      page,
      context,
      browser,
      cdp,
      baseUrl: 'http://127.0.0.1:1',
      outputDir: temp,
      capacity: 5,
    });
    const request = {
      url: () => 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js?access_token=request-secret#request-fragment',
      resourceType: () => 'script',
      failure: () => ({ errorText: 'net::ERR_TIMED_OUT' }),
    };
    const pendingRequest = {
      url: () => 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css?api_key=response-secret#response-fragment',
      resourceType: () => 'stylesheet',
    };
    const response = {
      url: pendingRequest.url,
      status: () => 200,
      request: () => pendingRequest,
    };
    page.emit('request', request);
    page.emit('requestfailed', request);
    page.emit('request', pendingRequest);
    page.emit('response', response);
    page.emit('pageerror', new Error('page exploded'));
    cdp.emit('Page.domContentEventFired', { timestamp: 42 });

    await diagnostics.capture({ test: 'navigation regression', error: new Error('goto timeout') });
    const evidence = JSON.parse(fs.readFileSync(path.join(temp, 'e2e-navigation-diagnostics.json'), 'utf8'));
    assert.strictEqual(evidence.test, 'navigation regression');
    assert.strictEqual(evidence.error, 'Error');
    assert(evidence.events.some(event => event.kind === 'requestfailed' && event.resourceType === 'script' && event.error === 'net::ERR_TIMED_OUT'));
    assert(evidence.events.some(event => event.kind === 'domcontentloaded'));
    assert(evidence.events.some(event => event.kind === 'pageerror'));
    assert.deepStrictEqual(evidence.inFlightRequests, [
      {
        url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
        resourceType: 'stylesheet',
        startedAt: evidence.events.find(event => event.kind === 'request' && event.url.startsWith('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css')).at,
      },
    ]);
    const persistedEvidence = fs.readFileSync(path.join(temp, 'e2e-navigation-diagnostics.json'), 'utf8');
    for (const secret of ['request-secret', 'request-fragment', 'response-secret', 'response-fragment']) {
      assert(!persistedEvidence.includes(secret), `persisted evidence must not contain ${secret}`);
    }
    assert(fs.existsSync(path.join(temp, 'e2e-http-probes.txt')));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  passed++;
  console.log('  PASS original request privacy and bounded event capture');
  // Exercise the actual IATA geometry probe with private attributes present.
  const root = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/manifest.json'), 'utf8'));
  const entries = manifest.tests.filter(entry => entry.path === 'test-observer-iata-1188-e2e.js' ||
    entry.path === 'tests/e2e/test-observer-iata-1188-e2e.js');
  assert.strictEqual(entries.length, 1);
  const source = fs.readFileSync(path.join(root, entries[0].path), 'utf8');
  const start = source.indexOf('async function captureTableLayout()');
  const end = source.indexOf('\nasync function test', start);
  assert(start >= 0 && end > start, 'the actual geometry probe must be present');
  const element = tag => ({ tagName: tag, hidden: false, parentElement: null,
    id: '203.0.113.177-private-id', className: 'private-class-sentinel',
    textContent: 'geometry-private-token', url: 'https://example.test/?token=geometry-private-token',
    closest: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0, x: 0, y: 0 }) });
  const table = element('TABLE'), row = element('TR'), cell = element('TD');
  row.cells = [cell]; row.parentElement = table;
  const dom = { innerWidth: 375, innerHeight: 812,
    document: { querySelectorAll: selector => selector === 'table' ? [table] : [row] },
    getComputedStyle: () => ({ display: 'none', visibility: 'visible' }) };
  const output = [];
  const vm = require('vm');
  await vm.runInNewContext(source.slice(start, end) + '\ncaptureTableLayout()', {
    diagnosticPage: { evaluate: async callback => vm.runInNewContext('(' + callback.toString() + ')()', dom) },
    console: { log: (...args) => output.push(args.join(' ')) },
  });
  assert.strictEqual(output.length, 1);
  const metrics = JSON.parse(output[0].slice('IATA layout evidence: '.length));
  assert.strictEqual(metrics.rowCount, 1);
  assert.strictEqual(metrics.rows[0].cells[0].display, 'none');
  assert.doesNotMatch(output.join('\n'), /203\.0\.113\.177|private-id|private-class-sentinel|geometry-private-token|https:/);
  passed++;
  console.log('  PASS original bounded geometry privacy');
  console.log(`e2e failure diagnostics: ${passed} tests passed, ${failed} failed`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
