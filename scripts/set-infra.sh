#!/bin/sh
# set-infra.sh — mark/unmark a node as Infrastructure in the CoreScope DB.
#
# Infrastructure nodes are operator-curated: well-placed community
# deployments (towers, mountain peaks) that anchor network connectivity.
# The flag lives in the `infrastructure` column on nodes/inactive_nodes
# (added by dbschema migration nodes_infrastructure_v1; the ingestor
# applies it at boot). The server exposes it on /api/nodes.
#
# This is an admin CLI, not part of the server: the read/write invariant
# (#1283) only forbids writes from cmd/server. A short UPDATE with
# busy_timeout coexists fine with the ingestor's WAL writer.
#
# Usage:
#   scripts/set-infra.sh <db-path> list
#   scripts/set-infra.sh <db-path> <pubkey-or-prefix> on
#   scripts/set-infra.sh <db-path> <pubkey-or-prefix> off
#
# <pubkey-or-prefix> is hex; a prefix is accepted when it matches exactly
# one node across nodes + inactive_nodes.
#
# Requires: POSIX sh, sqlite3.

set -u

usage() {
    echo "usage: $0 <db-path> list" >&2
    echo "       $0 <db-path> <pubkey-or-prefix> on|off" >&2
    exit 2
}

[ $# -ge 2 ] || usage

DB="$1"

if [ ! -f "$DB" ]; then
    echo "error: DB not found: $DB" >&2
    exit 1
fi

SQL() {
    # -bail: stop on first error. .timeout so we wait out the ingestor's
    # write transactions instead of failing with SQLITE_BUSY (the dot
    # command is silent, unlike PRAGMA busy_timeout which echoes a row).
    sqlite3 -bail -cmd ".timeout 5000" "$DB" "$1"
}

# The column is created by the ingestor's dbschema.Apply at boot. Guard
# so a stale DB gives an actionable error instead of a SQL error.
if ! sqlite3 "$DB" "PRAGMA table_info(nodes)" | awk -F'|' '{print $2}' | grep -qx "infrastructure"; then
    echo "error: nodes.infrastructure column missing — restart the ingestor (or run cmd/migrate) to apply migration nodes_infrastructure_v1 first" >&2
    exit 1
fi

if [ "$2" = "list" ]; then
    echo "Infrastructure nodes (active):"
    SQL "SELECT '  ' || public_key || '  ' || COALESCE(name,'(unnamed)') || '  role=' || COALESCE(role,'?') || '  last_seen=' || COALESCE(last_seen,'?') FROM nodes WHERE infrastructure = 1 ORDER BY name"
    echo "Infrastructure nodes (inactive):"
    SQL "SELECT '  ' || public_key || '  ' || COALESCE(name,'(unnamed)') || '  role=' || COALESCE(role,'?') || '  last_seen=' || COALESCE(last_seen,'?') FROM inactive_nodes WHERE infrastructure = 1 ORDER BY name"
    exit 0
fi

[ $# -eq 3 ] || usage

KEY="$2"
ACTION="$3"

case "$ACTION" in
    on)  VAL=1 ;;
    off) VAL=0 ;;
    *)   usage ;;
esac

# Validate hex before interpolating into SQL — the pubkey is the only
# user-supplied value that reaches a query string.
case "$KEY" in
    *[!0-9a-fA-F]*|'')
        echo "error: pubkey must be hex, got: $KEY" >&2
        exit 1
        ;;
esac
KEY=$(printf '%s' "$KEY" | tr 'A-F' 'a-f')

# Resolve prefix → exactly one pubkey across both tables.
MATCHES=$(SQL "SELECT public_key FROM (
    SELECT public_key FROM nodes WHERE lower(public_key) LIKE '$KEY%'
    UNION
    SELECT public_key FROM inactive_nodes WHERE lower(public_key) LIKE '$KEY%'
) ORDER BY public_key")

COUNT=$(printf '%s' "$MATCHES" | grep -c . || true)

if [ "$COUNT" -eq 0 ]; then
    echo "error: no node matches pubkey prefix: $KEY" >&2
    exit 1
fi
if [ "$COUNT" -gt 1 ]; then
    echo "error: pubkey prefix is ambiguous ($COUNT matches):" >&2
    printf '%s\n' "$MATCHES" | sed 's/^/  /' >&2
    exit 1
fi

PK="$MATCHES"
NAME=$(SQL "SELECT COALESCE(name,'(unnamed)') FROM nodes WHERE public_key = '$PK'
            UNION ALL
            SELECT COALESCE(name,'(unnamed)') FROM inactive_nodes WHERE public_key = '$PK'
            LIMIT 1")

SQL "UPDATE nodes SET infrastructure = $VAL WHERE public_key = '$PK';
     UPDATE inactive_nodes SET infrastructure = $VAL WHERE public_key = '$PK';"

echo "infrastructure=$ACTION  $PK  $NAME"
