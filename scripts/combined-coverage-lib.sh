#!/bin/sh
# Combined Go and instrumented-frontend coverage for CoreScope.
set -eu

REPO_ROOT=${COMBINED_COVERAGE_REPO_ROOT:?COMBINED_COVERAGE_REPO_ROOT must be set by the coverage wrapper}
COVERAGE_DIR=${COVERAGE_DIR:-"$REPO_ROOT/coverage"}
case "$COVERAGE_DIR" in
  /*) ;;
  *) COVERAGE_DIR="$REPO_ROOT/$COVERAGE_DIR" ;;
esac
GO_COVERAGE_DIR="$COVERAGE_DIR/go"
FRONTEND_COVERAGE_DIR="$COVERAGE_DIR/frontend"
INSTRUMENTED_DIR="$REPO_ROOT/public-instrumented"
INSTRUMENTED_CREATED=0
PRUNE_REQUESTS_CREATED=0
NYC_OUTPUT_LINK_CREATED=0
NYC_OUTPUT_BACKUP=
WORK_DIR=
SERVER_PID=
ACTIVE_PID=
ACTIVE_DOCKER_CIDFILE=
ACTIVE_DOCKER_NAME=
ACTIVE_DOCKER_LABEL=
MODE=full
DRY_RUN=0
GO_IMAGE=${GO_IMAGE:-golang:1.22-bookworm}

usage() {
  cat <<'EOF'
Usage: sh scripts/combined-coverage.sh [OPTION]

Generate real CoreScope coverage reports for the current Go backend and,
by default, the instrumented static frontend.

Options:
  --go-only        run cmd/server and cmd/ingestor Go coverage only
  --frontend-only  build the Go server/migrator and run frontend coverage only
  --customizer-navigation-diagnostic
                   run only the Customizer v2 Playwright prefix against the
                   canonical seeded fixture with static request timing trace
  --dry-run        print the selected orchestration without changing files
  -h, --help       show this help

Environment:
  COVERAGE_PORT    localhost port for the temporary server (default: free port)
  COVERAGE_DIR     report directory (default: coverage)
  GO_IMAGE         fallback Docker image when go is unavailable
  COVERAGE_FORCE_DOCKER
                   use the Docker Go runner even when go is installed
  CHROMIUM_PATH    optional Playwright Chromium executable
EOF
}

log() {
  printf '%s\n' "$*"
}

reconcile_process_group() {
  process_group=$1
  if /bin/kill -0 -- "-$process_group" 2>/dev/null; then
    /bin/kill -TERM -- "-$process_group" 2>/dev/null || true
    cleanup_attempt=0
    while /bin/kill -0 -- "-$process_group" 2>/dev/null && [ "$cleanup_attempt" -lt 20 ]; do
      sleep 0.1
      cleanup_attempt=$((cleanup_attempt + 1))
    done
    if /bin/kill -0 -- "-$process_group" 2>/dev/null; then
      /bin/kill -KILL -- "-$process_group" 2>/dev/null || true
      cleanup_attempt=0
      while /bin/kill -0 -- "-$process_group" 2>/dev/null && [ "$cleanup_attempt" -lt 20 ]; do
        sleep 0.1
        cleanup_attempt=$((cleanup_attempt + 1))
      done
    fi
  fi
}

reconcile_active_docker() {
  cleanup_attempt=0
  clean_observations=0
  ownership_seen=0
  while [ "$cleanup_attempt" -lt 100 ]; do
    owned_containers=
    if [ -n "${ACTIVE_DOCKER_CIDFILE:-}" ] && [ -s "$ACTIVE_DOCKER_CIDFILE" ]; then
      owned_containers=$(sed -n '1p' "$ACTIVE_DOCKER_CIDFILE")
    fi
    if ! label_containers=$(docker ps -aq --filter "label=$ACTIVE_DOCKER_LABEL" 2>/dev/null); then
      clean_observations=0
      sleep 0.1
      cleanup_attempt=$((cleanup_attempt + 1))
      continue
    fi
    owned_containers="$owned_containers $label_containers"
    if [ -n "${ACTIVE_DOCKER_NAME:-}" ]; then
      actual_label=$(docker inspect --format '{{ index .Config.Labels "corescope.coverage.run" }}' "$ACTIVE_DOCKER_NAME" 2>/dev/null || true)
      if [ "$actual_label" = "${ACTIVE_DOCKER_LABEL#*=}" ]; then
        owned_containers="$owned_containers $ACTIVE_DOCKER_NAME"
      fi
    fi
    if [ -n "$(printf '%s' "$owned_containers" | tr -d '[:space:]')" ]; then
      ownership_seen=1
      for active_container in $owned_containers; do
        docker rm -f "$active_container" >/dev/null 2>&1 || true
      done
      # A Docker cidfile outlives its container. Remove the observed value so
      # subsequent clean observations are based on daemon state and the label.
      if [ -n "${ACTIVE_DOCKER_CIDFILE:-}" ]; then
        rm -f "$ACTIVE_DOCKER_CIDFILE"
      fi
      clean_observations=0
    else
      clean_observations=$((clean_observations + 1))
      # After observing an owned container, ten clean daemon reads prove its
      # removal. If creation was never observed, keep the unique ownership
      # metadata for the full daemon-registration window before concluding
      # that the failed client request created nothing.
      if [ "$ownership_seen" -eq 1 ] && [ "$clean_observations" -ge 10 ]; then
        ACTIVE_DOCKER_CIDFILE=
        ACTIVE_DOCKER_NAME=
        ACTIVE_DOCKER_LABEL=
        return 0
      fi
    fi
    sleep 0.1
    cleanup_attempt=$((cleanup_attempt + 1))
  done
  if [ "$ownership_seen" -eq 0 ] && [ "$clean_observations" -eq 100 ]; then
    ACTIVE_DOCKER_CIDFILE=
    ACTIVE_DOCKER_NAME=
    ACTIVE_DOCKER_LABEL=
    return 0
  fi
  return 1
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "${ACTIVE_PID:-}" ]; then
    /bin/kill -TERM -- "-$ACTIVE_PID" 2>/dev/null || kill "$ACTIVE_PID" 2>/dev/null || true
    cleanup_attempt=0
    while /bin/kill -0 -- "-$ACTIVE_PID" 2>/dev/null && [ "$cleanup_attempt" -lt 20 ]; do
      sleep 0.1
      cleanup_attempt=$((cleanup_attempt + 1))
    done
    if /bin/kill -0 -- "-$ACTIVE_PID" 2>/dev/null; then
      /bin/kill -KILL -- "-$ACTIVE_PID" 2>/dev/null || true
    fi
    wait "$ACTIVE_PID" 2>/dev/null || true
    ACTIVE_PID=
  fi
  if [ -n "${ACTIVE_DOCKER_CIDFILE:-}" ] || [ -n "${ACTIVE_DOCKER_LABEL:-}" ]; then
    if ! reconcile_active_docker; then
      printf 'ERROR: could not prove the temporary Docker container was removed\n' >&2
    fi
  fi
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    cleanup_attempt=0
    while kill -0 "$SERVER_PID" 2>/dev/null && [ "$cleanup_attempt" -lt 20 ]; do
      sleep 0.1
      cleanup_attempt=$((cleanup_attempt + 1))
    done
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      kill -KILL "$SERVER_PID" 2>/dev/null || true
    fi
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=
  fi
  if [ -L "$REPO_ROOT/.nyc_output" ] && [ -n "${WORK_DIR:-}" ]; then
    nyc_link_target=$(readlink "$REPO_ROOT/.nyc_output" 2>/dev/null || true)
    if [ "$nyc_link_target" = "$WORK_DIR/nyc-output" ]; then
      rm -f "$REPO_ROOT/.nyc_output"
      NYC_OUTPUT_LINK_CREATED=0
    fi
  elif [ "${NYC_OUTPUT_LINK_CREATED:-0}" -eq 1 ]; then
    rm -f "$REPO_ROOT/.nyc_output"
    NYC_OUTPUT_LINK_CREATED=0
  fi
  if [ -n "${NYC_OUTPUT_BACKUP:-}" ] && { [ -e "$NYC_OUTPUT_BACKUP" ] || [ -L "$NYC_OUTPUT_BACKUP" ]; }; then
    if [ ! -e "$REPO_ROOT/.nyc_output" ] && [ ! -L "$REPO_ROOT/.nyc_output" ]; then
      mv "$NYC_OUTPUT_BACKUP" "$REPO_ROOT/.nyc_output"
      NYC_OUTPUT_BACKUP=
    else
      printf 'ERROR: preserved pre-existing .nyc_output at %s because its destination is occupied\n' "$NYC_OUTPUT_BACKUP" >&2
    fi
  fi
  if [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ] && [ -z "${NYC_OUTPUT_BACKUP:-}" ] &&
     [ -z "${ACTIVE_DOCKER_CIDFILE:-}" ] && [ -z "${ACTIVE_DOCKER_LABEL:-}" ]; then
    # Go's module cache is deliberately read-only, even when it is owned by
    # the invoking user. Restore owner write permission before deleting it.
    chmod -R u+w "$WORK_DIR" 2>/dev/null || true
    rm -rf "$WORK_DIR"
  fi
  if [ "${INSTRUMENTED_CREATED:-0}" -eq 1 ] && [ -n "${INSTRUMENTED_DIR:-}" ] && [ -d "$INSTRUMENTED_DIR" ]; then
    rm -rf "$INSTRUMENTED_DIR"
  fi
  if [ "${PRUNE_REQUESTS_CREATED:-0}" -eq 1 ] && [ -d "$REPO_ROOT/cmd/server/prune-requests" ]; then
    rm -rf "$REPO_ROOT/cmd/server/prune-requests"
  fi
  return "$status"
}

run_tracked() {
  setsid "$@" &
  ACTIVE_PID=$!
  if wait "$ACTIVE_PID"; then
    tracked_status=0
  else
    tracked_status=$?
  fi
  reconcile_process_group "$ACTIVE_PID"
  ACTIVE_PID=
  return "$tracked_status"
}

run_tracked_in_dir() {
  tracked_dir=$1
  shift
  (cd "$tracked_dir" && exec setsid "$@") &
  ACTIVE_PID=$!
  if wait "$ACTIVE_PID"; then
    tracked_status=0
  else
    tracked_status=$?
  fi
  reconcile_process_group "$ACTIVE_PID"
  ACTIVE_PID=
  return "$tracked_status"
}

validate_port() {
  case "$1" in
    ''|*[!0-9]*)
      printf 'ERROR: COVERAGE_PORT must be an integer from 1 to 65535\n' >&2
      return 1
      ;;
  esac
  if [ "$1" -lt 1 ] || [ "$1" -gt 65535 ]; then
    printf 'ERROR: COVERAGE_PORT must be an integer from 1 to 65535\n' >&2
    return 1
  fi
}

choose_port() {
  if [ -n "${COVERAGE_PORT:-}" ]; then
    validate_port "$COVERAGE_PORT"
    printf '%s\n' "$COVERAGE_PORT"
    return
  fi
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

assert_port_available() {
  node - "$1" <<'NODE'
const net = require('net');
const port = Number(process.argv[2]);
const server = net.createServer();
server.once('error', error => {
  console.error(`ERROR: localhost port ${port} is unavailable: ${error.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => server.close());
NODE
}

run_go() {
  module=$1
  shift
  printf '+ %s go %s\n' "$module" "$*" >&2
  if [ "${COVERAGE_FORCE_DOCKER:-0}" != 1 ] && command -v go >/dev/null 2>&1; then
    run_tracked_in_dir "$REPO_ROOT/$module" go "$@"
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    printf 'ERROR: go is unavailable and Docker is not installed\n' >&2
    return 1
  fi
  uid=$(id -u)
  gid=$(id -g)
  ACTIVE_DOCKER_CIDFILE="$WORK_DIR/go-container.cid"
  module_tag=${module##*/}
  run_token=$(basename "$WORK_DIR")-$$-$module_tag
  ACTIVE_DOCKER_NAME="corescope-coverage-$run_token"
  ACTIVE_DOCKER_LABEL="corescope.coverage.run=$run_token"
  rm -f "$ACTIVE_DOCKER_CIDFILE"
  if run_tracked docker run --rm \
    --name "$ACTIVE_DOCKER_NAME" \
    --label "$ACTIVE_DOCKER_LABEL" \
    --cidfile "$ACTIVE_DOCKER_CIDFILE" \
    --user "$uid:$gid" \
    -e GOCACHE="$WORK_DIR/go-build-cache" \
    -e GOMODCACHE="$WORK_DIR/go-mod-cache" \
    -v "$REPO_ROOT:$REPO_ROOT" \
    -v "$WORK_DIR:$WORK_DIR" \
    -w "$REPO_ROOT/$module" \
    "$GO_IMAGE" go "$@"; then
    docker_status=0
  else
    docker_status=$?
  fi
  if ! reconcile_active_docker; then
    printf 'ERROR: could not prove the temporary Docker container was removed\n' >&2
    if [ "$docker_status" -eq 0 ]; then
      docker_status=1
    fi
  fi
  return "$docker_status"
}

