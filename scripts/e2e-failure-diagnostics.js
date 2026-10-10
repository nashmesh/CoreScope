'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

// Error messages (including stacks, URLs and custom codes) can contain private
// application data. Keep only known diagnostic categories, never arbitrary text.
const errorTypes = new Set([
  'Error', 'TimeoutError', 'TypeError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'URIError', 'EvalError', 'AggregateError',
]);
const requestErrors = new Set([
  'net::ERR_TIMED_OUT', 'net::ERR_ABORTED', 'net::ERR_FAILED',
  'net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED', 'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_NETWORK_CHANGED',
  'net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_DATE_INVALID',
  'net::ERR_CERT_COMMON_NAME_INVALID', 'net::ERR_SSL_PROTOCOL_ERROR',
]);
function errorType(error) {
  return errorTypes.has(error?.name) ? error.name : 'Error';
}

function probe(url) {
  return new Promise(resolve => {
    const locator = sanitizeURL(url);
    const failed = error => resolve(`${locator} error=${errorType(error)}`);
    try {
      const request = (url.startsWith('https:') ? https : http).get(url, { timeout: 2000 }, response => {
        response.resume();
        resolve(`${locator} status=${response.statusCode}`);
      });
      request.once('timeout', () => request.destroy(new Error('timeout')));
      request.once('error', failed);
    } catch (error) {
      failed(error);
    }
  });
}

function sanitizeURL(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[invalid URL]';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

function createFailureDiagnostics({ page, context, browser, cdp, baseUrl, outputDir, capacity = 100 }) {
  const events = [];
  const inFlightRequests = new Map();
  const record = (kind, fields = {}) => {
    const event = { at: new Date().toISOString(), kind, ...fields };
    events.push(event);
    if (events.length > capacity) events.shift();
    return event;
  };
  const describeRequest = request => ({
    url: sanitizeURL(request.url()),
    resourceType: request.resourceType(),
  });

  page.on('request', request => {
    const description = describeRequest(request);
    const event = record('request', description);
    inFlightRequests.set(request, { ...description, startedAt: event.at });
  });
  page.on('response', response => record('response', {
    url: sanitizeURL(response.url()),
    status: response.status(),
    resourceType: response.request().resourceType(),
  }));
  page.on('requestfinished', request => {
    inFlightRequests.delete(request);
    record('requestfinished', describeRequest(request));
  });
  page.on('requestfailed', request => {
    inFlightRequests.delete(request);
    const failure = request.failure()?.errorText;
    record('requestfailed', {
      ...describeRequest(request),
      error: requestErrors.has(failure) ? failure : 'unknown',
    });
  });
  page.on('pageerror', error => record('pageerror', { error: errorType(error) }));
  page.on('crash', () => record('crash'));
  page.on('close', () => record('close'));
  context.on('close', () => record('contextclose'));
  browser.on('disconnected', () => record('browserdisconnected'));
  if (cdp) cdp.on('Page.domContentEventFired', event => record('domcontentloaded', { timestamp: event.timestamp }));

  return {
    async capture({ test, error }) {
      if (!outputDir) return;
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'e2e-navigation-diagnostics.json'), JSON.stringify({
        capturedAt: new Date().toISOString(),
        baseUrl: sanitizeURL(baseUrl),
        test,
        error: errorType(error),
        events,
        inFlightRequests: [...inFlightRequests.values()],
      }, null, 2));
      const [root, health] = await Promise.all([
        probe(`${baseUrl}/`),
        probe(`${baseUrl}/api/healthz`),
      ]);
      fs.writeFileSync(path.join(outputDir, 'e2e-http-probes.txt'), `${root}\n${health}\n`);
    },
  };
}

module.exports = { createFailureDiagnostics };
