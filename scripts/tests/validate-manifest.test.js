#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateManifest } = require('./validate-manifest');

const STATUS_SURFACES_FOR_TEST = [
  'package.json',
  'test-all.sh',
  '.github/workflows/deploy.yml',
  'AGENTS.md',
  'README.md',
];

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

function entry(overrides = {}) {
  return {
    path: 'test-example.js',
    suite: 'unit',
    command: ['node', 'test-example.js'],
    requirements: { environment: [], flags: [] },
    status: 'active',
    statusEvidence: [{ source: 'test-all.sh', detail: 'listed by the primary local runner' }],
    classificationEvidence: [{ source: 'test-example.js', detail: 'runs isolated assertions with no external service' }],
    ...overrides,
  };
}

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-validator-'));
  fs.writeFileSync(path.join(repoRoot, 'test-example.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(repoRoot, 'test-all.sh'), 'node test-example.js\n');
  return { repoRoot, manifest: { version: 1, tests: [entry()] } };
}

function errorsFor(manifest, repoRoot, trackedRootTests = ['test-example.js'], options = {}) {
  return validateManifest(manifest, { repoRoot, trackedRootTests, ...options });
}

test('accepts a complete valid inventory', () => {
  const { repoRoot, manifest } = fixture();
  assert.deepStrictEqual(errorsFor(manifest, repoRoot), []);
});

test('reports tracked root tests missing from the inventory', () => {
  const { repoRoot, manifest } = fixture();
  const errors = errorsFor(manifest, repoRoot, ['test-example.js', 'test-missing.js']);
  assert(errors.some(error => error.includes('missing tracked root test: test-missing.js')));
});

test('reports manifest paths that do not exist', () => {
  const { repoRoot, manifest } = fixture();
  manifest.tests[0].path = 'test-does-not-exist.js';
  manifest.tests[0].command[1] = 'test-does-not-exist.js';
  const errors = errorsFor(manifest, repoRoot, ['test-does-not-exist.js']);
  assert(errors.some(error => error.includes('path does not exist: test-does-not-exist.js')));
});

test('reports duplicate paths', () => {
  const { repoRoot, manifest } = fixture();
  manifest.tests.push(entry());
  const errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('duplicate path: test-example.js')));
});

test('reports invalid suite and status values', () => {
  const { repoRoot, manifest } = fixture();
  manifest.tests[0].suite = 'browser';
  manifest.tests[0].status = 'retired';
  const errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('invalid suite')));
  assert(errors.some(error => error.includes('invalid status')));
});

test('reports malformed commands and metadata', () => {
  const { repoRoot, manifest } = fixture();
  manifest.tests[0].command = 'node test-example.js';
  manifest.tests.push(entry({
    path: 'test-other.js',
    command: ['banana', 'test-other.js'],
  }));
  fs.writeFileSync(path.join(repoRoot, 'test-other.js'), 'process.exit(0);\n');
  manifest.tests[0].requirements = { environment: ['BASE_URL'] };
  manifest.tests[0].statusEvidence = [];
  manifest.tests[0].classificationEvidence = [{ source: '', detail: '' }];
  const errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('command must be a non-empty argv array')));
  assert(errors.some(error => error.includes('canonical runner shape')));
  assert(errors.some(error => error.includes('requirements.flags must be an array')));
  assert(errors.some(error => error.includes('requirements.environment[0] must be an object')));
  assert(errors.some(error => error.includes('statusEvidence must be a non-empty array')));
  assert(errors.some(error => error.includes('classificationEvidence[0].source')));
});