freshen_fixture() {
  fixture=$1
  if command -v sqlite3 >/dev/null 2>&1; then
    bash "$REPO_ROOT/tools/freshen-fixture.sh" "$fixture"
    return
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'ERROR: fixture freshness requires sqlite3 or python3\n' >&2
    return 1
  fi
  python3 - "$fixture" <<'PY'
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
db.executescript("""
UPDATE nodes SET last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', last_seen,
  (SELECT printf('+%d seconds', CAST((julianday('now') - julianday(MAX(last_seen))) * 86400 AS INTEGER)) FROM nodes)
) WHERE last_seen IS NOT NULL;
UPDATE transmissions SET first_seen = strftime('%Y-%m-%dT%H:%M:%SZ', first_seen,
  (SELECT printf('+%d seconds', CAST((julianday('now') - julianday(MAX(first_seen))) * 86400 AS INTEGER)) FROM transmissions)
) WHERE first_seen IS NOT NULL;
UPDATE observations SET timestamp = timestamp +
  (SELECT CAST(strftime('%s', 'now') AS INTEGER) - MAX(timestamp) FROM observations WHERE timestamp > 0)
WHERE timestamp > 0;
UPDATE observations SET timestamp = CAST(strftime('%s',
  (SELECT first_seen FROM transmissions WHERE id = transmission_id)
) AS INTEGER)
WHERE timestamp = 0 OR timestamp IS NULL;
UPDATE observers SET last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', last_seen,
  (SELECT printf('+%d seconds', CAST((julianday('now') - julianday(MAX(last_seen))) * 86400 AS INTEGER)) FROM observers)
) WHERE last_seen IS NOT NULL;
""")
try:
    db.execute("UPDATE observers SET inactive = 0 WHERE inactive = 1")
except sqlite3.OperationalError:
    pass
try:
    db.execute("""UPDATE neighbor_edges SET last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', last_seen,
      (SELECT printf('+%d seconds', CAST((julianday('now') - julianday(MAX(last_seen))) * 86400 AS INTEGER)) FROM neighbor_edges))
      WHERE last_seen IS NOT NULL""")
except sqlite3.OperationalError:
    pass
db.commit()
print(f"Fixture timestamps freshened in {sys.argv[1]}")
PY
}

