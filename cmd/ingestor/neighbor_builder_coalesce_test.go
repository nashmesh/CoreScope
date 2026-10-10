package main

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Audit actual SQLite row mutations, not Go calls or driver internals.
func neighborCoalesceStore(t *testing.T) *Store {
	t.Helper()
	s, err := OpenStore(filepath.Join(t.TempDir(), "coalesce.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	s.WaitForAsyncMigrations()
	neighborCoalesceExec(t, s.db, `INSERT INTO nodes (public_key, name) VALUES ('aaaaaaaaaa', 'a'), ('bbbbbbbbbb', 'b')`)
	neighborCoalesceExec(t, s.db, `INSERT INTO observers (id, name) VALUES ('obs-1', 'observer'), ('aaaaaaaaaa', 'a'), ('bbbbbbbbbb', 'b')`)
	neighborCoalesceExec(t, s.db, `CREATE TABLE neighbor_mutations (kind TEXT, a TEXT, b TEXT, contribution INTEGER, ts TEXT)`)
	neighborCoalesceExec(t, s.db, `CREATE TRIGGER neighbor_audit_insert AFTER INSERT ON neighbor_edges BEGIN
		INSERT INTO neighbor_mutations VALUES ('insert', NEW.node_a, NEW.node_b, NEW.count, NEW.last_seen); END`)
	neighborCoalesceExec(t, s.db, `CREATE TRIGGER neighbor_audit_update AFTER UPDATE ON neighbor_edges BEGIN
		INSERT INTO neighbor_mutations VALUES ('update', NEW.node_a, NEW.node_b, NEW.count - OLD.count, NEW.last_seen); END`)
	return s
}

func neighborCoalesceExec(t *testing.T, db *sql.DB, query string, args ...any) sql.Result {
	t.Helper()
	res, err := db.Exec(query, args...)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func neighborCoalesceObservation(t *testing.T, s *Store, epoch int64, from, path, observer string) {
	t.Helper()
	res := neighborCoalesceExec(t, s.db, `INSERT INTO transmissions
		(raw_hex, hash, first_seen, route_type, payload_type, payload_version, decoded_json, from_pubkey)
		VALUES ('', ?, ?, 0, ?, 0, '{}', ?)`, fmt.Sprintf("%d-%s-%s", epoch, from, observer), epoch, payloadADVERT, from)
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	neighborCoalesceExec(t, s.db, `INSERT INTO observations (transmission_id, observer_idx, path_json, timestamp)
		VALUES (?, (SELECT rowid FROM observers WHERE id = ?), ?, ?)`, id, observer, path, epoch)
}

type neighborCoalesceRow struct {
	a, b  string
	count int
	ts    string
}

func neighborCoalesceRows(t *testing.T, s *Store) []neighborCoalesceRow {
	t.Helper()
	rows, err := s.db.Query(`SELECT node_a, node_b, count, last_seen FROM neighbor_edges ORDER BY node_a, node_b`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []neighborCoalesceRow
	for rows.Next() {
		var row neighborCoalesceRow
		if err := rows.Scan(&row.a, &row.b, &row.count, &row.ts); err != nil {
			t.Fatal(err)
		}
		got = append(got, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return got
}

func neighborCoalesceAuditCount(t *testing.T, s *Store) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM neighbor_mutations`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestNeighborEdgesCoalesceBoundedWrites(t *testing.T) {
	s := neighborCoalesceStore(t)
	const start int64 = 1735689600
	for i := int64(0); i < 4; i++ {
		neighborCoalesceObservation(t, s, start+i, "aaaaaaaaaa", `["bb"]`, "obs-1")
	}
	n, err := s.buildAndPersistNeighborEdges()
	if err != nil || n != 8 {
		t.Fatalf("candidate contributions: got %d, %v; want 8, nil", n, err)
	}
	tail := time.Unix(start+3, 0).UTC().Format(time.RFC3339)
	want := []neighborCoalesceRow{{"aaaaaaaaaa", "bbbbbbbbbb", 4, tail}, {"bbbbbbbbbb", "obs-1", 4, tail}}
	if got := neighborCoalesceRows(t, s); !reflect.DeepEqual(got, want) {
		t.Fatalf("persisted contributions/tail: got %+v, want %+v", got, want)
	}
	if got := neighborCoalesceAuditCount(t, s); got != 2 {
		t.Fatalf("bounded SQLite mutations: got %d, want 2 (one per canonical pair)", got)
	}
}

func TestNeighborEdgesCoalesceRollbackRetry(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(fmt.Sprintf("existing=%t", existing), func(t *testing.T) {
			s := neighborCoalesceStore(t)
			const start int64 = 1735689600
			prior := time.Unix(start-1, 0).UTC().Format(time.RFC3339)
			firstCount, secondCount := 0, 0
			if existing {
				firstCount, secondCount = 7, 5
				neighborCoalesceExec(t, s.db, `INSERT INTO neighbor_edges (node_a, node_b, count, last_seen)
					VALUES ('aaaaaaaaaa', 'bbbbbbbbbb', 7, ?), ('bbbbbbbbbb', 'obs-1', 5, ?)`, prior, prior)
			}
			before := neighborCoalesceRows(t, s)
			neighborCoalesceExec(t, s.db, `DELETE FROM neighbor_mutations`)
			for i := int64(0); i < 4; i++ {
				neighborCoalesceObservation(t, s, start+i, "aaaaaaaaaa", `["bb"]`, "obs-1")
			}
			// Fail the second first-seen pair only after the first aggregate
			// really mutated SQLite. Distinguish missing/reordered first writes
			// from the intended injected failure; all trigger audit work shares
			// the builder's transaction and must roll back with it.
			neighborCoalesceExec(t, s.db, `CREATE TRIGGER neighbor_fail_second BEFORE INSERT ON neighbor_edges
				WHEN NEW.node_a = 'bbbbbbbbbb' AND NEW.node_b = 'obs-1' BEGIN
				SELECT CASE WHEN (SELECT COUNT(*) FROM neighbor_mutations) = 1
					AND EXISTS (SELECT 1 FROM neighbor_mutations WHERE a = 'aaaaaaaaaa'
						AND b = 'bbbbbbbbbb' AND contribution = 4)
					THEN RAISE(ABORT, 'second first-seen pair')
					ELSE RAISE(ABORT, 'first-seen order or contribution violated') END; END`)
			n, err := s.buildAndPersistNeighborEdges()
			if n != 0 || err == nil || !strings.Contains(err.Error(), "second first-seen pair") {
				t.Fatalf("injected second-pair failure: got %d, %v; want zero and intended error", n, err)
			}
			if got := neighborCoalesceRows(t, s); !reflect.DeepEqual(got, before) {
				t.Fatalf("rollback changed prior rows/MAX watermark: got %+v, want %+v", got, before)
			}
			if got := neighborCoalesceAuditCount(t, s); got != 0 {
				t.Fatalf("partial audit survived rollback: %d mutations", got)
			}
			neighborCoalesceExec(t, s.db, `DROP TRIGGER neighbor_fail_second`)
			n, err = s.buildAndPersistNeighborEdges()
			if n != 8 || err != nil {
				t.Fatalf("retry must reprocess failed batch: got %d, %v; want 8, nil", n, err)
			}
			tail := time.Unix(start+3, 0).UTC().Format(time.RFC3339)
			want := []neighborCoalesceRow{{"aaaaaaaaaa", "bbbbbbbbbb", firstCount + 4, tail}, {"bbbbbbbbbb", "obs-1", secondCount + 4, tail}}
			if got := neighborCoalesceRows(t, s); !reflect.DeepEqual(got, want) {
				t.Fatalf("retry contributions/MAX: got %+v, want %+v", got, want)
			}
			if got := neighborCoalesceAuditCount(t, s); got != 2 {
				t.Fatalf("retry mutations: got %d, want 2", got)
			}
			var a, b string
			if err := s.db.QueryRow(`SELECT a, b FROM neighbor_mutations ORDER BY rowid LIMIT 1`).Scan(&a, &b); err != nil {
				t.Fatal(err)
			}
			if a != "aaaaaaaaaa" || b != "bbbbbbbbbb" {
				t.Fatalf("retry first-seen order: first pair is %s/%s", a, b)
			}
		})
	}
}

func TestNeighborEdgesCoalesceEmptyDelta(t *testing.T) {
	s := neighborCoalesceStore(t)
	n, err := s.buildAndPersistNeighborEdges()
	if err != nil || n != 0 || neighborCoalesceAuditCount(t, s) != 0 {
		t.Fatalf("empty database: got %d, %v, want no contributions or mutations", n, err)
	}
	neighborCoalesceObservation(t, s, 1735689600, "aaaaaaaaaa", `["bb"]`, "obs-1")
	if n, err := s.buildAndPersistNeighborEdges(); err != nil || n != 2 {
		t.Fatalf("warm-up: got %d, %v, want 2, nil", n, err)
	}
	prior := neighborCoalesceRows(t, s)
	neighborCoalesceExec(t, s.db, `DELETE FROM neighbor_mutations`)
	for i := 0; i < 2; i++ {
		n, err := s.buildAndPersistNeighborEdges()
		if err != nil || n != 0 || neighborCoalesceAuditCount(t, s) != 0 {
			t.Fatalf("empty delta %d: got %d, %v, want no contributions or mutations", i, n, err)
		}
		if got := neighborCoalesceRows(t, s); !reflect.DeepEqual(got, prior) {
			t.Fatalf("empty delta changed counts/watermark: got %+v, want %+v", got, prior)
		}
	}
}

func TestNeighborEdgesCoalesceExistingCanonicalContributions(t *testing.T) {
	s := neighborCoalesceStore(t)
	const start int64 = 1735689600
	prior := time.Unix(start-1, 0).UTC().Format(time.RFC3339)
	neighborCoalesceExec(t, s.db, `INSERT INTO neighbor_edges (node_a, node_b, count, last_seen)
		VALUES ('aaaaaaaaaa', 'bbbbbbbbbb', 7, ?), ('bbbbbbbbbb', 'obs-1', 5, ?)`, prior, prior)
	neighborCoalesceExec(t, s.db, `DELETE FROM neighbor_mutations`)

	// A real duplicate UPDATE is a positive control for the audit trigger.
	neighborCoalesceExec(t, s.db, `UPDATE neighbor_edges SET count = count + 3 WHERE node_a = 'aaaaaaaaaa'`)
	var kind string
	var contribution int
	if err := s.db.QueryRow(`SELECT kind, contribution FROM neighbor_mutations`).Scan(&kind, &contribution); err != nil {
		t.Fatal(err)
	}
	if kind != "update" || contribution != 3 || neighborCoalesceAuditCount(t, s) != 1 {
		t.Fatalf("UPDATE audit positive control: kind=%q contribution=%d", kind, contribution)
	}
	neighborCoalesceExec(t, s.db, `UPDATE neighbor_edges SET count = count - 3 WHERE node_a = 'aaaaaaaaaa'`)
	neighborCoalesceExec(t, s.db, `DELETE FROM neighbor_mutations`)

	// Both directions collide canonically, and each observation contributes
	// the same pair twice (originator/first hop and observer/last hop).
	// Insert timestamps out of order to require the actual per-pair maximum.
	neighborCoalesceObservation(t, s, start+9, "aaaaaaaaaa", `["bb"]`, "aaaaaaaaaa")
	neighborCoalesceObservation(t, s, start+2, "bbbbbbbbbb", `["aa"]`, "bbbbbbbbbb")
	n, err := s.buildAndPersistNeighborEdges()
	if err != nil || n != 4 {
		t.Fatalf("canonical candidate count: got %d, %v; want 4, nil", n, err)
	}
	tail := time.Unix(start+9, 0).UTC().Format(time.RFC3339)
	want := []neighborCoalesceRow{{"aaaaaaaaaa", "bbbbbbbbbb", 11, tail}, {"bbbbbbbbbb", "obs-1", 5, prior}}
	if got := neighborCoalesceRows(t, s); !reflect.DeepEqual(got, want) {
		t.Fatalf("additive counts/MAX timestamps: got %+v, want %+v", got, want)
	}
	if got := neighborCoalesceAuditCount(t, s); got != 1 {
		t.Fatalf("existing pair mutations: got %d, want 1", got)
	}
	if err := s.db.QueryRow(`SELECT kind, contribution FROM neighbor_mutations`).Scan(&kind, &contribution); err != nil {
		t.Fatal(err)
	}
	if kind != "update" || contribution != 4 {
		t.Fatalf("aggregated UPDATE: kind=%q contribution=%d, want update/4", kind, contribution)
	}
}
