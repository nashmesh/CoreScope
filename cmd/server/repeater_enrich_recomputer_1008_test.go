// Issue #1008 review M1: StartRepeaterEnrichmentRecomputer must wait
// for the background subpath+pathHop index builds before doing its
// synchronous prewarm — otherwise the prewarm reads an empty
// s.byPathHop and locks zeroed enrichment into s.repeaterRelayCache
// for the entire ticker interval.
package main

import (
	"testing"
	"time"
)

// TestIssue1008_M1_PrewarmWaitsForIndexes asserts that an elapsed polling
// timeout does not turn the mandatory startup prewarm into a best-effort
// operation. Start must remain blocked until the indexes become ready, then
// return only after both enrichment caches are populated.
func TestIssue1008_M1_PrewarmWaitsForIndexes(t *testing.T) {
	db := setupRichTestDB(t)
	defer db.Close()
	store := NewPacketStore(db, nil)
	if err := store.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	// Wait for the background builder to finish so it can't race past
	// our Store(false) below. Once it's done it won't write the flags
	// again, so flipping them back to false is stable.
	if !store.WaitIndexesReady(5 * time.Second) {
		t.Fatal("background builds never finished")
	}
	// Force the ready flags back to false to simulate the race where
	// the recomputer is started before background builds finish. Also
	// reset the broadcast channel — it was closed when the background
	// builder flipped both flags true; if we left it closed,
	// WaitIndexesReady would return immediately on the channel select
	// (correct for production semantics where flags never reset,
	// wrong for this synthetic test).
	store.subpathReady.Store(false)
	store.pathHopReady.Store(false)
	store.indexReadyChMu.Lock()
	store.indexReadyChan = nil
	store.indexReadyChMu.Unlock()

	// Use a tiny polling wait so this test crosses the old timeout path quickly.
	prev := repeaterEnrichmentPrewarmWait
	repeaterEnrichmentPrewarmWait = 10 * time.Millisecond
	defer func() { repeaterEnrichmentPrewarmWait = prev }()

	returned := make(chan func(), 1)
	go func() {
		returned <- store.StartRepeaterEnrichmentRecomputer(24, time.Hour)
	}()

	// Crossing several polling timeouts must not let startup return with empty
	// caches.
	time.Sleep(50 * time.Millisecond)
	select {
	case stop := <-returned:
		stop()
		t.Fatal("startup returned after index wait timeout instead of remaining blocked")
	default:
	}

	store.repeaterEnrichMu.Lock()
	populatedBeforeReady := store.repeaterRelayCache != nil || store.repeaterUsefulCache != nil
	store.repeaterEnrichMu.Unlock()
	if populatedBeforeReady {
		t.Fatal("startup populated enrichment caches before prerequisite indexes were ready")
	}

	store.markIndexesReadySync()
	var stop func()
	select {
	case stop = <-returned:
	case <-time.After(time.Second):
		t.Fatal("startup did not complete after prerequisite indexes became ready")
	}
	defer stop()

	store.repeaterEnrichMu.Lock()
	populated := store.repeaterRelayCache != nil && store.repeaterUsefulCache != nil
	store.repeaterEnrichMu.Unlock()
	if !populated {
		t.Fatal("startup returned without populating both repeater enrichment caches")
	}
}

// TestIssue1008_M1_PrewarmRunsWhenReady asserts the prewarm still runs
// (cache populated) when the indexes are already ready.
func TestIssue1008_M1_PrewarmRunsWhenReady(t *testing.T) {
	db := setupRichTestDB(t)
	defer db.Close()
	store := NewPacketStore(db, nil)
	if err := store.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !store.WaitIndexesReady(5 * time.Second) {
		t.Fatal("indexes never ready")
	}

	stop := store.StartRepeaterEnrichmentRecomputer(24, time.Hour)
	defer stop()

	// Prewarm is synchronous on the caller's goroutine, so after
	// Start returns the cache must be populated.
	store.repeaterEnrichMu.Lock()
	at := store.repeaterRelayAt
	store.repeaterEnrichMu.Unlock()

	if at.IsZero() {
		t.Fatal("expected prewarm to populate repeaterRelayAt when indexes ready (#1008 M1)")
	}
}