seed_e2e_fixture() {
  fixture=$1
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'ERROR: python3 is required to seed the temporary E2E fixture\n' >&2
    return 1
  fi
  python3 - "$fixture" <<'PY'
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
db.executescript("""
INSERT INTO transmissions(id,raw_hex,hash,first_seen,route_type,payload_type,payload_version,decoded_json,channel_hash,from_pubkey)
  VALUES (0,'15000102030405060708090a0b0c0d0e0f','fae0c9e6d357a814','2026-05-15T00:00:00Z',1,5,0,
          '{"type":"CHAN","channel":"#test","text":"#1486 fixture"}',NULL,NULL);
INSERT INTO observations(transmission_id,observer_idx,direction,snr,rssi,score,path_json,timestamp,resolved_path) VALUES
  (0,1,'rx',5.0,-95,0,'["AA"]',CAST(strftime('%s','2026-05-15T00:00:00Z') AS INTEGER),'["aa00000000000000000000000000000000000000000000000000000000000000"]'),
  (0,2,'rx',5.5,-92,0,'["BB"]',CAST(strftime('%s','2026-05-15T00:00:00Z') AS INTEGER),'["bb00000000000000000000000000000000000000000000000000000000000000"]'),
  (0,3,'rx',6.0,-90,0,'["CC"]',CAST(strftime('%s','2026-05-15T00:00:00Z') AS INTEGER),'["cc00000000000000000000000000000000000000000000000000000000000000"]');
INSERT INTO transmissions(id,raw_hex,hash,first_seen,route_type,payload_type,payload_version,decoded_json,channel_hash,from_pubkey)
  VALUES (-1000000,'19000102030405060708090a0b0c0d0e0f','17910000deadbeef',strftime('%Y-%m-%dT%H:%M:%SZ','now'),1,6,0,
          '{"type":"GRP_DATA","channel":"#test","raw":"deadbeef"}',NULL,NULL);
INSERT INTO observations(transmission_id,observer_idx,direction,snr,rssi,score,path_json,timestamp,resolved_path) VALUES
  (-1000000,1,'rx',7.0,-88,0,'[]',CAST(strftime('%s','now') AS INTEGER),'[]');
-- Deterministic current multi-hop rows for the strict path/byte-breakdown E2E.
-- Start from a real packet, replace its on-wire descriptor/path bytes with six
-- 2-byte hops matching the copied resolved path, and change its final payload
-- byte so content-hash migration keeps each copy distinct. High temporary ids
-- and current timestamps keep the copies in the first rows regardless of the
-- fixture's historical ordering. Extra copies tolerate asynchronous table
-- refreshes while the E2E test re-queries virtualized rows.
WITH RECURSIVE seeds(n) AS (
  VALUES (0) UNION ALL SELECT n+1 FROM seeds WHERE n<9
)
INSERT INTO transmissions(id,raw_hex,hash,first_seen,route_type,payload_type,payload_version,decoded_json,channel_hash,from_pubkey)
  SELECT 1000000+seeds.n,substr(t.raw_hex,1,2)||'46'||'7d1dda2aeacf1000ec344000'||substr(t.raw_hex,13,length(t.raw_hex)-14)||printf('%02x',seeds.n),
         'coveragepathfixture'||printf('%02x',seeds.n),
         strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         t.route_type,t.payload_type,t.payload_version,t.decoded_json,t.channel_hash,t.from_pubkey
  FROM transmissions AS t CROSS JOIN seeds WHERE t.id=2;
WITH RECURSIVE seeds(n) AS (
  VALUES (0) UNION ALL SELECT n+1 FROM seeds WHERE n<9
)
INSERT INTO observations(transmission_id,observer_idx,direction,snr,rssi,score,path_json,timestamp,resolved_path)
  SELECT 1000000+seeds.n,source.observer_idx,source.direction,source.snr,source.rssi,source.score,
         '["7d1d","da2a","eacf","1000","ec34","4000"]',
         CAST(strftime('%s','now') AS INTEGER),
         '["7d1d","da2a","eacf","1000","ec34","4000"]'
  FROM seeds CROSS JOIN (
    SELECT observer_idx,direction,snr,rssi,score
    FROM observations WHERE transmission_id=2 LIMIT 1
  ) AS source;
""")
db.commit()
print(f"Canonical E2E rows seeded in {sys.argv[1]}")
PY
}

