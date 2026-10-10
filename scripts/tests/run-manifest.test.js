#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  parseArguments,
  dispatchTests,
  selectTests,
  preflightTests,
  runTests,
} = require('./run-manifest');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function entry(testPath, suite = 'unit', status = 'active', overrides = {}) {
  return {
    path: testPath,
    suite,
    status,
    command: ['node', testPath],
    requirements: { environment: [], flags: [], packages: [] },
    ...overrides,
  };
}

test('canonical browser runner loads its real startup dependencies from its declared path', () => {
  const root = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/manifest.json'), 'utf8'));
  const runners = manifest.tests.filter(entry => entry.path === 'test-e2e-playwright.js' ||
    entry.path === 'tests/e2e/test-e2e-playwright.js');
  assert.strictEqual(runners.length, 1);
  const runnerPath = path.join(root, runners[0].path);
  const source = fs.readFileSync(runnerPath, 'utf8');
  const end = source.indexOf('\nconst BASE');
  assert(end > 0, 'startup dependency boundary must exist');
  // Execute actual imports with the runner's real CommonJS resolution base.
  // No browser is launched and no import is replaced by a mock.
  assert.doesNotThrow(() => require('vm').runInNewContext(source.slice(0, end), {
    require: require('module').createRequire(runnerPath),
  }));
});

test('E2E name selection rejects zero matches and runs matching callbacks', () => {
  const root = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/manifest.json'), 'utf8'));
  const runners = manifest.tests.filter(entry =>
    entry.path === 'test-e2e-playwright.js' || entry.path === 'tests/e2e/test-e2e-playwright.js');
  assert.strictEqual(runners.length, 1, 'probe must select exactly one declared canonical runner');
  const source = fs.readFileSync(path.join(root, runners[0].path), 'utf8');
  const registration = source.slice(source.indexOf('const results = []'), source.indexOf('\nfunction assert'));
  const closeMarker = '  await browser.close();';
  const summaryStart = source.lastIndexOf(closeMarker) + closeMarker.length;
  const summary = source.slice(summaryStart, source.indexOf('\n}\n\nrun().catch', summaryStart));
  assert.ok(registration.includes('async function test') && summary.includes('process.exit'),
    'probe must exercise the actual runner registration and final exit path');
  const probe = `(async () => {
    ${registration}
    await test('Customizer v2: selection fixture', async () => console.log('MATCHED_CALLBACK'));
    await test('Other selection fixture', async () => console.log('OTHER_CALLBACK'));
    ${summary}
  })().catch(error => { console.error(error); process.exit(1); });`;
  for (const [filter, expectedExit, expectedCount] of [
    ['__NO_SUCH_CASE__', 1, 0],
    ['^Customizer v2:', 0, 1],
    ['', 0, 2],
  ]) {
    const result = require('child_process').spawnSync(process.execPath, ['-e', probe], {
      env: { ...process.env, E2E_TEST_FILTER: filter }, encoding: 'utf8',
    });
    assert.strictEqual(result.status, expectedExit, result.stderr || result.stdout);
    const calls = (result.stdout.match(/(?:MATCHED|OTHER)_CALLBACK/g) || []).length;
    assert.strictEqual(calls, expectedCount, result.stdout);
  }
});

