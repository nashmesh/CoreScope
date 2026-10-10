#!/bin/sh
# Compatibility entry point. Root test selection lives in tests/manifest.json.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$REPO_ROOT"

# Guard the inventory and runner before trusting either to select tests.
npm run test:manifest
node scripts/tests/run-manifest.js --profile local-package-and-test-all "$@"
npm run test:mini-markdown-security

# Preserve the historical non-root infrastructure CLI gate. It is not part of
# the root-level test*.js/test*.sh manifest inventory.
case " $* " in
  *" --list "*|*" --dry-run "*) ;;
  *) sh scripts/test-set-infra.sh ;;
esac