test('accepts canonical Node, shell, and Playwright command shapes', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(path.join(repoRoot, 'test-shell.sh'), '#!/bin/sh\n');
  fs.appendFileSync(path.join(repoRoot, 'test-all.sh'), 'sh test-shell.sh\nnode test-browser.js\n');
  fs.writeFileSync(
    path.join(repoRoot, 'test-browser.js'),
    "const { test } = require('@playwright/test');\n"
  );
  manifest.tests.push(entry({
    path: 'test-shell.sh',
    suite: 'integration',
    command: ['sh', 'test-shell.sh'],
  }));
  manifest.tests.push(entry({
    path: 'test-browser.js',
    suite: 'e2e',
    command: ['npx', 'playwright', 'test', 'test-browser.js'],
    requirements: {
      environment: [],
      flags: [],
      packages: [{
        name: '@playwright/test',
        required: true,
        description: 'Playwright test runner package',
      }],
    },
    classificationEvidence: [{
      source: 'test-browser.js',
      detail: 'imports the Playwright test runner and drives browser behavior',
    }],
  }));

  assert.deepStrictEqual(errorsFor(
    manifest,
    repoRoot,
    ['test-example.js', 'test-shell.sh', 'test-browser.js']
  ), []);
});

test('rejects canonical-looking commands with trailing control arguments', () => {
  const cases = [
    {
      path: 'test-example.js',
      source: 'process.exit(0);\n',
      command: ['node', 'test-example.js', '--help'],
      suite: 'unit',
    },
    {
      path: 'test-example.sh',
      source: '#!/bin/sh\nexit 0\n',
      command: ['sh', 'test-example.sh', '--dry-run'],
      suite: 'integration',
    },
    {
      path: 'test-example.js',
      source: "const { test } = require('@playwright/test');\n",
      command: ['npx', 'playwright', 'test', 'test-example.js', '--list'],
      suite: 'e2e',
      packages: [{
        name: '@playwright/test',
        required: true,
        description: 'Playwright test runner package',
      }],
    },
  ];

  for (const testCase of cases) {
    const { repoRoot, manifest } = fixture();
    fs.writeFileSync(path.join(repoRoot, testCase.path), testCase.source);
    fs.writeFileSync(path.join(repoRoot, 'test-all.sh'), `node ${testCase.path}\n`);
    manifest.tests[0] = entry({
      path: testCase.path,
      command: testCase.command,
      suite: testCase.suite,
      requirements: { environment: [], flags: [], packages: testCase.packages || [] },
    });
    const errors = errorsFor(manifest, repoRoot, [testCase.path]);
    assert(
      errors.some(error => error.includes('canonical runner shape')),
      `expected rejection for ${JSON.stringify(testCase.command)}; got ${errors.join('; ')}`
    );
  }
});

test('rejects commands where the path is not the executed test', () => {
  const bypasses = [
    ['node', '-e', 'process.exit(0)', 'test-example.js'],
    ['sh', '-c', 'exit 0', 'test-example.js'],
    ['npx', 'playwright', 'test', '--list', 'test-example.js'],
    ['npx', 'playwright', 'test', 'other.js', 'test-example.js'],
  ];

  for (const command of bypasses) {
    const { repoRoot, manifest } = fixture();
    manifest.tests[0].command = command;
    const errors = errorsFor(manifest, repoRoot);
    assert(
      errors.some(error => error.includes('canonical runner shape')),
      `expected rejection for ${JSON.stringify(command)}; got ${errors.join('; ')}`
    );
  }
});

test('rejects existing manifest entries that are not tracked root tests', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(path.join(repoRoot, 'test-untracked.js'), 'process.exit(0);\n');
  manifest.tests.push(entry({
    path: 'test-untracked.js',
    command: ['node', 'test-untracked.js'],
  }));
  const errors = errorsFor(manifest, repoRoot, ['test-example.js']);
  assert(errors.some(error => error.includes('untracked root test: test-untracked.js')));
});

test('rejects both slash types in manifest paths', () => {
  for (const invalidPath of ['nested/test-example.js', 'nested\\test-example.js']) {
    const { repoRoot, manifest } = fixture();
    manifest.tests[0].path = invalidPath;
    manifest.tests[0].command = ['node', invalidPath];
    const errors = errorsFor(manifest, repoRoot, [invalidPath]);
    assert(
      errors.some(error => error.includes('root-level compatibility test')),
      `expected rejection for ${invalidPath}; got ${errors.join('; ')}`
    );
  }
});

