#!/bin/sh
# Combined Go and instrumented-frontend coverage for CoreScope.
set -eu

SCRIPT_PATH=$0
while [ -L "$SCRIPT_PATH" ]; do
  LINK_TARGET=$(readlink "$SCRIPT_PATH")
  case "$LINK_TARGET" in
    /*) SCRIPT_PATH=$LINK_TARGET ;;
    *) SCRIPT_PATH=$(dirname -- "$SCRIPT_PATH")/$LINK_TARGET ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)
COMBINED_COVERAGE_REPO_ROOT=${COMBINED_COVERAGE_REPO_ROOT:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}
export COMBINED_COVERAGE_REPO_ROOT
. "$SCRIPT_DIR/combined-coverage-lib.sh"
main "$@"
