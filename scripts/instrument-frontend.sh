#!/bin/sh
# Instrument frontend JS for coverage tracking
set -eu
INSTRUMENTED_DIR=${INSTRUMENTED_DIR:-public-instrumented}
if [ -e "$INSTRUMENTED_DIR" ] || [ -L "$INSTRUMENTED_DIR" ]; then
  printf 'ERROR: instrumented frontend target already exists: %s\n' "$INSTRUMENTED_DIR" >&2
  exit 1
fi
npx nyc instrument public/ "$INSTRUMENTED_DIR" --compact=false
# Replace only nyc's generated global lookup: strict CSP disallows new Function,
# while globalThis preserves the browser coverage object and counter semantics.
node - "$INSTRUMENTED_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const directory = process.argv[2];
for (const name of fs.readdirSync(directory)) {
  if (!name.endsWith('.js')) continue;
  const file = path.join(directory, name);
  const source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, source.replaceAll('var global = new Function("return this")();', 'var global = globalThis;'));
}
NODE
# Copy non-JS files (CSS, HTML, images) as-is
cp public/*.css "$INSTRUMENTED_DIR/" 2>/dev/null
cp public/*.html "$INSTRUMENTED_DIR/" 2>/dev/null
cp public/*.svg "$INSTRUMENTED_DIR/" 2>/dev/null
cp public/*.png "$INSTRUMENTED_DIR/" 2>/dev/null
# Copy nested asset directories (e.g. public/img/*.svg used by the new
# CoreScope logo + hero). nyc instrument skips non-JS subdirs entirely,
# so without this the SPA fallback would serve index.html for
# `/img/corescope-logo.svg`, breaking the navbar logo + the
# logo-rebrand E2E (the content-type assertion catches this cleanly).
if [ -d public/img ]; then
  mkdir -p "$INSTRUMENTED_DIR/img"
  cp -r public/img/. "$INSTRUMENTED_DIR/img/"
fi
# Copy webfonts (e.g. public/fonts/aldrich-regular.woff2 used by the
# navbar logo SVG @font-face, #1137 follow-up). Same SPA-fallback gotcha
# as /img — without this, GET /fonts/aldrich-regular.woff2 returns
# index.html and the @font-face download fails silently, so the logo
# falls back to monospace and the Aldrich E2E assertion fails.
if [ -d public/fonts ]; then
  mkdir -p "$INSTRUMENTED_DIR/fonts"
  cp -r public/fonts/. "$INSTRUMENTED_DIR/fonts/"
fi
# Copy Phosphor icon sprite (#1648 M1). Same SPA-fallback gotcha as /img —
# without this, GET /icons/phosphor-sprite.svg returns index.html and every
# <use href="/icons/phosphor-sprite.svg#ph-…"> shows a broken icon.
if [ -d public/icons ]; then
  mkdir -p "$INSTRUMENTED_DIR/icons"
  cp -r public/icons/. "$INSTRUMENTED_DIR/icons/"
fi
# Copy vendored libraries unmodified — `nyc instrument` skips subdirectories
# without a package.json, so vendor/qrcode.js, vendor/jsqr.min.js, etc. are
# never emitted into public-instrumented/. Without them the SPA fallback
# returns index.html for `<script src="vendor/qrcode.js">`, producing
# "Unexpected token '<'" pageerrors and a missing `qrcode` global —
# which makes the QR Generate path hit the "[QR library not loaded]"
# fallback in channel-qr.js (issue #1087 bug 1 manifests in CI only).
mkdir -p "$INSTRUMENTED_DIR/vendor"
cp public/vendor/* "$INSTRUMENTED_DIR/vendor/" 2>/dev/null
echo "Frontend instrumented successfully"