test('discovers direct test files in supported suite directories', () => {
  const { trackedRootTests } = require('./validate-manifest');
  const { repoRoot } = fixture();
  for (const suite of ['unit', 'integration', 'e2e']) {
    fs.mkdirSync(path.join(repoRoot, 'tests', suite), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'tests', suite, `test-${suite}.js`), 'process.exit(0);\n');
  }
  fs.mkdirSync(path.join(repoRoot, 'tests', 'unit', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'tests', 'unit', 'nested', 'test-too-deep.js'), 'process.exit(0);\n');
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['add', 'test-example.js', 'tests'], { cwd: repoRoot });
  assert.deepStrictEqual(trackedRootTests(repoRoot), [
    'test-example.js',
    'tests/e2e/test-e2e.js',
    'tests/integration/test-integration.js',
    'tests/unit/test-unit.js',
  ]);
});

test('accepts a frozen identity relocated to its matching suite directory', () => {
  const { repoRoot, manifest } = fixture();
  fs.mkdirSync(path.join(repoRoot, 'tests', 'unit'), { recursive: true });
  fs.renameSync(
    path.join(repoRoot, 'test-example.js'),
    path.join(repoRoot, 'tests', 'unit', 'test-example.js')
  );
  manifest.tests[0] = entry({
    path: 'tests/unit/test-example.js',
    command: ['node', 'tests/unit/test-example.js'],
    classificationEvidence: [{
      source: 'tests/unit/test-example.js',
      detail: 'runs isolated assertions with no external service',
    }],
  });
  const frozenInventory = {
    profiles: { local: ['test-example.js'] },
    relocations: { 'test-example.js': 'tests/unit/test-example.js' },
    orchestration: new Set(),
    capturedPaths: new Set(['test-example.js']),
    references: new Map([
      ['package.json', new Set()],
      ['test-all.sh', new Set(['test-example.js'])],
      ['.github/workflows/deploy.yml', new Set()],
      ['AGENTS.md', new Set()],
      ['README.md', new Set()],
    ]),
  };
  assert.deepStrictEqual(errorsFor(
    manifest,
    repoRoot,
    ['tests/unit/test-example.js'],
    { frozenInventory }
  ), []);
});