test('touch cancellation recovery follows moving rows through the actual E2E helpers and handlers', () => {
  const root = path.join(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/manifest.json'), 'utf8'));
  const entry = manifest.tests.find(test => test.path.endsWith('/test-touch-gestures-coverage-e2e.js'));
  assert.ok(entry && entry.status === 'active' && entry.suite === 'e2e', 'moving-row probe follows the active canonical runner');
  const source = fs.readFileSync(path.join(root, entry.path), 'utf8');
  const helpers = source.slice(source.indexOf('async function synthSwipe('), source.indexOf('async function main()'));
  const cases = source.slice(source.indexOf('    // ── (cov8)'), source.indexOf('    // ── (cov10)'));
  // Run the real helpers AND cov8/9 call sites, not a reimplementation of
  // their coordinate selection. Only DOM/layout and Playwright are faked.
  const probe = `
    const assert = require('assert');
    const vm = require('vm');
    const fs = require('fs');
    const listeners = new Map();
    const events = [];
    const overlays = [];
    let top = 110, cancellations = 0;
    function element(kind) {
      const classes = new Set();
      return {
        kind, style: {}, parentNode: null,
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
        closest(sel) {
          if (kind === 'row' || kind === 'cell') {
            if (sel.includes('tr[')) return row;
            if (sel === 'tbody') return tbody;
          }
          return null;
        },
        getBoundingClientRect() { return { left: 8, x: 8, top, y: top, right: 369, bottom: top + 29.5, width: 361, height: 29.5 }; },
        getAttribute() { return 'PRIVATE_PACKET_SENTINEL'; },
        setAttribute() {}, setPointerCapture() {}, releasePointerCapture() {},
        dispatchEvent(e) {
          e.target = this;
          events.push({ type: e.type, row: !!this.closest('tr[data-hash]'), transformed: !!row.style.transform });
          for (const handler of listeners.get(e.type) || []) handler(e);
          if (e.type === 'pointercancel' || e.type === 'lostpointercapture') cancellations++;
          return true;
        },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      };
    }
    const body = element('body');
    body.appendChild = o => { o.parentNode = body; overlays.push(o); };
    body.removeChild = o => { overlays.splice(overlays.indexOf(o), 1); o.parentNode = null; };
    const row = element('row'), cell = element('cell'), tbody = { id: 'pktBody' };
    const button = element('cell');
    button.closest = sel => sel.includes('tr[') ? row : sel.includes('button') ? button : null;
    const traces = [];
    const document = {
      body,
      addEventListener(type, fn) { listeners.set(type, [...listeners.get(type) || [], fn]); },
      createElement() { return element('overlay'); },
      querySelector(sel) {
        if (sel === '#pktBody tr[data-hash]') return row;
        if (sel.includes('.row-action-overlay')) return overlays.find(o => !sel.includes('-open') || o.classList.contains('row-action-overlay-open')) || null;
        return null;
      },
      querySelectorAll(sel) { return sel.includes('.row-action-overlay') ? overlays.slice() : []; },
      elementFromPoint(x, y) {
        if (x < 8 || x > 369 || y < top || y > top + 29.5) return body;
        return x > 280 && x < 300 ? button : cell;
      },
    };
    const window = { innerWidth: 375, SlideOver: { isOpen: () => false } };
    class PointerEvent {
      constructor(type, opts) { this.type = type; Object.assign(this, opts); }
      preventDefault() {}
    }
    const context = vm.createContext({ window, document, PointerEvent, innerWidth: 375,
      getComputedStyle: el => ({ transform: el.style.transform || 'none' }) });
    vm.runInContext(fs.readFileSync(${JSON.stringify(path.join(root, 'public/touch-gestures.js'))}, 'utf8'), context);
    const pP = {
      async evaluate(fn, args) {
        // A deterministic relayout immediately before dispatch also catches
        // fixes that merely take another snapshot in a separate browser task.
        if (cancellations && args && args.steps) top += 60;
        context.args = args;
        const result = vm.runInContext('(' + fn.toString() + ')(args)', context);
        if (args && args.steps) traces.push(result);
        return result;
      },
      async waitForTimeout() { top += 60; },
    };
    const messages = [];
    context.pP = pP;
    context.pass = message => messages.push(message);
    context.fail = message => { throw new Error(message); };
    vm.runInContext(${JSON.stringify(helpers)} + '\\n(async () => {' + ${JSON.stringify(cases)} + '\\n})()', context)
      .then(async () => {
        assert.strictEqual(messages.length, 4);
        const cancels = events.filter(e => /^(pointercancel|lostpointercapture)$/.test(e.type));
        assert.strictEqual(cancels.length, 2);
        assert.ok(cancels.every(e => e.transformed), 'cancel must follow actual row drag feedback');
        const downs = events.filter(e => e.type === 'pointerdown');
        assert.strictEqual(downs.length, 4);
        assert.ok(downs.every(e => e.row), 'every gesture must actually start on a non-interactive row cell');
        assert.ok(traces.every(t => t.startHitsRow && !t.startInteractive && t.dragged));
        const evidence = await context.gestureGeometry(pP, traces[3]);
        assert.ok(!JSON.stringify(evidence).includes('PRIVATE_PACKET_SENTINEL'), 'geometry evidence must not expose row identifiers');
        for (const trace of traces) {
          assert.ok(Object.values(trace).every(v => typeof v === 'number' || typeof v === 'boolean'),
            'dispatch evidence contains coordinates/booleans only');
        }
        assert.ok(!messages.join('').includes('PRIVATE_PACKET_SENTINEL'));
        console.log('Moving-row dispatch evidence: ' + JSON.stringify(traces));
        // Coordinate mode remains available for negative desktop/non-row
        // probes; the helper must not bypass production eligibility guards.
        cancellations = 0; // Freeze layout only for the eligibility controls.
        window.innerWidth = 1200;
        await context.synthSwipe(pP, 330, top + 15, 130, top + 15);
        assert.ok(events.filter(e => e.type === 'pointerdown').at(-1).row, 'desktop probe must hit a row');
        assert.strictEqual(overlays.length, 0, 'desktop must not open an overlay');
        window.innerWidth = 375;
        await context.synthSwipe(pP, 330, 5, 130, 5);
        assert.strictEqual(overlays.length, 0, 'non-row must not open an overlay');
        const hitTest = document.elementFromPoint;
        document.elementFromPoint = () => button;
        await assert.rejects(context.synthSwipe(pP, null, null, null, null,
          { rowSel: '#pktBody tr[data-hash]' }), /No hit-tested non-interactive row point/);
        document.elementFromPoint = hitTest;
      }).catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = require('child_process').spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  console.log(result.stdout.trim());
});

test('#1692 runner installs a supported packet window before module-load capture on both viewports', () => {
  const root = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/manifest.json'), 'utf8'));
  const runner = manifest.tests.find(entry => entry.path.endsWith('/test-issue-1692-packets-init-parallel-e2e.js'));
  assert.ok(runner && runner.status === 'active' && runner.suite === 'e2e');
  const source = fs.readFileSync(path.join(root, runner.path), 'utf8');
  const packets = fs.readFileSync(path.join(root, 'public/packets.js'), 'utf8');
  const capture = packets.slice(packets.indexOf('  const isMobile ='), packets.indexOf('  let totalCount ='));
  assert.ok(capture.includes('savedTimeWindowMin'), 'exercise actual module-load viewport policy');
  // Execute the actual browser runner with a deterministic navigation boundary.
  // A hash-only goto does not reload packets.js; an aged fixture has no rows
  // in its default 15-minute window. No production initialization is replaced.
  const probe = `
    const assert = require('assert'), vm = require('vm');
    (async () => {
      for (const width of [1400, 375]) {
        const storage = new Map(), initScripts = [];
        const document = vm.createContext({ window: { innerWidth: width },
          localStorage: { getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } });
        let loaded = false, requestedWindow, exit;
        const page = {
          setDefaultTimeout() {}, on() {}, async route() {}, async unroute() {},
          async addInitScript(fn) { initScripts.push(fn); },
          async goto(url) {
            if (!loaded) {
              for (const fn of initScripts) vm.runInContext('(' + fn.toString() + ')()', document);
              vm.runInContext(${JSON.stringify(capture)}, document);
              loaded = true;
            }
            if (url.includes('#/packets')) requestedWindow = vm.runInContext('savedTimeWindowMin', document);
          },
          async evaluate(fn) { return vm.runInContext('(' + fn.toString() + ')()', document); },
          async waitForSelector() { assert.ok(requestedWindow > 20, 'aged fixture has no rows in captured default window'); },
        };
        const ctx = { async newPage() { return page; }, async addInitScript(fn) { initScripts.push(fn); } };
        const browser = { async newContext() { return ctx; }, async close() {} };
        const context = { require: () => ({ chromium: { async launch() { return browser; } } }),
          process: { env: {}, exit: code => { exit = code; } },
          console: { log() {}, error() {} }, Date, setTimeout };
        await vm.runInNewContext(${JSON.stringify(source)}, context);
        assert.strictEqual(exit, 0, 'actual runner must render aged fixture rows after module-load capture');
        assert.strictEqual(requestedWindow, 180, 'supported window must survive desktop and mobile module policy');
      }
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = require('child_process').spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
});

test('active region-scope browser contract compiles before launching Chromium', () => {
  const root = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/manifest.json'), 'utf8'));
  const runner = manifest.tests.find(entry => entry.path.endsWith('/test-region-scope-e2e.js'));
  assert.ok(runner && runner.status === 'active' && runner.suite === 'e2e');
  const filename = path.join(root, runner.path);
  assert.doesNotThrow(() => new (require('vm').Script)(fs.readFileSync(filename, 'utf8'), { filename }));
});

test('parses deterministic profile, suite, status, list, and dry-run options', () => {
  assert.deepStrictEqual(parseArguments([]), {
    profile: null,
    suites: ['e2e', 'integration', 'unit'],
    statuses: ['active'],
    list: false,
    dryRun: false,
  });
  assert.deepStrictEqual(
    parseArguments(
      ['--profile', 'ci-unit-and-integration-phase', '--suite', 'unit,e2e', '--status=dormant', '--list', '--dry-run'],
      ['ci-unit-and-integration-phase']
    ),
    {
      profile: 'ci-unit-and-integration-phase',
      suites: ['e2e', 'unit'],
      statuses: ['dormant'],
      list: true,
      dryRun: true,
    }
  );
  assert.throws(() => parseArguments(['--suite', 'banana']), /invalid suite: banana/);
  assert.throws(() => parseArguments(['--status']), /--status requires a value/);
  assert.throws(
    () => parseArguments(['--profile=stale'], ['ci-unit-and-integration-phase']),
    /invalid profile: stale/
  );
  assert.throws(
    () => parseArguments(
      ['--profile=ci-unit-and-integration-phase', '--profile', 'ci-unit-and-integration-phase'],
      ['ci-unit-and-integration-phase']
    ),
    /--profile may only be specified once/
  );
  assert.throws(() => parseArguments(['--unknown']), /unknown argument: --unknown/);
});

for (const selector of ['suite', 'status', 'profile']) {
  for (const value of ['', ' ', ',']) {
    test(`rejects empty ${selector} selector ${JSON.stringify(value)} in both argument forms`, () => {
      for (const argv of [[`--${selector}=${value}`], [`--${selector}`, value]]) {
        assert.throws(() => parseArguments(argv, ['ci-e2e-phase']), /requires a non-empty value|invalid/);
      }
    });
  }
}

for (const argv of [
  ['--profile=ci-e2e-phase', '--suite=unit'],
  ['--profile=ci-e2e-phase', '--status=dormant'],
]) {
  test(`rejects zero execution selections: ${argv.join(' ')}`, () => {
    const root = path.resolve(__dirname, '../..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/manifest.json'), 'utf8'));
    const profiles = JSON.parse(fs.readFileSync(path.join(root, 'tests/legacy-runner-inventory.json'), 'utf8')).executedRootTests;
    const options = parseArguments(argv, Object.keys(profiles));
    const selected = selectTests(manifest, options, profiles, JSON.parse(fs.readFileSync(path.join(root, 'tests/legacy-runner-inventory.json'), 'utf8')).relocations);
    assert.strictEqual(selected.length, 0);
    assert.throws(() => dispatchTests(selected, options, {
      repoRoot: root,
      environment: {},
      spawnSync: () => { throw new Error('must not spawn'); },
    }), /no tests selected/);
  });
}

test('empty list and dry-run selections are successful inventory queries, not executions', () => {
  for (const mode of ['--list', '--dry-run']) {
    const options = parseArguments(['--suite=e2e', mode]);
    const selected = selectTests({ tests: [entry('test-unit.js')] }, options);
    const output = [];
    assert.strictEqual(dispatchTests(selected, options, {
      writeOutput: line => output.push(line),
      preflight: () => { throw new Error('must not preflight'); },
      run: () => { throw new Error('must not run'); },
    }), 0);
    assert.deepStrictEqual(output, []);
  }
});

test('canonical E2E profile clears ambient name narrowing but other execution preserves it', () => {
  const root = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/manifest.json'), 'utf8'));
  const profiles = JSON.parse(fs.readFileSync(path.join(root, 'tests/legacy-runner-inventory.json'), 'utf8')).executedRootTests;
  for (const profile of ['ci-e2e-phase', null]) {
    const options = parseArguments(profile ? [`--profile=${profile}`] : ['--suite=e2e'], Object.keys(profiles));
    const selected = selectTests(manifest, options, profiles, JSON.parse(fs.readFileSync(path.join(root, 'tests/legacy-runner-inventory.json'), 'utf8')).relocations);
    const environment = { E2E_TEST_FILTER: '^Customizer v2:', KEEP_ME: 'yes' };
    const calls = [];
    assert.strictEqual(dispatchTests(selected, options, {
      repoRoot: root,
      environment,
      preflight: () => {},
      writeOutput: () => {},
      spawnSync: (_executable, argv, childOptions) => {
        calls.push({ path: argv[0], env: childOptions.env });
        return { status: 0 };
      },
    }), 0);
    assert.strictEqual(calls.length, selected.length);
    assert.ok(calls.some(call => call.path.endsWith('/test-e2e-playwright.js')));
    for (const call of calls) {
      assert.ok(profile ? !call.env.E2E_TEST_FILTER : call.env.E2E_TEST_FILTER === '^Customizer v2:', call.path);
      assert.strictEqual(call.env.KEEP_ME, 'yes');
    }
    assert.strictEqual(environment.E2E_TEST_FILTER, '^Customizer v2:', 'caller environment must remain intact');
  }
});

test('combines a profile with suite and status filters in frozen profile order', () => {
  const manifest = {
    tests: [
      entry('test-z.js', 'unit'),
      entry('test-dormant.js', 'unit', 'dormant'),
      entry('test-a.js', 'e2e'),
      entry('test-middle.js', 'integration'),
      entry('test-extra.js', 'unit'),
      entry('test-wrapper.sh', 'unit', 'active', { orchestration: true }),
    ],
  };
  const profiles = {
    selected: ['test-z.js', 'test-a.js'],
  };
  assert.deepStrictEqual(
    selectTests(manifest, {
      profile: 'selected',
      suites: ['unit', 'e2e'],
      statuses: ['active'],
    }, profiles).map(item => item.path),
    ['test-z.js', 'test-a.js']
  );
});

test('resolves frozen profile identities through relocations without order drift', () => {
  const manifest = {
    tests: [
      entry('tests/unit/test-z.js'),
      entry('test-middle.js'),
      entry('tests/unit/test-a.js'),
    ],
  };
  const selected = selectTests(manifest, {
    profile: 'selected',
    suites: ['unit'],
    statuses: ['active'],
  }, {
    selected: ['test-z.js', 'test-middle.js', 'test-a.js'],
  }, {
    'test-z.js': 'tests/unit/test-z.js',
    'test-a.js': 'tests/unit/test-a.js',
  });
  assert.deepStrictEqual(selected.map(item => item.path), [
    'tests/unit/test-z.js',
    'test-middle.js',
    'tests/unit/test-a.js',
  ]);
});

test('rejects unresolved frozen identities and duplicate resolved destinations', () => {
  const manifest = { tests: [entry('tests/unit/test-a.js')] };
  const options = {
    profile: 'broken',
    suites: ['unit'],
    statuses: ['active'],
  };
  assert.throws(
    () => selectTests(manifest, options, { broken: ['test-a.js'] }, {}),
    /references missing test: test-a\.js/
  );
  assert.throws(
    () => selectTests(manifest, options, {
      broken: ['test-a.js', 'test-alias.js'],
    }, {
      'test-a.js': 'tests/unit/test-a.js',
      'test-alias.js': 'tests/unit/test-a.js',
    }),
    /resolves duplicate destination/
  );
});

test('rejects malformed profiles instead of silently dropping entries', () => {
  const active = entry('test-a.js');
  const dormant = entry('test-dormant.js', 'unit', 'dormant');
  const orchestration = entry('test-all.sh', 'integration', 'active', {
    command: ['sh', 'test-all.sh'],
    orchestration: true,
  });
  const manifest = { tests: [active, dormant, orchestration] };
  const options = {
    profile: 'broken',
    suites: ['unit', 'integration'],
    statuses: ['active'],
  };
  assert.throws(
    () => selectTests(manifest, options, { broken: ['test-a.js', 'test-typo.js'] }),
    /references missing test: test-typo\.js/
  );
  assert.throws(
    () => selectTests(manifest, options, { broken: ['test-a.js', 'test-a.js'] }),
    /contains duplicate paths/
  );
  assert.throws(
    () => selectTests(manifest, options, { broken: ['test-dormant.js'] }),
    /references non-active test/
  );
  assert.throws(
    () => selectTests(manifest, options, { broken: ['test-all.sh'] }),
    /references orchestration test/
  );
});

test('selects tests by suite and status in path order', () => {
  const manifest = {
    tests: [
      entry('test-z.js', 'unit'),
      entry('test-dormant.js', 'unit', 'dormant'),
      entry('test-a.js', 'e2e'),
      entry('test-middle.js', 'integration'),
    ],
  };
  assert.deepStrictEqual(
    selectTests(manifest, { suites: ['unit', 'e2e'], statuses: ['active'] }).map(item => item.path),
    ['test-a.js', 'test-z.js']
  );
  assert.deepStrictEqual(
    selectTests(manifest, { suites: ['unit'], statuses: ['dormant'] }).map(item => item.path),
    ['test-dormant.js']
  );
});

test('list and dry-run inventory modes do not require execution dependencies', () => {
  const tests = [entry('test-needs.js', 'e2e', 'dormant', {
    requirements: {
      environment: [{ name: 'SERVER_URL', required: true }],
      flags: [],
      packages: [{ name: 'missing-package', required: true }],
    },
  })];
  for (const mode of [{ list: true, dryRun: false }, { list: false, dryRun: true }]) {
    const output = [];
    const status = dispatchTests(tests, mode, {
      preflight: () => { throw new Error('must not preflight inventory mode'); },
      run: () => { throw new Error('must not execute inventory mode'); },
      writeOutput: line => output.push(line),
    });
    assert.strictEqual(status, 0);
    assert(output.join('').includes('test-needs.js'));
  }
});

test('excludes orchestration entries from child execution', () => {
  const manifest = {
    tests: [
      entry('test-all.sh', 'integration', 'active', {
        command: ['sh', 'test-all.sh'],
        orchestration: true,
      }),
      entry('test-real.js'),
    ],
  };
  assert.deepStrictEqual(
    selectTests(manifest, { suites: ['unit', 'integration'], statuses: ['active'] }).map(item => item.path),
    ['test-real.js']
  );
});

test('preflight reports all missing required environment and packages before execution', () => {
  const tests = [entry('test-needs.js', 'integration', 'active', {
    requirements: {
      environment: [{ name: 'SERVICE_URL', required: true }],
      flags: [],
      packages: [{ name: 'missing-package', required: true }],
    },
  })];
  assert.throws(
    () => preflightTests(tests, {
      repoRoot: '/repo',
      environment: {},
      resolvePackage: () => { throw new Error('not found'); },
    }),
    error => /SERVICE_URL/.test(error.message) && /missing-package/.test(error.message)
  );
});

test('executes exact argv from repository root with inherited env and flag defaults', () => {
  const calls = [];
  const tests = [entry('test-exact.js', 'unit', 'active', {
    command: ['node', 'test-exact.js'],
    requirements: {
      environment: [],
      flags: [{ name: 'STRICT_MODE', value: '1', enabled: true }],
      packages: [],
    },
  })];
  const result = runTests(tests, {
    repoRoot: '/repo',
    environment: { KEEP_ME: 'yes', STRICT_MODE: '0' },
    spawnSync: (executable, argv, options) => {
      calls.push({ executable, argv, options });
      return { status: 0 };
    },
  });
  assert.strictEqual(result, 0);
  assert.deepStrictEqual(calls[0].executable, 'node');
  assert.deepStrictEqual(calls[0].argv, ['test-exact.js']);
  assert.strictEqual(calls[0].options.cwd, path.resolve('/repo'));
  assert.strictEqual(calls[0].options.shell, false);
  assert.strictEqual(calls[0].options.stdio, 'inherit');
  assert.strictEqual(calls[0].options.env.KEEP_ME, 'yes');
  assert.strictEqual(calls[0].options.env.STRICT_MODE, '1');
});

test('does not inject strict flags marked as metadata-only', () => {
  const calls = [];
  const testEntry = entry('test-exact.js', 'unit', 'active', {
    requirements: {
      environment: [],
      flags: [
        { name: 'HISTORICAL_STRICT', value: '1', enabled: true },
        { name: 'AVAILABLE_BUT_NOT_LEGACY', value: '1', enabled: false },
      ],
      packages: [],
    },
  });
  assert.strictEqual(runTests([testEntry], {
    repoRoot: '/repo',
    environment: {},
    spawnSync: (_executable, _argv, options) => {
      calls.push(options.env);
      return { status: 0 };
    },
  }), 0);
  assert.strictEqual(calls[0].HISTORICAL_STRICT, '1');
  assert(!Object.prototype.hasOwnProperty.call(calls[0], 'AVAILABLE_BUT_NOT_LEGACY'));
});

test('stops at the first failure and propagates its exit status', () => {
  const executed = [];
  const status = runTests([entry('test-a.js'), entry('test-b.js')], {
    repoRoot: '/repo',
    environment: {},
    spawnSync: (_executable, argv) => {
      executed.push(argv[0]);
      return { status: 7 };
    },
  });
  assert.strictEqual(status, 7);
  assert.deepStrictEqual(executed, ['test-a.js']);
});

test('reports spawn errors as failure without running later tests', () => {
  const executed = [];
  const status = runTests([entry('test-a.js'), entry('test-b.js')], {
    repoRoot: '/repo',
    environment: {},
    writeError: () => {},
    spawnSync: (_executable, argv) => {
      executed.push(argv[0]);
      return { status: null, error: new Error('ENOENT') };
    },
  });
  assert.strictEqual(status, 1);
  assert.deepStrictEqual(executed, ['test-a.js']);
});

test('checked-in profiles exactly match each frozen legacy execution list', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/manifest.json'), 'utf8'));
  const inventory = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'tests/legacy-runner-inventory.json'), 'utf8')
  );
  for (const [profile, expected] of Object.entries(inventory.executedRootTests)) {
    const selected = selectTests(manifest, {
      profile,
      suites: ['unit', 'integration', 'e2e'],
      statuses: ['active'],
    }, inventory.executedRootTests, inventory.relocations).map(item => item.path);
    assert.deepStrictEqual(
      selected,
      expected.map(testPath => inventory.relocations[testPath] || testPath),
      profile
    );
    assert(!selected.some(testPath =>
      manifest.tests.some(item => item.path === testPath && item.status === 'dormant')
    ));
  }

  const wrapper = manifest.tests.find(item => item.path === 'test-all.sh');
  assert(wrapper, 'test-all.sh must remain represented in the manifest');
  assert.strictEqual(wrapper.orchestration, true);
  assert(!Object.values(inventory.executedRootTests).flat().includes('test-all.sh'));
});

