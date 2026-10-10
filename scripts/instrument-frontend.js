'use strict';

const fs = require('fs');
const path = require('path');
const { createInstrumenter } = require('istanbul-lib-instrument');

const [sourceDirectory = 'public', targetDirectory = 'public-instrumented'] = process.argv.slice(2);
const sourceRoot = path.resolve(sourceDirectory);
const targetRoot = path.resolve(targetDirectory);

fs.mkdirSync(targetRoot, { recursive: true });

for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
  if (!entry.isFile() || path.extname(entry.name) !== '.js') continue;

  const sourcePath = path.join(sourceRoot, entry.name);
  const targetPath = path.join(targetRoot, entry.name);
  const instrumenter = createInstrumenter({
    compact: false,
    coverageGlobalScope: 'window',
    coverageGlobalScopeFunc: false,
    preserveComments: true,
  });
  const source = fs.readFileSync(sourcePath, 'utf8');
  fs.writeFileSync(targetPath, instrumenter.instrumentSync(source, sourcePath));
}