test('rejects missing duplicate and wrong-suite relocation destinations', () => {
  const { repoRoot, manifest } = fixture();
  fs.mkdirSync(path.join(repoRoot, 'tests', 'unit'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'tests', 'integration'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'tests', 'unit', 'test-one.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(repoRoot, 'tests', 'integration', 'test-two.js'), 'process.exit(0);\n');
  manifest.tests = [
    entry({ path: 'tests/unit/test-one.js', command: ['node', 'tests/unit/test-one.js'] }),
    entry({ path: 'tests/integration/test-two.js', command: ['node', 'tests/integration/test-two.js'] }),
  ];
  const baseInventory = {
    profiles: { local: ['test-example.js', 'test-other.js'] },
    relocations: {},
    orchestration: new Set(),
    capturedPaths: new Set(['test-example.js', 'test-other.js']),
    references: new Map(STATUS_SURFACES_FOR_TEST.map(surface => [
      surface,
      surface === 'test-all.sh' ? new Set(['test-example.js', 'test-other.js']) : new Set(),
    ])),
  };
  let errors = errorsFor(manifest, repoRoot,
    ['tests/unit/test-one.js', 'tests/integration/test-two.js'], { frozenInventory: baseInventory });
  assert(errors.some(error => error.includes('unresolved frozen identity: test-example.js')));

  baseInventory.relocations = {
    'test-example.js': 'tests/unit/test-one.js',
    'test-other.js': 'tests/unit/test-one.js',
  };
  errors = errorsFor(manifest, repoRoot,
    ['tests/unit/test-one.js', 'tests/integration/test-two.js'], { frozenInventory: baseInventory });
  assert(errors.some(error => error.includes('duplicate relocation destination')));

  baseInventory.relocations = {
    'test-example.js': 'tests/integration/test-two.js',
    'test-other.js': 'tests/unit/test-one.js',
  };
  errors = errorsFor(manifest, repoRoot,
    ['tests/unit/test-one.js', 'tests/integration/test-two.js'], { frozenInventory: baseInventory });
  assert(errors.some(error => error.includes('relocation destination suite integration does not match manifest suite unit')));
});

test('rejects relocation traversal symlinks and non-frozen sources', () => {
  const { repoRoot, manifest } = fixture();
  const frozenInventory = {
    profiles: { local: ['test-example.js'] },
    relocations: { 'tests/unit/not-frozen.js': '../test-example.js' },
    orchestration: new Set(),
    capturedPaths: new Set(['test-example.js']),
    references: new Map(STATUS_SURFACES_FOR_TEST.map(surface => [
      surface,
      surface === 'test-all.sh' ? new Set(['test-example.js']) : new Set(),
    ])),
  };
  let errors = errorsFor(manifest, repoRoot, ['test-example.js'], { frozenInventory });
  assert(errors.some(error => error.includes('relocation source must be a frozen root test identity')));
  assert(errors.some(error => error.includes('relocation destination must be a supported test path')));

  fs.mkdirSync(path.join(repoRoot, 'tests', 'unit'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'test-example.js'), path.join(repoRoot, 'tests', 'unit', 'test-link.js'));
  manifest.tests[0] = entry({
    path: 'tests/unit/test-link.js',
    command: ['node', 'tests/unit/test-link.js'],
  });
  frozenInventory.relocations = { 'test-example.js': 'tests/unit/test-link.js' };
  errors = errorsFor(manifest, repoRoot, ['tests/unit/test-link.js'], { frozenInventory });
  assert(errors.some(error => error.includes('regular file directly under its supported test directory')));
});

test('rejects non-regular files and symlinks as test paths', () => {
  const { repoRoot, manifest } = fixture();
  fs.mkdirSync(path.join(repoRoot, 'test-directory.js'));
  manifest.tests[0].path = 'test-directory.js';
  manifest.tests[0].command = ['node', 'test-directory.js'];
  let errors = errorsFor(manifest, repoRoot, ['test-directory.js']);
  assert(errors.some(error => error.includes('regular file directly under its supported test directory')));

  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-outside-'));
  fs.writeFileSync(path.join(outsideRoot, 'outside.js'), 'process.exit(0);\n');
  fs.symlinkSync(path.join(outsideRoot, 'outside.js'), path.join(repoRoot, 'test-link.js'));
  manifest.tests[0].path = 'test-link.js';
  manifest.tests[0].command = ['node', 'test-link.js'];
  errors = errorsFor(manifest, repoRoot, ['test-link.js']);
  assert(errors.some(error => error.includes('regular file directly under its supported test directory')));
});

test('rejects non-e2e suites and false evidence for Playwright sources', () => {
  for (const source of [
    "const { chromium } = require('playwright');\n",
    "import { test } from '@playwright/test';\n",
  ]) {
    const { repoRoot, manifest } = fixture();
    fs.writeFileSync(path.join(repoRoot, 'test-example.js'), source);
    manifest.tests[0].suite = source.startsWith('import') ? 'integration' : 'unit';
    manifest.tests[0].classificationEvidence = [{
      source: 'test-example.js',
      detail: 'runs assertions without importing a browser runner',
    }];
    const errors = errorsFor(manifest, repoRoot);
    assert(errors.some(error => error.includes('Playwright source must use suite e2e')));
    assert(errors.some(error => error.includes('contradicts the Playwright source')));
  }
});

test('requires @playwright/test sources to use the Playwright test runner command', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(
    path.join(repoRoot, 'test-example.js'),
    "const { test } = require('@playwright/test');\n"
  );
  manifest.tests[0].suite = 'e2e';
  manifest.tests[0].requirements.packages = [{
    name: '@playwright/test',
    required: true,
    description: 'Playwright test runner package',
  }];
  manifest.tests[0].classificationEvidence = [{
    source: 'test-example.js',
    detail: 'imports the Playwright test runner and drives browser behavior',
  }];
  const errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('must use the canonical Playwright runner command')));
});

