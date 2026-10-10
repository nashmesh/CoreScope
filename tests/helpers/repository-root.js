'use strict';

const path = require('path');

const repositoryRoot = path.resolve(__dirname, '../..');

function fromRepositoryRoot(...segments) {
  return path.join(repositoryRoot, ...segments);
}

module.exports = { repositoryRoot, fromRepositoryRoot };
