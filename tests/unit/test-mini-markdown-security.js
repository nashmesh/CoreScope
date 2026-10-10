#!/usr/bin/env node
'use strict';
const { fromRepositoryRoot } = require('../helpers/repository-root');

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = {
  window: {},
  document: {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
    documentElement: { style: { getPropertyValue: () => '' } },
  },
  console,
  fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(fromRepositoryRoot('public', 'roles.js'), 'utf8'), context);

const miniMarkdown = context.window.miniMarkdown;
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ❌ ${name}: ${error.message}`);
  }
}

console.log('\n=== miniMarkdown link security ===');

test('escapes quotes in Markdown link URLs to prevent attribute breakout', () => {
  const html = miniMarkdown('[click](x" autofocus onfocus="evil)');
  assert.ok(!/"\s+autofocus\b/i.test(html), `attribute breakout survived: ${html}`);
  assert.ok(html.includes('href="x&quot; autofocus onfocus=&quot;evil"'), `URL was not attribute-escaped: ${html}`);
});

test('neutralizes dangerous URL protocols despite casing or ASCII whitespace', () => {
  const dangerousUrls = [
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,payload',
    'vbscript:msgbox(1)',
  ];

  for (const url of dangerousUrls) {
    const html = miniMarkdown(`[click](${url})`);
    assert.ok(!/<a\b/i.test(html), `dangerous URL rendered as a link (${JSON.stringify(url)}): ${html}`);
    assert.ok(html.includes('click'), `link text was lost for ${JSON.stringify(url)}: ${html}`);
  }
});

test('preserves safe HTTPS, relative, and hash links with opener protection', () => {
  const safeUrls = ['https://example.com/docs?q=1&lang=en', '/docs/start', '../status', '#top'];

  for (const url of safeUrls) {
    const html = miniMarkdown(`[docs](${url})`);
    assert.ok(html.startsWith('<a href="'), `safe URL was not linked (${url}): ${html}`);
    assert.ok(html.includes('target="_blank"'), `target contract changed (${url}): ${html}`);
    assert.ok(html.includes('rel="noopener"'), `noopener contract changed (${url}): ${html}`);
  }
});

test('escapes markup in link text', () => {
  const html = miniMarkdown('[<img src=x onerror=evil>](https://example.com)');
  assert.ok(!/<img\b/i.test(html), `link text created markup: ${html}`);
  assert.ok(html.includes('&lt;img src=x onerror=evil&gt;'), `link text was not escaped: ${html}`);
});

test('preserves ordinary bold, italic, code, and list Markdown', () => {
  const html = miniMarkdown('**bold** *italic* `code`\n- one\n- two');
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>italic</em>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<ul><li>one</li></ul>'));
  assert.ok(html.includes('<li>two</li>'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