test('requires undeclared @playwright/test imports to name the package requirement', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(
    path.join(repoRoot, 'test-example.js'),
    "const { test } = require('@playwright/test');\n"
  );
  manifest.tests[0].suite = 'e2e';
  manifest.tests[0].command = ['npx', 'playwright', 'test', 'test-example.js'];
  manifest.tests[0].classificationEvidence = [{
    source: 'test-example.js',
    detail: 'imports the Playwright test runner and drives browser behavior',
  }];
  const errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('must declare required package @playwright/test')));
});

test('requires undeclared jsdom imports to name the package requirement', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(
    path.join(repoRoot, 'test-example.js'),
    "const { JSDOM } = require('jsdom');\n"
  );
  const errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('must declare required package jsdom')));
});

test('requires every process.env variable to have requirement metadata', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(
    path.join(repoRoot, 'test-example.js'),
    "const route = process.env.OPTIONAL_ROUTE; const strict = process.env['STRICT_MODE'] === '1'; const { BASE_URL, CHROMIUM_PATH: browserPath } = process.env;\n"
  );
  let errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('process.env variable OPTIONAL_ROUTE must be declared')));
  assert(errors.some(error => error.includes('process.env variable STRICT_MODE must be declared')));
  assert(errors.some(error => error.includes('process.env variable BASE_URL must be declared')));
  assert(errors.some(error => error.includes('process.env variable CHROMIUM_PATH must be declared')));

  manifest.tests[0].requirements.environment.push({
    name: 'OPTIONAL_ROUTE',
    required: false,
    description: 'optional route filter',
  }, {
    name: 'BASE_URL',
    required: false,
    description: 'server URL',
  }, {
    name: 'CHROMIUM_PATH',
    required: false,
    description: 'browser executable',
  });
  manifest.tests[0].requirements.flags.push({
    name: 'STRICT_MODE',
    value: '1',
    enabled: true,
    description: 'enable strict execution',
  });
  errors = errorsFor(manifest, repoRoot);
  assert(!errors.some(error => error.includes('process.env variable')));
});

test('distinguishes value-bearing environment settings from strict boolean flags', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(
    path.join(repoRoot, 'test-example.js'),
    "const base = process.env.BASE_URL || 'http://localhost'; if (process.env.STRICT_MODE === '1') process.exit(1);\n"
  );
  manifest.tests[0].requirements.environment = [{
    name: 'STRICT_MODE',
    required: false,
    description: 'incorrectly placed strict flag',
  }];
  manifest.tests[0].requirements.flags = [{
    name: 'BASE_URL',
    value: '1',
    enabled: true,
    description: 'incorrectly placed URL setting',
  }];
  const errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('BASE_URL must be declared in requirements.environment')));
  assert(errors.some(error => error.includes('STRICT_MODE must be declared in requirements.flags')));
});

test('recognizes destructured strict boolean environment flags', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(
    path.join(repoRoot, 'test-example.js'),
    "const { STRICT_MODE: strictMode } = process.env; if (strictMode === '1') process.exit(1);\n"
  );
  manifest.tests[0].requirements.environment = [{
    name: 'STRICT_MODE',
    required: false,
    description: 'incorrectly placed strict flag',
  }];
  const errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('STRICT_MODE must be declared in requirements.flags')));
});

test('requires status to reflect references across the five declared surfaces', () => {
  let setup = fixture();
  setup.manifest.tests[0].status = 'dormant';
  setup.manifest.tests[0].statusEvidence = [{
    source: 'inventory audit',
    detail: 'not listed in package.json, test-all.sh, .github/workflows/deploy.yml, AGENTS.md, or README.md',
  }];
  let errors = errorsFor(setup.manifest, setup.repoRoot);
  assert(errors.some(error => error.includes('referenced by declared surface test-all.sh')));

  setup = fixture();
  fs.writeFileSync(path.join(setup.repoRoot, 'test-all.sh'), '# no test reference\n');
  errors = errorsFor(setup.manifest, setup.repoRoot);
  assert(errors.some(error => error.includes('must use status dormant because it is absent')));
});

