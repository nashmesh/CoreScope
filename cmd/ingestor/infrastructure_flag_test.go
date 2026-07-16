package main

import "testing"

// Infrastructure flag (#infra): operator-curated column set by
// scripts/set-infra.sh, never by the ingest path. These tests pin the
// two persistence guarantees the feature relies on:
//  1. UpsertNode's ON CONFLICT update must NOT wipe the flag when the
//     node re-adverts (it only touches name/role/lat/lon/last_seen).
//  2. MoveStaleNodes' `INSERT OR REPLACE INTO inactive_nodes SELECT *
//     FROM nodes` must carry the flag into inactive_nodes (requires
//     identical column order across both tables — dbschema adds the
//     column to both in the same Apply pass).
func TestInfrastructureFlagSurvivesAdvertUpsert(t *testing.T) {
	store := newTestStore(t)

	pk := "deadbeef1234567890abcdef12345678"
	if err := store.UpsertNode(pk, "Tower Node", "repeater", nil, nil, "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}

	// Operator marks the node as infrastructure (what set-infra.sh does).
	if _, err := store.db.Exec(`UPDATE nodes SET infrastructure = 1 WHERE public_key = ?`, pk); err != nil {
		t.Fatal(err)
	}

	// A later advert re-upserts the node.
	if err := store.UpsertNode(pk, "Tower Node v2", "repeater", nil, nil, "2026-01-02T00:00:00Z"); err != nil {
		t.Fatal(err)
	}

	var infra int
	if err := store.db.QueryRow(`SELECT infrastructure FROM nodes WHERE public_key = ?`, pk).Scan(&infra); err != nil {
		t.Fatal(err)
	}
	if infra != 1 {
		t.Errorf("infrastructure flag wiped by UpsertNode: got %d, want 1", infra)
	}
}

func TestInfrastructureFlagSurvivesMoveStaleNodes(t *testing.T) {
	store := newTestStore(t)

	pk := "cafef00d1234567890abcdef12345678"
	if err := store.UpsertNode(pk, "Peak Node", "repeater", nil, nil, "2020-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE nodes SET infrastructure = 1 WHERE public_key = ?`, pk); err != nil {
		t.Fatal(err)
	}

	moved, err := store.MoveStaleNodes(7)
	if err != nil {
		t.Fatal(err)
	}
	if moved != 1 {
		t.Fatalf("moved=%d, want 1", moved)
	}

	var infra int
	if err := store.db.QueryRow(`SELECT infrastructure FROM inactive_nodes WHERE public_key = ?`, pk).Scan(&infra); err != nil {
		t.Fatal(err)
	}
	if infra != 1 {
		t.Errorf("infrastructure flag lost on retention move: got %d, want 1", infra)
	}
}