test('frozen profile execution environments preserve legacy strict-flag behavior', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/manifest.json'), 'utf8'));
  const inventory = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/legacy-runner-inventory.json'), 'utf8'));
  const selected = selectTests(manifest, {
    profile: 'ci-e2e-phase',
    suites: ['e2e'],
    statuses: ['active'],
  }, inventory.executedRootTests, inventory.relocations);
  const frozenWorkflow = execFileSync(
    'git',
    ['show', `${inventory.capturedAtCommit}:.github/workflows/deploy.yml`],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  const calls = new Map();
  assert.strictEqual(runTests(selected, {
    repoRoot,
    environment: {},
    writeOutput: () => {},
    spawnSync: (_executable, argv, options) => {
      calls.set(argv[0], options.env);
      return { status: 0 };
    },
  }), 0);
  const originalIdentityByPath = new Map(
    Object.entries(inventory.relocations).map(([source, destination]) => [destination, source])
  );
  for (const item of selected) {
    const frozenIdentity = originalIdentityByPath.get(item.path) || item.path;
    const commandLine = frozenWorkflow.split(/\r?\n/).find(line =>
      line.includes(`node ${frozenIdentity}`)
    );
    assert(commandLine, `missing frozen command for ${frozenIdentity}`);
    const expected = Object.fromEntries([...commandLine.matchAll(/\b([A-Z][A-Z0-9_]*)=([^\s\\]+)/g)]
      .filter(match => match[1].endsWith('_REQUIRE') || match[1].includes('_STRICT'))
      .map(match => [match[1], match[2]]));
    assert.deepStrictEqual(calls.get(item.path), expected, item.path);
  }
});

test('local and CI entry points name their exact legacy profiles', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const testAll = fs.readFileSync(path.join(repoRoot, 'test-all.sh'), 'utf8');
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

  assert(packageJson.scripts['test:unit'].includes('--profile legacy-test-unit'));
  assert(packageJson.scripts['test:ci'].includes('--profile ci-unit-and-integration-phase'));
  assert(packageJson.scripts['test:ci:e2e'].includes('--profile ci-e2e-phase'));
  assert(testAll.includes('--profile local-package-and-test-all'));
  assert(workflow.includes('npm run test:ci'));
  assert(workflow.includes('npm run test:ci:e2e'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