finalize_e2e_fixture() {
  fixture=$1
  python3 - "$fixture" <<'PY'
import hashlib
import sqlite3
import sys

def content_hash(raw_hex):
    try:
        buf = bytes.fromhex(raw_hex)
    except ValueError:
        return raw_hex[:16]
    if len(buf) < 2:
        return raw_hex[:16]
    header = buf[0]
    offset = 1 + (4 if (header & 0x03) in (2, 3) else 0)
    if offset >= len(buf):
        return raw_hex[:16]
    path_byte = buf[offset]
    offset += 1
    hash_size = ((path_byte >> 6) & 0x03) + 1
    hash_count = path_byte & 0x3f
    payload_start = offset + hash_size * hash_count
    if payload_start > len(buf):
        return raw_hex[:16]
    payload_type = (header >> 2) & 0x0f
    hashed = bytes([payload_type])
    if payload_type == 7:
        hashed += bytes([path_byte, 0])
    hashed += buf[payload_start:]
    return hashlib.sha256(hashed).hexdigest()[:16]

db = sqlite3.connect(sys.argv[1])
tx_columns = {row[1] for row in db.execute("PRAGMA table_info(transmissions)")}
observation_columns = {row[1] for row in db.execute("PRAGMA table_info(observations)")}

# The migrator adds these fields after seeding. Populate them explicitly so the
# temporary packets sort first and packet detail always uses their matching raw
# bytes instead of stale historical observation data. Replace temporary hashes
# with the same canonical content hash used by the server so table navigation
# opens the seeded packet rather than resolving to a stale historical group.
seed_rows = db.execute("""
    SELECT id, raw_hex FROM transmissions
    WHERE id BETWEEN 1000000 AND 1000009
""").fetchall()
for transmission_id, raw_hex in seed_rows:
    db.execute(
        "UPDATE transmissions SET hash = ? WHERE id = ?",
        (content_hash(raw_hex), transmission_id),
    )
if "last_seen" in tx_columns:
    db.execute("""
        UPDATE transmissions
        SET last_seen = CAST(strftime('%s','now') AS INTEGER)
        WHERE id BETWEEN 1000000 AND 1000009
    """)
if "raw_hex" in observation_columns:
    db.execute("""
        UPDATE observations
        SET raw_hex = (
            SELECT transmissions.raw_hex
            FROM transmissions
            WHERE transmissions.id = observations.transmission_id
        )
        WHERE transmission_id BETWEEN 1000000 AND 1000009
    """)
db.commit()
print(f"Canonical E2E rows finalized in {sys.argv[1]}")
PY
}