test('uses the frozen legacy inventory after orchestration surfaces become generic', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(path.join(repoRoot, 'test-all.sh'), 'node scripts/tests/run-manifest.js\n');
  const frozenInventory = {
    profiles: { local: ['test-example.js'] },
    orchestration: new Set(),
    capturedPaths: new Set(['test-example.js']),
    references: new Map([
      ['package.json', new Set()],
      ['test-all.sh', new Set(['test-example.js'])],
      ['.github/workflows/deploy.yml', new Set()],
      ['AGENTS.md', new Set()],
      ['README.md', new Set()],
    ]),
  };
  assert.deepStrictEqual(
    errorsFor(manifest, repoRoot, ['test-example.js'], { frozenInventory }),
    []
  );
});

test('uses current surfaces to classify tests added after the frozen capture', () => {
  const { repoRoot, manifest } = fixture();
  const frozenInventory = {
    profiles: { local: [] },
    orchestration: new Set(),
    capturedPaths: new Set(),
    references: new Map([
      ['package.json', new Set()],
      ['test-all.sh', new Set()],
      ['.github/workflows/deploy.yml', new Set()],
      ['AGENTS.md', new Set()],
      ['README.md', new Set()],
    ]),
  };
  assert.deepStrictEqual(
    errorsFor(manifest, repoRoot, ['test-example.js'], { frozenInventory }),
    []
  );
});

test('requires explicit boolean execution metadata for strict flags', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(
    path.join(repoRoot, 'test-example.js'),
    "if (process.env.STRICT_MODE === '1') process.exit(0);\n"
  );
  manifest.tests[0].requirements.flags = [{
    name: 'STRICT_MODE',
    value: '1',
    enabled: false,
    description: 'available strict mode that the historical runner did not enable',
  }];
  assert.deepStrictEqual(errorsFor(manifest, repoRoot), []);
  manifest.tests[0].requirements.flags[0].enabled = 'no';
  assert(errorsFor(manifest, repoRoot).some(error => error.includes('.enabled must be boolean')));
});

test('requires orchestration markers to exactly match the frozen inventory', () => {
  const { repoRoot, manifest } = fixture();
  const frozenInventory = {
    profiles: { local: [] },
    orchestration: new Set(['test-example.js']),
    capturedPaths: new Set(['test-example.js']),
    references: new Map([
      ['package.json', new Set()],
      ['test-all.sh', new Set(['test-example.js'])],
      ['.github/workflows/deploy.yml', new Set()],
      ['AGENTS.md', new Set()],
      ['README.md', new Set()],
    ]),
  };
  const errors = errorsFor(
    manifest,
    repoRoot,
    ['test-example.js'],
    { frozenInventory }
  );
  assert(errors.some(error => error.includes('orchestration marker must match')));
});

test('rejects drift in frozen execution profiles and captured commit metadata', () => {
  const { repoRoot, manifest } = fixture();
  const checkedIn = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../tests/legacy-runner-inventory.json'),
    'utf8'
  ));
  fs.mkdirSync(path.join(repoRoot, 'tests'));
  const drifted = JSON.parse(JSON.stringify(checkedIn));
  drifted.executedRootTests['local-package-and-test-all'].pop();
  fs.writeFileSync(
    path.join(repoRoot, 'tests/legacy-runner-inventory.json'),
    JSON.stringify(drifted)
  );
  assert.throws(
    () => errorsFor(manifest, repoRoot),
    /does not match the frozen baseline/
  );

  drifted.executedRootTests = checkedIn.executedRootTests;
  drifted.capturedAtCommit = '0000000000000000000000000000000000000000';
  fs.writeFileSync(
    path.join(repoRoot, 'tests/legacy-runner-inventory.json'),
    JSON.stringify(drifted)
  );
  assert.throws(
    () => errorsFor(manifest, repoRoot),
    /capturedAtCommit must equal/
  );
});

test('requires active status evidence sources to exactly match referencing surfaces', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
    scripts: { test: 'node test-example.js' },
  }));
  let errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('statusEvidence sources must exactly match')));

  manifest.tests[0].statusEvidence.push({
    source: 'README.md',
    detail: 'explicitly listed as a test command or documented runner',
  });
  errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('statusEvidence sources must exactly match')));
});

