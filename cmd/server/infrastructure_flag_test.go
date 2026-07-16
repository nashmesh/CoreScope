package main

import (
	"testing"
	"time"
)

// Infrastructure flag (#infra): operator-curated column written by
// scripts/set-infra.sh, surfaced read-only by the server as the
// `infrastructure` boolean on node responses. These tests pin:
//  1. detectSchema PRAGMA-detects the column (hasInfrastructure).
//  2. GetNodes / GetNodeByPubkey / SearchNodes expose the flag.
//  3. Old-DB compat: without the column the field is present and false
//     (stable API shape, no scan error).

// addInfrastructureColumn upgrades the test schema to post-migration
// shape and re-detects, mirroring prod (ingestor migrates, server
// PRAGMA-detects at startup).
func addInfrastructureColumn(t *testing.T, db *DB) {
	t.Helper()
	if _, err := db.conn.Exec(`ALTER TABLE nodes ADD COLUMN infrastructure INTEGER NOT NULL DEFAULT 0`); err != nil {
		t.Fatal(err)
	}
	db.detectSchema()
	if !db.hasInfrastructure {
		t.Fatal("detectSchema should set hasInfrastructure after ALTER")
	}
}

func TestInfrastructureFlagExposedOnNodeReads(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()
	addInfrastructureColumn(t, db)

	recent := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	if _, err := db.conn.Exec(`INSERT INTO nodes (public_key, name, role, last_seen, first_seen, infrastructure)
		VALUES ('aabb00000000000000000000000000aa', 'Tower', 'repeater', ?, ?, 1),
		       ('ccdd00000000000000000000000000cc', 'Valley', 'companion', ?, ?, 0)`,
		recent, recent, recent, recent); err != nil {
		t.Fatal(err)
	}

	nodes, _, _, err := db.GetNodes(10, 0, "", "", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, n := range nodes {
		infra, ok := n["infrastructure"].(bool)
		if !ok {
			t.Fatalf("node %v: infrastructure should be a bool, got %T", n["public_key"], n["infrastructure"])
		}
		got[n["public_key"].(string)] = infra
	}
	if !got["aabb00000000000000000000000000aa"] {
		t.Error("GetNodes: marked node should have infrastructure=true")
	}
	if got["ccdd00000000000000000000000000cc"] {
		t.Error("GetNodes: unmarked node should have infrastructure=false")
	}

	// Detail read path.
	node, err := db.GetNodeByPubkey("aabb00000000000000000000000000aa")
	if err != nil {
		t.Fatal(err)
	}
	if node == nil || node["infrastructure"] != true {
		t.Errorf("GetNodeByPubkey: want infrastructure=true, got %v", node["infrastructure"])
	}

	// Search read path.
	results, err := db.SearchNodes("Tower", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0]["infrastructure"] != true {
		t.Errorf("SearchNodes: want 1 result with infrastructure=true, got %v", results)
	}
}

func TestInfrastructureFlagOldDBDefaultsFalse(t *testing.T) {
	db := setupTestDB(t) // schema WITHOUT the infrastructure column
	defer db.Close()
	if db.hasInfrastructure {
		t.Fatal("test premise broken: setupTestDB should not have the infrastructure column")
	}
	seedTestData(t, db)

	nodes, _, _, err := db.GetNodes(10, 0, "", "", "", "", "", "")
	if err != nil {
		t.Fatalf("GetNodes on pre-migration DB: %v", err)
	}
	if len(nodes) == 0 {
		t.Fatal("expected seeded nodes")
	}
	for _, n := range nodes {
		if n["infrastructure"] != false {
			t.Errorf("node %v: pre-migration DB should expose infrastructure=false, got %v",
				n["public_key"], n["infrastructure"])
		}
	}
}