print_dry_run() {
  port=$1
  if [ "$MODE" = full ] || [ "$MODE" = go ]; then
    log "+ cmd/server go test -timeout 15m -coverprofile coverage/go/server-coverage.out ./..."
    log "+ cmd/server go tool cover -func coverage/go/server-coverage.out"
    log "+ cmd/ingestor go test -timeout 15m -coverprofile coverage/go/ingestor-coverage.out ./..."
    log "+ cmd/ingestor go tool cover -func coverage/go/ingestor-coverage.out"
  fi
  if [ "$MODE" != go ]; then
    log "+ cmd/server go build -o <temporary>/corescope-server ."
    log "+ cmd/migrate go build -o <temporary>/corescope-migrate ."
    log "+ copy test-fixtures/e2e-fixture.db to <temporary>/e2e-fixture.db"
    log "+ freshen and seed the temporary E2E fixture"
    log "+ run corescope-migrate -db <temporary>/e2e-fixture.db"
    log "+ instrument frontend into <temporary>/public-instrumented"
    if [ "$MODE" = customizer ]; then
      log "+ <temporary>/corescope-server -host 127.0.0.1 -port $port -db <temporary>/e2e-fixture.db -public <temporary>/public-instrumented -config-dir <temporary>/config -static-trace-file <temporary>/static-request-trace.jsonl"
      log "+ BASE_URL=http://127.0.0.1:$port E2E_TEST_FILTER=^Customizer v2: node test-e2e-playwright.js"
    else
      log "+ <temporary>/corescope-server -host 127.0.0.1 -port $port -db <temporary>/e2e-fixture.db -public <temporary>/public-instrumented -config-dir <temporary>/config -static-trace-file <temporary>/static-request-trace.jsonl"
      log "+ BASE_URL=http://127.0.0.1:$port node scripts/tests/run-manifest.js --profile ci-e2e-phase"
      log "+ BASE_URL=http://127.0.0.1:$port node scripts/collect-frontend-coverage.js"
      log "+ npx nyc report --temp-dir .nyc_output --report-dir coverage/frontend --reporter=text --reporter=text-summary --reporter=html"
    fi
  fi
}