test('requires dormant inventory-audit evidence to use the canonical absence statement', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(path.join(repoRoot, 'test-all.sh'), '# no test reference\n');
  manifest.tests[0].status = 'dormant';
  manifest.tests[0].statusEvidence = [{ source: 'inventory audit', detail: 'probably unused' }];
  const errors = errorsFor(manifest, repoRoot);
  assert(errors.some(error => error.includes('canonical inventory-audit evidence')));
});

test('requires repository integration runners to retain behavior-based classification', () => {
  const cases = [
    {
      path: 'test-all.sh',
      source: '#!/bin/sh\nnode test-example.js\n',
      command: ['sh', 'test-all.sh'],
      activeSurface: 'package.json',
      activeContent: JSON.stringify({ scripts: { test: 'sh test-all.sh' } }),
    },
    {
      path: 'tests/integration/test-e2e-badge-aggregate.sh',
      source: '#!/bin/sh\naggregator="scripts/aggregate-e2e-pass.sh"\n"$aggregator" tests/fixtures/e2e/e2e-output-sample.txt\n',
      command: ['sh', 'tests/integration/test-e2e-badge-aggregate.sh'],
    },
    {
      path: 'tests/integration/test-preflight-xss-gate.js',
      source: "const { spawnSync } = require('child_process');\nspawnSync('bash', ['scripts/check-xss-sinks.sh', 'tests/fixtures/preflight-xss/bad.js']);\n",
      command: ['node', 'tests/integration/test-preflight-xss-gate.js'],
      activeSurface: 'test-all.sh',
      activeContent: 'node tests/integration/test-preflight-xss-gate.js\n',
    },
    {
      path: 'test-tool-wrapper.js',
      source: "const { spawn } = require('node:child_process');\nspawn('bash', ['scripts/check-example.sh']);\n",
      command: ['node', 'test-tool-wrapper.js'],
    },
    {
      path: 'test-constructed-tool-wrapper.js',
      source: "const path = require('path'); const child = require('child_process');\nconst tool = path.join(__dirname, 'scripts', 'check-example.sh'); child.spawnSync('bash', [tool]);\n",
      command: ['node', 'test-constructed-tool-wrapper.js'],
    },
    ...['exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(api => ({
      path: `test-child-${api.toLowerCase()}.js`,
      source: `const { ${api} } = require('node:child_process');\n${api}('scripts/check-example.sh');\n`,
      command: ['node', `test-child-${api.toLowerCase()}.js`],
    })),
  ];

  for (const testCase of cases) {
    const { repoRoot, manifest } = fixture();
    const testPath = path.join(repoRoot, testCase.path);
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, testCase.source);
    manifest.tests[0] = entry({
      path: testCase.path,
      suite: 'unit',
      command: testCase.command,
      status: testCase.activeSurface ? 'active' : 'dormant',
      statusEvidence: testCase.activeSurface
        ? [{ source: testCase.activeSurface, detail: 'explicitly listed as a test command or documented runner' }]
        : [{ source: 'inventory audit', detail: 'not listed in package.json, test-all.sh, .github/workflows/deploy.yml, AGENTS.md, or README.md' }],
      classificationEvidence: [{
        source: 'README.md',
        detail: 'runs isolated unit assertions without integration behavior',
      }],
    });
    if (testCase.activeSurface) {
      fs.writeFileSync(path.join(repoRoot, testCase.activeSurface), testCase.activeContent);
    } else {
      fs.writeFileSync(path.join(repoRoot, 'test-all.sh'), '# no test reference\n');
    }
    const errors = errorsFor(manifest, repoRoot, [testCase.path]);
    assert(errors.some(error => error.includes('integration behavior must use suite integration')),
      `${testCase.path}: ${errors.join('; ')}`);
    assert(errors.some(error => error.includes('classificationEvidence must cite the test path')),
      `${testCase.path}: ${errors.join('; ')}`);
    assert(errors.some(error => error.includes('classificationEvidence contradicts detected integration behavior')),
      `${testCase.path}: ${errors.join('; ')}`);
  }
});

