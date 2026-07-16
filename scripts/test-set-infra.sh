#!/bin/sh
# test-set-infra.sh — tests for scripts/set-infra.sh against a temp DB.
# Requires: POSIX sh, sqlite3. Run from anywhere.

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$DIR/set-infra.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
DB="$TMP/test.db"

FAIL=0
fail() { echo "FAIL: $1" >&2; FAIL=1; }
pass() { echo "ok: $1"; }

# Schema mirrors nodes/inactive_nodes post nodes_infrastructure_v1.
sqlite3 "$DB" <<'EOF'
CREATE TABLE nodes (
    public_key TEXT PRIMARY KEY, name TEXT, role TEXT,
    lat REAL, lon REAL, last_seen TEXT, first_seen TEXT,
    advert_count INTEGER DEFAULT 0, battery_mv INTEGER, temperature_c REAL,
    foreign_advert INTEGER DEFAULT 0,
    infrastructure INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE inactive_nodes (
    public_key TEXT PRIMARY KEY, name TEXT, role TEXT,
    lat REAL, lon REAL, last_seen TEXT, first_seen TEXT,
    advert_count INTEGER DEFAULT 0, battery_mv INTEGER, temperature_c REAL,
    foreign_advert INTEGER DEFAULT 0,
    infrastructure INTEGER NOT NULL DEFAULT 0
);
INSERT INTO nodes (public_key, name, role) VALUES
    ('aabb0011223344556677889900112233', 'Tower One', 'repeater'),
    ('aacc0011223344556677889900112233', 'Tower Two', 'repeater'),
    ('ddee0011223344556677889900112233', 'Valley',    'companion');
INSERT INTO inactive_nodes (public_key, name, role) VALUES
    ('ff000011223344556677889900112233', 'Old Peak', 'repeater');
EOF

# 1. Mark by unique prefix.
if "$SCRIPT" "$DB" ddee on >/dev/null 2>&1; then
    got=$(sqlite3 "$DB" "SELECT infrastructure FROM nodes WHERE public_key LIKE 'ddee%'")
    [ "$got" = "1" ] && pass "set on by unique prefix" || fail "expected infrastructure=1, got $got"
else
    fail "set on by unique prefix exited non-zero"
fi

# 2. Ambiguous prefix must fail and change nothing.
if "$SCRIPT" "$DB" aa on >/dev/null 2>&1; then
    fail "ambiguous prefix should exit non-zero"
else
    got=$(sqlite3 "$DB" "SELECT COUNT(*) FROM nodes WHERE public_key LIKE 'aa%' AND infrastructure = 1")
    [ "$got" = "0" ] && pass "ambiguous prefix rejected" || fail "ambiguous prefix mutated rows"
fi

# 3. Unknown prefix must fail.
"$SCRIPT" "$DB" 9999 on >/dev/null 2>&1 && fail "unknown prefix should exit non-zero" || pass "unknown prefix rejected"

# 4. Non-hex input must fail (SQL injection guard).
"$SCRIPT" "$DB" "x' OR 1=1 --" on >/dev/null 2>&1 && fail "non-hex input should exit non-zero" || pass "non-hex input rejected"

# 5. Inactive nodes are addressable too; uppercase prefix accepted.
if "$SCRIPT" "$DB" FF00 on >/dev/null 2>&1; then
    got=$(sqlite3 "$DB" "SELECT infrastructure FROM inactive_nodes WHERE public_key LIKE 'ff00%'")
    [ "$got" = "1" ] && pass "inactive node marked via uppercase prefix" || fail "inactive node not marked, got $got"
else
    fail "marking inactive node exited non-zero"
fi

# 6. list shows both marked nodes.
LIST=$("$SCRIPT" "$DB" list)
echo "$LIST" | grep -q "Valley"   || fail "list missing active infra node"
echo "$LIST" | grep -q "Old Peak" || fail "list missing inactive infra node"
echo "$LIST" | grep -q "Tower"    && fail "list contains unmarked node" || pass "list shows exactly the marked nodes"

# 7. off unmarks.
if "$SCRIPT" "$DB" ddee off >/dev/null 2>&1; then
    got=$(sqlite3 "$DB" "SELECT infrastructure FROM nodes WHERE public_key LIKE 'ddee%'")
    [ "$got" = "0" ] && pass "set off" || fail "expected infrastructure=0, got $got"
else
    fail "set off exited non-zero"
fi

# 8. Missing column gives actionable error.
DB2="$TMP/stale.db"
sqlite3 "$DB2" "CREATE TABLE nodes (public_key TEXT PRIMARY KEY, name TEXT); CREATE TABLE inactive_nodes (public_key TEXT PRIMARY KEY, name TEXT);"
OUT=$("$SCRIPT" "$DB2" ddee on 2>&1) && fail "stale DB should exit non-zero" || true
echo "$OUT" | grep -q "nodes_infrastructure_v1" && pass "stale DB error mentions migration" || fail "stale DB error not actionable: $OUT"

if [ "$FAIL" -ne 0 ]; then
    echo "test-set-infra: FAILED" >&2
    exit 1
fi
echo "test-set-infra: all tests passed"