run_go_coverage() {
  mkdir -p "$GO_COVERAGE_DIR"

  if [ ! -e "$REPO_ROOT/cmd/server/prune-requests" ]; then
    PRUNE_REQUESTS_CREATED=1
  fi
  run_go cmd/server test -timeout 15m -coverprofile "$GO_COVERAGE_DIR/server-coverage.out" ./...
  run_go cmd/server tool cover -func "$GO_COVERAGE_DIR/server-coverage.out" > "$GO_COVERAGE_DIR/server-coverage.txt"
  while IFS= read -r line; do printf '%s\n' "$line"; done < "$GO_COVERAGE_DIR/server-coverage.txt"
  run_go cmd/server tool cover -html "$GO_COVERAGE_DIR/server-coverage.out" -o "$GO_COVERAGE_DIR/server-coverage.html"

  # Keep the two expensive SQLite-heavy suites sequential.
  run_go cmd/ingestor test -timeout 15m -coverprofile "$GO_COVERAGE_DIR/ingestor-coverage.out" ./...
  run_go cmd/ingestor tool cover -func "$GO_COVERAGE_DIR/ingestor-coverage.out" > "$GO_COVERAGE_DIR/ingestor-coverage.txt"
  while IFS= read -r line; do printf '%s\n' "$line"; done < "$GO_COVERAGE_DIR/ingestor-coverage.txt"
  run_go cmd/ingestor tool cover -html "$GO_COVERAGE_DIR/ingestor-coverage.out" -o "$GO_COVERAGE_DIR/ingestor-coverage.html"
}

wait_for_server() {
  base_url=$1
  attempts=${COVERAGE_HEALTH_ATTEMPTS:-60}
  delay=${COVERAGE_HEALTH_DELAY_SECONDS:-1}
  count=1
  while [ "$count" -le "$attempts" ]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      printf 'ERROR: coverage server exited before becoming healthy\n' >&2
      if [ -f "$WORK_DIR/server.log" ]; then
        printf '%s\n' '--- server log ---' >&2
        while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$WORK_DIR/server.log"
      fi
      return 1
    fi
    if curl -fsS "$base_url/api/healthz" >/dev/null 2>&1; then
      log "Coverage server ready at $base_url"
      return 0
    fi
    sleep "$delay"
    count=$((count + 1))
  done
  printf 'ERROR: coverage server failed health check after %s attempts\n' "$attempts" >&2
  if [ -f "$WORK_DIR/server.log" ]; then
    while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$WORK_DIR/server.log"
  fi
  return 1
}

prepare_frontend_paths() {
  nyc_run_dir="$WORK_DIR/nyc-output"
  mkdir -p "$nyc_run_dir"
  if [ -e "$REPO_ROOT/.nyc_output" ] || [ -L "$REPO_ROOT/.nyc_output" ]; then
    NYC_OUTPUT_BACKUP="$WORK_DIR/preexisting-nyc-output"
    mv "$REPO_ROOT/.nyc_output" "$NYC_OUTPUT_BACKUP"
  fi
  ln -s "$nyc_run_dir" "$REPO_ROOT/.nyc_output"
  NYC_OUTPUT_LINK_CREATED=1

  RUN_INSTRUMENTED_DIR="$WORK_DIR/public-instrumented"
  if [ -e "$FRONTEND_COVERAGE_DIR" ]; then
    RUN_FRONTEND_REPORT_DIR="$FRONTEND_COVERAGE_DIR/run-$(date +%Y%m%d-%H%M%S)-$$"
  else
    RUN_FRONTEND_REPORT_DIR="$FRONTEND_COVERAGE_DIR"
  fi
  mkdir -p "$RUN_FRONTEND_REPORT_DIR"
  FAILURE_EVIDENCE_DIR="$RUN_FRONTEND_REPORT_DIR/failure-evidence"
  mkdir -p "$FAILURE_EVIDENCE_DIR"
}