test('keeps Playwright tests e2e when they also launch child processes', () => {
  const { repoRoot, manifest } = fixture();
  fs.writeFileSync(
    path.join(repoRoot, 'test-example.js'),
    "const { test } = require('@playwright/test'); const { spawn } = require('node:child_process'); spawn('server'); test('works', async ({ page }) => {});\n"
  );
  manifest.tests[0].suite = 'e2e';
  manifest.tests[0].command = ['npx', 'playwright', 'test', 'test-example.js'];
  manifest.tests[0].requirements.packages = [{
    name: '@playwright/test',
    required: true,
    description: 'Playwright test runner package',
  }];
  manifest.tests[0].classificationEvidence = [{
    source: 'test-example.js',
    detail: 'imports the Playwright test runner and drives browser behavior',
  }];
  const errors = errorsFor(manifest, repoRoot);
  assert(!errors.some(error => error.includes('integration behavior must use suite integration')));
  assert(!errors.some(error => error.includes('Playwright source must use suite e2e')));
});

test('wires manifest validation and canonical suites into npm, the local wrapper, and CI', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const localRunner = fs.readFileSync(path.join(repoRoot, 'test-all.sh'), 'utf8');
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

  assert.strictEqual(
    packageJson.scripts['test:manifest'],
    'node scripts/tests/validate-manifest.test.js && node scripts/tests/run-manifest.test.js && node scripts/tests/combined-coverage.test.js && node scripts/tests/e2e-failure-diagnostics.test.js && node scripts/tests/validate-manifest.js'
  );
  assert.strictEqual(packageJson.scripts.test,
    'npx c8 --reporter=text --reporter=text-summary sh test-all.sh');
  assert.strictEqual(packageJson.scripts['test:unit'],
    'node scripts/tests/run-manifest.js --profile legacy-test-unit && npm run test:mini-markdown-security');
  assert.strictEqual(packageJson.scripts['test:unit:all-active'],
    'node scripts/tests/run-manifest.js --suite unit --status active');
  assert.strictEqual(packageJson.scripts['test:integration'],
    'node scripts/tests/run-manifest.js --suite integration --status active');
  assert.strictEqual(packageJson.scripts['test:e2e'],
    'node scripts/tests/run-manifest.js --suite e2e --status active');
  assert.strictEqual(packageJson.scripts['test:ci'],
    'node scripts/tests/run-manifest.js --profile ci-unit-and-integration-phase');
  assert.strictEqual(packageJson.scripts['test:ci:e2e'],
    'node scripts/tests/run-manifest.js --profile ci-e2e-phase');
  assert.strictEqual(packageJson.scripts['test:audit:all-active'],
    'node scripts/tests/run-manifest.js --status active --list');
  assert(localRunner.includes('node scripts/tests/run-manifest.js --profile local-package-and-test-all'));
  assert(!/^\s*(?:node|sh|bash)\s+test[^\s]*\.(?:js|sh)/m.test(localRunner),
    'compatibility wrapper must not contain a second root-test inventory');
  assert(workflow.includes('npm run test:manifest'));
  assert(workflow.includes('npm run test:ci'));
  assert(workflow.includes('npm run test:ci:e2e'));
});

test('repository-root helper is independent of launch cwd', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const helperPath = path.join(repoRoot, 'tests', 'helpers', 'repository-root.js');
  const launchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-root-cwd-'));
  const output = execFileSync(process.execPath, [
    '-e',
    `const helper = require(${JSON.stringify(helperPath)}); ` +
      `process.stdout.write(JSON.stringify([helper.repositoryRoot, helper.fromRepositoryRoot('public', 'app.js')]));`,
  ], { cwd: launchCwd, encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(output), [
    repoRoot,
    path.join(repoRoot, 'public', 'app.js'),
  ]);
});

test('accepts the checked-in manifest and all tracked root test runners', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/manifest.json'), 'utf8'));
  assert.deepStrictEqual(validateManifest(manifest, { repoRoot }), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
