#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateManifest } = require('./validate-manifest');

const VALID_SUITES = ['e2e', 'integration', 'unit'];
const VALID_STATUSES = ['active', 'dormant'];

function optionValues(value, validValues, label) {
  if (!value.trim() || !value.split(',').some(item => item.trim())) {
    throw new Error(`--${label} requires a non-empty value`);
  }
  const values = value === 'all' ? validValues : value.split(',').filter(Boolean);
  for (const item of values) {
    if (!validValues.includes(item)) throw new Error(`invalid ${label}: ${item}`);
  }
  return [...new Set(values)].sort();
}

function parseArguments(argv, validProfiles = []) {
  let profileSpecified = false;
  const options = {
    profile: null,
    suites: [...VALID_SUITES],
    statuses: ['active'],
    list: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--list') {
      options.list = true;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--profile' || argument === '--suite' || argument === '--status') {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      const value = argv[++index];
      if (argument === '--profile') {
        if (profileSpecified) throw new Error('--profile may only be specified once');
        if (!validProfiles.includes(value)) throw new Error(`invalid profile: ${value}`);
        options.profile = value;
        profileSpecified = true;
      } else if (argument === '--suite') options.suites = optionValues(value, VALID_SUITES, 'suite');
      else options.statuses = optionValues(value, VALID_STATUSES, 'status');
    } else if (argument.startsWith('--profile=')) {
      const value = argument.slice('--profile='.length);
      if (profileSpecified) throw new Error('--profile may only be specified once');
      if (!validProfiles.includes(value)) throw new Error(`invalid profile: ${value}`);
      options.profile = value;
      profileSpecified = true;
    } else if (argument.startsWith('--suite=')) {
      options.suites = optionValues(argument.slice('--suite='.length), VALID_SUITES, 'suite');
    } else if (argument.startsWith('--status=')) {
      options.statuses = optionValues(argument.slice('--status='.length), VALID_STATUSES, 'status');
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function selectTests(manifest, options, profiles = {}, relocations = {}) {
  const suites = new Set(options.suites);
  const statuses = new Set(options.statuses);
  let profileTests = null;
  if (options.profile) {
    const paths = profiles[options.profile];
    if (!Array.isArray(paths)) throw new Error(`invalid profile: ${options.profile}`);
    if (new Set(paths).size !== paths.length) {
      throw new Error(`profile ${options.profile} contains duplicate paths`);
    }
    const resolvedPaths = paths.map(testPath => relocations[testPath] || testPath);
    if (new Set(resolvedPaths).size !== resolvedPaths.length) {
      throw new Error(`profile ${options.profile} resolves duplicate destination`);
    }
    const manifestByPath = new Map(manifest.tests.map(item => [item.path, item]));
    profileTests = [];
    for (let index = 0; index < paths.length; index++) {
      const frozenPath = paths[index];
      const testPath = resolvedPaths[index];
      const item = manifestByPath.get(testPath);
      if (!item) throw new Error(`profile ${options.profile} references missing test: ${frozenPath}`);
      if (item.status !== 'active') {
        throw new Error(`profile ${options.profile} references non-active test: ${testPath}`);
      }
      if (item.orchestration) {
        throw new Error(`profile ${options.profile} references orchestration test: ${testPath}`);
      }
      profileTests.push(item);
    }
  }
  const candidates = profileTests || manifest.tests;
  const selected = candidates
    .filter(item =>
      !item.orchestration &&
      suites.has(item.suite) &&
      statuses.has(item.status)
    );
  return profileTests
    ? selected
    : selected.slice().sort((left, right) => left.path.localeCompare(right.path));
}

function defaultResolvePackage(packageName, repoRoot) {
  return require.resolve(packageName, { paths: [repoRoot] });
}

function preflightTests(tests, options) {
  const environment = options.environment || process.env;
  const repoRoot = path.resolve(options.repoRoot);
  const resolvePackage = options.resolvePackage || defaultResolvePackage;
  const errors = [];

  for (const item of tests) {
    for (const requirement of item.requirements.environment || []) {
      if (requirement.required && !environment[requirement.name]) {
        errors.push(`${item.path}: missing required environment variable ${requirement.name}`);
      }
    }
    for (const requirement of item.requirements.packages || []) {
      if (!requirement.required) continue;
      try {
        resolvePackage(requirement.name, repoRoot);
      } catch (_) {
        errors.push(`${item.path}: missing required package ${requirement.name}`);
      }
    }
  }

  if (errors.length) {
    throw new Error(`test preflight failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
  }
}

function runTests(tests, options) {
  const repoRoot = path.resolve(options.repoRoot);
  const environment = options.environment || process.env;
  const spawn = options.spawnSync || spawnSync;
  const writeError = options.writeError || (message => process.stderr.write(message));
  const writeOutput = options.writeOutput || (message => process.stdout.write(message));

  for (const item of tests) {
    const [executable, ...argv] = item.command;
    const childEnvironment = { ...environment };
    for (const flag of item.requirements.flags || []) {
      if (flag.enabled) childEnvironment[flag.name] = flag.value;
    }
    writeOutput(`\n══ ${item.path} ══\n`);
    const result = spawn(executable, argv, {
      cwd: repoRoot,
      env: childEnvironment,
      shell: false,
      stdio: 'inherit',
    });
    if (result.error) {
      writeError(`Failed to start ${item.path}: ${result.error.message}\n`);
      return 1;
    }
    if (result.status !== 0) return Number.isInteger(result.status) ? result.status : 1;
  }
  return 0;
}

function dispatchTests(tests, options, dependencies = {}) {
  // List/dry-run are inventory queries: zero matches is a valid empty result.
  // Execution must never report success without running any selected tests.
  const writeOutput = dependencies.writeOutput || (message => process.stdout.write(message));
  if (options.list) {
    tests.forEach(item => writeOutput(`${item.path}\n`));
    return 0;
  }
  if (options.dryRun) {
    tests.forEach(item => writeOutput(`${JSON.stringify({
      path: item.path,
      suite: item.suite,
      status: item.status,
      command: item.command,
      flags: item.requirements.flags || [],
    })}\n`));
    return 0;
  }
  if (!tests.length) throw new Error('no tests selected for execution');
  // This frozen CI profile promises the full canonical browser test set.
  // Keep explicit name filters available to non-canonical diagnostic callers.
  const execution = { ...dependencies };
  if (options.profile === 'ci-e2e-phase') {
    execution.environment = { ...(dependencies.environment || process.env) };
    delete execution.environment.E2E_TEST_FILTER;
  }
  const preflight = dependencies.preflight || preflightTests;
  const run = dependencies.run || runTests;
  preflight(tests, execution);
  return run(tests, execution);
}

function main() {
  const repoRoot = path.resolve(__dirname, '../..');
  try {
    const manifestPath = path.join(repoRoot, 'tests/manifest.json');
    const inventoryPath = path.join(repoRoot, 'tests/legacy-runner-inventory.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    const profiles = inventory.executedRootTests;
    const options = parseArguments(process.argv.slice(2), Object.keys(profiles));
    const validationErrors = validateManifest(manifest, { repoRoot });
    if (validationErrors.length) {
      throw new Error(`manifest validation failed:\n${validationErrors.map(error => `- ${error}`).join('\n')}`);
    }
    const tests = selectTests(manifest, options, profiles, inventory.relocations);
    return dispatchTests(tests, options, {
      repoRoot,
      environment: process.env,
    });
  } catch (error) {
    console.error(`Test runner failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = {
  dispatchTests,
  parseArguments,
  preflightTests,
  runTests,
  selectTests,
};