validate_frontend_coverage_artifacts() {
  artifact_dir=$1
  missing_coverage=0
  for coverage_name in e2e-coverage.json \
    frontend-coverage-g1.json frontend-coverage-g2.json frontend-coverage-g3.json \
    frontend-coverage-g4.json frontend-coverage-g5.json frontend-coverage-g6.json \
    frontend-coverage-g7.json; do
    if [ ! -s "$artifact_dir/$coverage_name" ]; then
      printf 'ERROR: missing or empty frontend coverage artifact: %s\n' "$coverage_name" >&2
      missing_coverage=1
    fi
  done
  if [ "$missing_coverage" -ne 0 ]; then
    return 1
  fi
  node - "$artifact_dir" "$REPO_ROOT/public" "$RUN_INSTRUMENTED_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const directory = process.argv[2];
const sourceRoot = fs.realpathSync(process.argv[3]);
const instrumentedRoot = fs.realpathSync(process.argv[4]);
const names = [
  'e2e-coverage.json',
  ...Array.from({ length: 7 }, (_, i) => `frontend-coverage-g${i + 1}.json`),
];
const requiredFields = ['path', 'statementMap', 'fnMap', 'branchMap', 's', 'f', 'b'];
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const isPosition = value => isRecord(value) && Number.isInteger(value.line) && value.line >= 0 &&
  Number.isInteger(value.column) && value.column >= 0;
const isLocation = value => isRecord(value) && isPosition(value.start) && isPosition(value.end);
const isEmptyPosition = value => isRecord(value) && Object.keys(value).length === 0;
const isBranchLocation = value => isLocation(value) ||
  (isRecord(value) && isEmptyPosition(value.start) && isEmptyPosition(value.end));
const hasExactIds = (map, counters, requireNonEmpty = false) => {
  const mapIds = Object.keys(map).sort();
  const counterIds = Object.keys(counters).sort();
  return (!requireNonEmpty || mapIds.length > 0) && mapIds.length === counterIds.length &&
    mapIds.every((id, index) => id === counterIds[index]);
};
const isCounter = value => Number.isFinite(value) && value >= 0;
const isCanonicalMeasuredFile = file => {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  let canonical;
  try {
    canonical = fs.realpathSync(file);
  } catch (_) {
    return false;
  }
  const relative = path.relative(sourceRoot, canonical);
  if (canonical !== file || relative === '' || relative === '..' ||
      relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  try {
    return fs.realpathSync(path.join(instrumentedRoot, relative)) ===
      path.join(instrumentedRoot, relative);
  } catch (_) {
    return false;
  }
};
for (const name of names) {
  let coverage;
  try {
    coverage = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  } catch (error) {
    console.error(`ERROR: invalid frontend coverage artifact ${name}: ${error.message}`);
    process.exitCode = 1;
    continue;
  }
  const entries = isRecord(coverage) ? Object.entries(coverage) : [];
  const validEntries = entries.filter(([file, entry]) => {
    if (!isRecord(entry) || file !== entry.path || !isCanonicalMeasuredFile(entry.path) ||
        !requiredFields.every(field => Object.prototype.hasOwnProperty.call(entry, field)) ||
        !isRecord(entry.statementMap) || !isRecord(entry.fnMap) ||
        !isRecord(entry.branchMap) || !isRecord(entry.s) ||
        !isRecord(entry.f) || !isRecord(entry.b)) {
      return false;
    }
    if (!hasExactIds(entry.statementMap, entry.s, true) || !hasExactIds(entry.fnMap, entry.f) ||
        !hasExactIds(entry.branchMap, entry.b)) return false;
    if (!Object.values(entry.statementMap).every(isLocation) ||
        !Object.values(entry.fnMap).every(fn => isRecord(fn) && isLocation(fn.loc)) ||
        !Object.values(entry.s).every(isCounter) || !Object.values(entry.f).every(isCounter)) {
      return false;
    }
    return Object.entries(entry.branchMap).every(([id, branch]) =>
      isRecord(branch) && Array.isArray(branch.locations) && branch.locations.length > 0 &&
      branch.locations.every(isBranchLocation) && Array.isArray(entry.b[id]) &&
      entry.b[id].length === branch.locations.length && entry.b[id].every(isCounter));
  });
  if (validEntries.length === 0 || validEntries.length !== entries.length) {
    console.error(`ERROR: frontend coverage artifact has no valid measured file entries: ${name}`);
    process.exitCode = 1;
  }
}
NODE
}

capture_frontend_failure_evidence() {
  base_url=$1
  exit_status=$2
  failed_stage=$3
  [ -n "${FAILURE_EVIDENCE_DIR:-}" ] || return 0

  mkdir -p "$FAILURE_EVIDENCE_DIR"
  {
    printf 'base_url=%s\n' "$base_url"
    printf 'exit_status=%s\n' "$exit_status"
    printf 'failed_stage=%s\n' "$failed_stage"
    printf 'server_pid=%s\n' "${SERVER_PID:-}"
    date -u '+captured_at_utc=%Y-%m-%dT%H:%M:%SZ'
  } > "$FAILURE_EVIDENCE_DIR/run-metadata.txt"

  if [ -f "$WORK_DIR/server.log" ]; then
    cp "$WORK_DIR/server.log" "$FAILURE_EVIDENCE_DIR/server.log"
  fi

  {
    printf '%s\n' '--- root ---'
    curl --max-time 2 -sS -D - -o /dev/null "$base_url/" || true
    printf '%s\n' '--- health ---'
    curl --max-time 2 -sS -D - -o /dev/null "$base_url/api/healthz" || true
  } > "$FAILURE_EVIDENCE_DIR/http-probes.txt" 2>&1

  if [ -n "${SERVER_PID:-}" ]; then
    {
      ps -o pid=,ppid=,stat=,etime= -p "$SERVER_PID" 2>&1 || true
      printf '%s\n' '--- cgroup ---'
      cat "/proc/$SERVER_PID/cgroup" 2>&1 || true
      cgroup_path=$(awk -F: '$1 == "0" { print $3; exit }' "/proc/$SERVER_PID/cgroup" 2>/dev/null || true)
      if [ -n "$cgroup_path" ] && [ -d "/sys/fs/cgroup$cgroup_path" ]; then
        for counter in memory.current memory.events memory.stat pids.current; do
          [ -r "/sys/fs/cgroup$cgroup_path/$counter" ] || continue
          printf '%s\n' "--- $counter ---"
          cat "/sys/fs/cgroup$cgroup_path/$counter" 2>&1 || true
        done
      fi
      # Do not capture host-wide listeners or command lines: neither is
      # necessary to diagnose the owned server, and both can disclose private
      # host addresses, ports, process arguments, or credentials.
    } > "$FAILURE_EVIDENCE_DIR/server-state.txt"
  fi
}

run_frontend_coverage() {
  fixture="$WORK_DIR/e2e-fixture.db"
  server="$WORK_DIR/corescope-server"
  migrator="$WORK_DIR/corescope-migrate"
  port=$1
  base_url="http://127.0.0.1:$port"

  command -v curl >/dev/null 2>&1 || { printf 'ERROR: curl is required\n' >&2; return 1; }
  [ -f "$REPO_ROOT/test-fixtures/e2e-fixture.db" ] || { printf 'ERROR: test fixture is missing\n' >&2; return 1; }
  [ -x "$REPO_ROOT/node_modules/.bin/nyc" ] || { printf 'ERROR: npm dependencies are missing; run npm ci\n' >&2; return 1; }
  node -e "require('playwright')" >/dev/null 2>&1 || { printf 'ERROR: Playwright is not installed; run npm ci\n' >&2; return 1; }

  run_go cmd/server build -o "$server" .
  run_go cmd/migrate build -o "$migrator" .
  cp "$REPO_ROOT/test-fixtures/e2e-fixture.db" "$fixture"
  freshen_fixture "$fixture"
  seed_e2e_fixture "$fixture"
  run_tracked "$migrator" -db "$fixture"
  finalize_e2e_fixture "$fixture"

  prepare_frontend_paths
  run_tracked_in_dir "$REPO_ROOT" env INSTRUMENTED_DIR="$RUN_INSTRUMENTED_DIR" sh scripts/instrument-frontend.sh

  assert_port_available "$port"
  mkdir -p "$WORK_DIR/config"
  "$server" -host 127.0.0.1 -port "$port" -db "$fixture" -public "$RUN_INSTRUMENTED_DIR" -config-dir "$WORK_DIR/config" \
    -static-trace-file "$FAILURE_EVIDENCE_DIR/static-request-trace.jsonl" >"$WORK_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  wait_for_server "$base_url"

  if [ "$MODE" = customizer ]; then
    if run_tracked_in_dir "$REPO_ROOT" env \
      BASE_URL="$base_url" \
      E2E_FAILURE_EVIDENCE_DIR="$FAILURE_EVIDENCE_DIR" \
      E2E_TEST_FILTER='^Customizer v2:' \
      node test-e2e-playwright.js; then
      log "Customizer navigation diagnostic trace written to $FAILURE_EVIDENCE_DIR/static-request-trace.jsonl"
      return 0
    else
      frontend_status=$?
    fi
    capture_frontend_failure_evidence "$base_url" "$frontend_status" customizer-navigation
    return "$frontend_status"
  fi

  # Canonical coverage must not inherit diagnostic name narrowing. Scope the
  # override to child environments so the explicit customizer path stays intact.
  if run_tracked_in_dir "$REPO_ROOT" env \
    BASE_URL="$base_url" \
    E2E_FAILURE_EVIDENCE_DIR="$FAILURE_EVIDENCE_DIR" \
    E2E_TEST_FILTER= \
    node scripts/tests/run-manifest.js --profile ci-e2e-phase; then
    :
  else
    frontend_status=$?
    capture_frontend_failure_evidence "$base_url" "$frontend_status" manifest
    return "$frontend_status"
  fi
  if run_tracked_in_dir "$REPO_ROOT" env \
    BASE_URL="$base_url" \
    E2E_FAILURE_EVIDENCE_DIR="$FAILURE_EVIDENCE_DIR" \
    E2E_TEST_FILTER= \
    node scripts/collect-frontend-coverage.js; then
    :
  else
    frontend_status=$?
    capture_frontend_failure_evidence "$base_url" "$frontend_status" collector
    return "$frontend_status"
  fi

  validate_frontend_coverage_artifacts "$REPO_ROOT/.nyc_output"
  run_tracked_in_dir "$REPO_ROOT" npx nyc report \
    --temp-dir .nyc_output \
    --report-dir "$RUN_FRONTEND_REPORT_DIR" \
    --reporter=text \
    --reporter=text-summary \
    --reporter=html
  log "Frontend coverage report written to $RUN_FRONTEND_REPORT_DIR"
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --go-only) MODE=go ;;
      --frontend-only) MODE=frontend ;;
      --customizer-navigation-diagnostic) MODE=customizer ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; return 0 ;;
      *) printf 'ERROR: unknown option: %s\n' "$1" >&2; usage >&2; return 2 ;;
    esac
    shift
  done

  trap cleanup EXIT
  trap 'exit 130' HUP INT TERM
  cd "$REPO_ROOT"
  port=$(choose_port)

  if [ "$DRY_RUN" -eq 1 ]; then
    print_dry_run "$port"
    return 0
  fi

  command -v setsid >/dev/null 2>&1 || { printf 'ERROR: setsid is required for cancellable coverage commands\n' >&2; return 1; }
  WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/corescope-coverage.XXXXXX")
  mkdir -p "$WORK_DIR/go-build-cache" "$WORK_DIR/go-mod-cache"

  if [ "$MODE" = full ] || [ "$MODE" = go ]; then
    run_go_coverage
  fi
  if [ "$MODE" != go ]; then
    run_frontend_coverage "$port"
  fi

  log "Coverage reports written to $COVERAGE_DIR"
}
