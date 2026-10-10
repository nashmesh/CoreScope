#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VALID_SUITES = new Set(['unit', 'integration', 'e2e']);
const VALID_STATUSES = new Set(['active', 'dormant']);
const PLAYWRIGHT_IMPORT = /(?:require\s*\(\s*['"](?:@playwright\/test|playwright(?:\/test)?)['"]\s*\)|from\s+['"](?:@playwright\/test|playwright(?:\/test)?)['"])/;
const PLAYWRIGHT_TEST_IMPORT = /(?:require\s*\(\s*['"]@playwright\/test['"]\s*\)|from\s+['"]@playwright\/test['"])/;
const JSDOM_IMPORT = /(?:require\s*\(\s*['"]jsdom['"]\s*\)|from\s+['"]jsdom['"])/;
const NO_BROWSER_EVIDENCE = /(?:without|does not|doesn't|no)\b[^.]*\bbrowser runner\b/i;
const STATUS_SURFACES = [
  'package.json',
  'test-all.sh',
  '.github/workflows/deploy.yml',
  'AGENTS.md',
  'README.md',
];
const DORMANT_EVIDENCE_DETAIL =
  'not listed in package.json, test-all.sh, .github/workflows/deploy.yml, AGENTS.md, or README.md';
const NO_INTEGRATION_EVIDENCE = /\b(?:unit|isolated|without integration|no integration)\b/i;
const FROZEN_INVENTORY_COMMIT = '0206b84c00c08bd30d13ef79b767614b55aa04ce';
const FROZEN_PROFILE_DIGESTS = new Map([
  ['ci-e2e-phase', '3d3f79731bb58b723d8f23a2fa428fb9b2df360c0941ba47718c7438702a0d75'],
  ['ci-unit-and-integration-phase', '22930740a0c192eb7b12efca345172d2def5ac1482dc116e848005e4bdd3d88f'],
  ['legacy-test-unit', 'deee9658f1e9dd6cacad06a5136a72eb945c074ed2743f7f275ffef096bb6bb3'],
  ['local-package-and-test-all', '923b599550c2b7ce0fea68de475e981c1d6f38902e6c2d722407d672631584fe'],
]);

function trackedRootTests(repoRoot) {
  const output = execFileSync(
    'git',
    ['ls-files', '--', 'test*.js', 'test*.sh'],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(file => !file.includes('/'))
    .sort();
}

function validateEvidence(value, field, index, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`tests[${index}].${field} must be a non-empty array`);
    return;
  }
  value.forEach((item, evidenceIndex) => {
    const prefix = `tests[${index}].${field}[${evidenceIndex}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (typeof item.source !== 'string' || !item.source.trim()) {
      errors.push(`${prefix}.source must be a non-empty string`);
    }
    if (typeof item.detail !== 'string' || !item.detail.trim()) {
      errors.push(`${prefix}.detail must be a non-empty string`);
    }
  });
}

function validateRequirements(value, index, errors) {
  const prefix = `tests[${index}].requirements`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const field of ['environment', 'flags']) {
    if (!Array.isArray(value[field])) {
      errors.push(`${prefix}.${field} must be an array`);
      continue;
    }
    value[field].forEach((item, requirementIndex) => {
      const itemPrefix = `${prefix}.${field}[${requirementIndex}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`${itemPrefix} must be an object`);
        return;
      }
      if (typeof item.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(item.name)) {
        errors.push(`${itemPrefix}.name must be an uppercase environment name`);
      }
      if (typeof item.description !== 'string' || !item.description.trim()) {
        errors.push(`${itemPrefix}.description must be a non-empty string`);
      }
      if (field === 'environment' && typeof item.required !== 'boolean') {
        errors.push(`${itemPrefix}.required must be boolean`);
      }
      if (field === 'flags' && (typeof item.value !== 'string' || !item.value)) {
        errors.push(`${itemPrefix}.value must be a non-empty string`);
      }
      if (field === 'flags' && typeof item.enabled !== 'boolean') {
        errors.push(`${itemPrefix}.enabled must be boolean`);
      }
    });
  }
  if (value.packages !== undefined) {
    if (!Array.isArray(value.packages)) {
      errors.push(`${prefix}.packages must be an array`);
    } else {
      value.packages.forEach((item, requirementIndex) => {
        const itemPrefix = `${prefix}.packages[${requirementIndex}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`${itemPrefix} must be an object`);
          return;
        }
        if (typeof item.name !== 'string' || !item.name.trim()) {
          errors.push(`${itemPrefix}.name must be a non-empty package name`);
        }
        if (typeof item.required !== 'boolean') {
          errors.push(`${itemPrefix}.required must be boolean`);
        }
        if (typeof item.description !== 'string' || !item.description.trim()) {
          errors.push(`${itemPrefix}.description must be a non-empty string`);
        }
      });
    }
  }
}

function declaredPackages(repoRoot) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return new Set([
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.devDependencies || {}),
      ...Object.keys(packageJson.optionalDependencies || {}),
    ]);
  } catch (_) {
    return new Set();
  }
}

function hasRequiredPackage(requirements, packageName) {
  return Array.isArray(requirements && requirements.packages) &&
    requirements.packages.some(item => item && item.name === packageName && item.required === true);
}

function processEnvironmentNames(source) {
  if (typeof source !== 'string') return [];
  const names = new Set();
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
  for (const match of source.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) names.add(match[1]);
  for (const match of source.matchAll(/\{([^}]+)\}\s*=\s*process\.env\b/g)) {
    for (const binding of match[1].split(',')) {
      const name = binding.trim().replace(/^\.\.\./, '').split(/[:=]/, 1)[0].trim();
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

function declaredRequirementNames(requirements, field) {
  const names = new Set();
  const fields = field ? [field] : ['environment', 'flags'];
  for (const requirementField of fields) {
    if (!Array.isArray(requirements && requirements[requirementField])) continue;
    for (const item of requirements[requirementField]) {
      if (item && typeof item.name === 'string') names.add(item.name);
    }
  }
  return names;
}

function strictEnvironmentFlagNames(source) {
  const names = new Set();
  for (const name of processEnvironmentNames(source)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const access = `process\\.env(?:\\.${escaped}|\\[\\s*['\"]${escaped}['\"]\\s*\\])`;
    if (new RegExp(`${access}\\s*={2,3}\\s*['\"]1['\"]`).test(source) ||
        new RegExp(`['\"]1['\"]\\s*={2,3}\\s*${access}`).test(source)) {
      names.add(name);
    }
  }
  for (const match of source.matchAll(/\{([^}]+)\}\s*=\s*process\.env\b/g)) {
    for (const binding of match[1].split(',')) {
      const parts = binding.trim().replace(/^\.\.\./, '').split(':');
      const environmentName = parts[0].split('=')[0].trim();
      const localName = (parts[1] || parts[0]).split('=')[0].trim();
      if (!/^[A-Z][A-Z0-9_]*$/.test(environmentName) || !/^[A-Za-z_$][\w$]*$/.test(localName)) continue;
      const escapedLocal = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escapedLocal}\\s*={2,3}\\s*['\"]1['\"]`).test(source) ||
          new RegExp(`['\"]1['\"]\\s*={2,3}\\s*${escapedLocal}\\b`).test(source)) {
        names.add(environmentName);
      }
    }
  }
  return names;
}

function readStatusSurfaces(repoRoot) {
  return new Map(STATUS_SURFACES.map(surface => {
    try {
      return [surface, fs.readFileSync(path.join(repoRoot, surface), 'utf8')];
    } catch (_) {
      return [surface, ''];
    }
  }));
}

function readFrozenInventory(repoRoot) {
  const inventoryPath = path.join(repoRoot, 'tests/legacy-runner-inventory.json');
  try {
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    if (inventory.version !== 1 || !inventory.historicalStatusReferences ||
        !Array.isArray(inventory.orchestrationRootTests) ||
        !inventory.executedRootTests || typeof inventory.executedRootTests !== 'object' ||
        Array.isArray(inventory.executedRootTests)) {
      throw new Error('unsupported or incomplete inventory');
    }
    if (inventory.capturedAtCommit !== FROZEN_INVENTORY_COMMIT) {
      throw new Error(`capturedAtCommit must equal ${FROZEN_INVENTORY_COMMIT}`);
    }
    const profileNames = Object.keys(inventory.executedRootTests).sort();
    const expectedProfileNames = [...FROZEN_PROFILE_DIGESTS.keys()].sort();
    if (!sameStringSet(profileNames, expectedProfileNames)) {
      throw new Error('executedRootTests profile names do not match the frozen baseline');
    }
    for (const [profileName, expectedDigest] of FROZEN_PROFILE_DIGESTS) {
      const paths = inventory.executedRootTests[profileName];
      if (!Array.isArray(paths) || paths.some(testPath =>
        typeof testPath !== 'string' || !/^test[^/\\]*\.(?:js|sh)$/.test(testPath))) {
        throw new Error(`invalid executedRootTests.${profileName}`);
      }
      if (new Set(paths).size !== paths.length) {
        throw new Error(`duplicate path in executedRootTests.${profileName}`);
      }
      const digest = crypto.createHash('sha256').update(`${paths.join('\n')}\n`).digest('hex');
      if (digest !== expectedDigest) {
        throw new Error(`executedRootTests.${profileName} does not match the frozen baseline`);
      }
    }
    const references = new Map(STATUS_SURFACES.map(surface => {
      const paths = inventory.historicalStatusReferences[surface];
      if (!Array.isArray(paths) || paths.some(testPath => typeof testPath !== 'string')) {
        throw new Error(`invalid historicalStatusReferences.${surface}`);
      }
      return [surface, new Set(paths)];
    }));
    const capturedPaths = new Set(execFileSync(
      'git',
      ['ls-tree', '--name-only', FROZEN_INVENTORY_COMMIT],
      { cwd: repoRoot, encoding: 'utf8' }
    ).split(/\r?\n/).filter(testPath => /^test[^/\\]*\.(?:js|sh)$/.test(testPath)));
    return {
      profiles: inventory.executedRootTests,
      references,
      orchestration: new Set(inventory.orchestrationRootTests),
      capturedPaths,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot read frozen test inventory: ${error.message}`);
  }
}

function sameStringSet(left, right) {
  return left.length === right.length &&
    new Set(left).size === left.length &&
    left.every(value => right.includes(value));
}

function hasIntegrationBehavior(testPath, source) {
  if (typeof source !== 'string') return false;
  if (testPath.endsWith('.sh')) {
    return /(?:^|\n)\s*(?:node|sh|bash)\s+(?:\.\/)?test[^\s]*/m.test(source) ||
      /(?:^|[^A-Za-z0-9_])(?:\.\/)?scripts\/[A-Za-z0-9_.\/-]+/.test(source);
  }
  if (testPath.endsWith('.js')) {
    const importsChildProcess = /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)|from\s+['"](?:node:)?child_process['"]/.test(source);
    const invokesChildProcess = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(source);
    return importsChildProcess && invokesChildProcess;
  }
  return false;
}

function hasCanonicalCommand(command, testPath) {
  if (!Array.isArray(command) || typeof testPath !== 'string') return false;
  if (testPath.endsWith('.sh')) {
    return command.length === 2 &&
      (command[0] === 'sh' || command[0] === 'bash') && command[1] === testPath;
  }
  if (!testPath.endsWith('.js')) return false;
  return (command.length === 2 && command[0] === 'node' && command[1] === testPath) ||
    (command.length === 4 && command[0] === 'npx' && command[1] === 'playwright' &&
      command[2] === 'test' && command[3] === testPath);
}

function hasCanonicalPlaywrightCommand(command, testPath) {
  return Array.isArray(command) && command.length === 4 && command[0] === 'npx' &&
    command[1] === 'playwright' && command[2] === 'test' && command[3] === testPath;
}

function validateManifest(manifest, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '../..'));
  const tracked = (options.trackedRootTests || trackedRootTests(repoRoot)).slice().sort();
  const trackedSet = new Set(tracked);
  const packages = declaredPackages(repoRoot);
  const frozenInventory = options.frozenInventory !== undefined
    ? options.frozenInventory
    : readFrozenInventory(repoRoot);
  const statusSurfaces = readStatusSurfaces(repoRoot);
  const errors = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest must be an object'];
  }
  if (manifest.version !== 1) {
    errors.push('manifest.version must equal 1');
  }
  if (!Array.isArray(manifest.tests)) {
    errors.push('manifest.tests must be an array');
    return errors;
  }

  const counts = new Map();
  manifest.tests.forEach((item, index) => {
    const prefix = `tests[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${prefix} must be an object`);
      return;
    }

    let source = null;
    if (typeof item.path !== 'string' || !/^test[^/\\]*\.(?:js|sh)$/.test(item.path)) {
      errors.push(`${prefix}.path must be a root-level test*.js or test*.sh path`);
    } else {
      counts.set(item.path, (counts.get(item.path) || 0) + 1);
      const resolvedPath = path.resolve(repoRoot, item.path);
      let isRegularContainedFile = path.dirname(resolvedPath) === repoRoot;
      try {
        isRegularContainedFile = isRegularContainedFile &&
          fs.lstatSync(resolvedPath).isFile() &&
          path.dirname(fs.realpathSync(resolvedPath)) === fs.realpathSync(repoRoot);
      } catch (_) {
        isRegularContainedFile = false;
      }
      if (!fs.existsSync(resolvedPath)) {
        errors.push(`path does not exist: ${item.path}`);
      } else if (!isRegularContainedFile) {
        errors.push(`${prefix}.path must resolve to a regular file directly under repoRoot`);
      } else {
        source = fs.readFileSync(resolvedPath, 'utf8');
      }
    }

    if (!VALID_SUITES.has(item.suite)) {
      errors.push(`${prefix} has invalid suite: ${String(item.suite)}`);
    }
    if (!VALID_STATUSES.has(item.status)) {
      errors.push(`${prefix} has invalid status: ${String(item.status)}`);
    }
    if (!Array.isArray(item.command) || item.command.length === 0 ||
        item.command.some(part => typeof part !== 'string' || !part.trim())) {
      errors.push(`${prefix}.command must be a non-empty argv array of non-empty strings`);
    } else if (!hasCanonicalCommand(item.command, item.path)) {
      errors.push(`${prefix}.command must use a canonical runner shape with its test path in the expected position`);
    }

    validateRequirements(item.requirements, index, errors);
    validateEvidence(item.statusEvidence, 'statusEvidence', index, errors);
    validateEvidence(item.classificationEvidence, 'classificationEvidence', index, errors);

    if (source) {
      const declaredEnvironment = declaredRequirementNames(item.requirements, 'environment');
      const declaredFlags = declaredRequirementNames(item.requirements, 'flags');
      const strictFlags = strictEnvironmentFlagNames(source);
      for (const name of processEnvironmentNames(source)) {
        if (strictFlags.has(name)) {
          if (!declaredFlags.has(name)) {
            errors.push(`${prefix} process.env variable ${name} must be declared in requirements.flags`);
          }
        } else if (!declaredEnvironment.has(name)) {
          errors.push(`${prefix} process.env variable ${name} must be declared in requirements.environment`);
        }
      }
    }

    if (typeof item.path === 'string' && VALID_STATUSES.has(item.status)) {
      const isCapturedPath = frozenInventory && frozenInventory.capturedPaths.has(item.path);
      const referencingSurfaces = STATUS_SURFACES.filter(surface =>
        isCapturedPath
          ? frozenInventory.references.get(surface).has(item.path)
          : statusSurfaces.get(surface).includes(item.path)
      );
      if (isCapturedPath) {
        const expectedOrchestration = frozenInventory.orchestration.has(item.path);
        if ((item.orchestration === true) !== expectedOrchestration) {
          errors.push(`${prefix}.orchestration marker must match the frozen inventory`);
        }
      } else if (item.orchestration !== undefined && typeof item.orchestration !== 'boolean') {
        errors.push(`${prefix}.orchestration must be boolean when present`);
      }
      if (item.status === 'active') {
        if (referencingSurfaces.length === 0) {
          errors.push(`${prefix} must use status dormant because it is absent from all declared surfaces`);
        }
        if (Array.isArray(item.statusEvidence)) {
          const evidenceSources = item.statusEvidence.map(evidence => evidence && evidence.source);
          if (!sameStringSet(evidenceSources, referencingSurfaces)) {
            errors.push(`${prefix}.statusEvidence sources must exactly match the declared surfaces that reference ${item.path}`);
          }
        }
      } else {
        if (referencingSurfaces.length > 0) {
          errors.push(`${prefix} is referenced by declared surface ${referencingSurfaces[0]} and must use status active`);
        }
        if (!Array.isArray(item.statusEvidence) || item.statusEvidence.length !== 1 ||
            !item.statusEvidence[0] || item.statusEvidence[0].source !== 'inventory audit' ||
            item.statusEvidence[0].detail !== DORMANT_EVIDENCE_DETAIL) {
          errors.push(`${prefix}.statusEvidence must use the canonical inventory-audit evidence for a dormant test`);
        }
      }
    }

    if (source && PLAYWRIGHT_IMPORT.test(source)) {
      if (item.suite !== 'e2e') {
        errors.push(`${prefix} Playwright source must use suite e2e`);
      }
      if (Array.isArray(item.classificationEvidence) && item.classificationEvidence.some(
        evidence => evidence && typeof evidence.detail === 'string' &&
          NO_BROWSER_EVIDENCE.test(evidence.detail)
      )) {
        errors.push(`${prefix}.classificationEvidence contradicts the Playwright source`);
      }
      if (PLAYWRIGHT_TEST_IMPORT.test(source) && !packages.has('@playwright/test') &&
          !hasRequiredPackage(item.requirements, '@playwright/test')) {
        errors.push(`${prefix} must declare required package @playwright/test because it is not in package.json`);
      }
      if (PLAYWRIGHT_TEST_IMPORT.test(source) &&
          !hasCanonicalPlaywrightCommand(item.command, item.path)) {
        errors.push(`${prefix} must use the canonical Playwright runner command`);
      }
    }
    if (source && JSDOM_IMPORT.test(source) && !packages.has('jsdom') &&
        !hasRequiredPackage(item.requirements, 'jsdom')) {
      errors.push(`${prefix} must declare required package jsdom because it is not in package.json`);
    }
    if (source && !PLAYWRIGHT_IMPORT.test(source) && hasIntegrationBehavior(item.path, source)) {
      if (item.suite !== 'integration') {
        errors.push(`${prefix} integration behavior must use suite integration`);
      }
      if (Array.isArray(item.classificationEvidence)) {
        if (!item.classificationEvidence.some(evidence => evidence && evidence.source === item.path)) {
          errors.push(`${prefix}.classificationEvidence must cite the test path for detected integration behavior`);
        }
        if (item.classificationEvidence.some(evidence => evidence &&
            typeof evidence.detail === 'string' && NO_INTEGRATION_EVIDENCE.test(evidence.detail))) {
          errors.push(`${prefix}.classificationEvidence contradicts detected integration behavior`);
        }
      }
    }
  });

  for (const [testPath, count] of counts) {
    if (count > 1) errors.push(`duplicate path: ${testPath}`);
  }
  const listed = new Set(counts.keys());
  tracked.forEach(testPath => {
    if (!listed.has(testPath)) errors.push(`missing tracked root test: ${testPath}`);
  });
  listed.forEach(testPath => {
    if (!trackedSet.has(testPath)) errors.push(`untracked root test: ${testPath}`);
  });
  if (frozenInventory) {
    const manifestByPath = new Map(manifest.tests
      .filter(item => item && typeof item.path === 'string')
      .map(item => [item.path, item]));
    for (const [profileName, paths] of Object.entries(frozenInventory.profiles)) {
      for (const testPath of paths) {
        const item = manifestByPath.get(testPath);
        if (!item) {
          errors.push(`execution profile ${profileName} references missing manifest path: ${testPath}`);
        } else if (item.status !== 'active') {
          errors.push(`execution profile ${profileName} references non-active test: ${testPath}`);
        } else if (item.orchestration) {
          errors.push(`execution profile ${profileName} references orchestration test: ${testPath}`);
        }
      }
    }
  }

  return errors;
}

function main() {
  const repoRoot = path.resolve(__dirname, '../..');
  const manifestPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(repoRoot, 'tests/manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`Test manifest validation failed: ${error.message}`);
    process.exit(1);
  }

  const errors = validateManifest(manifest, { repoRoot });
  if (errors.length) {
    console.error(`Test manifest validation failed with ${errors.length} error(s):`);
    errors.forEach(error => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log(`Test manifest valid: ${manifest.tests.length} tracked root test runners.`);
}

if (require.main === module) main();

module.exports = { trackedRootTests, validateManifest };
