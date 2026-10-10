package main

import (
	"sync/atomic"
	"testing"
	"time"
)

func holdBackgroundRecomputeGate(t *testing.T, store *PacketStore) func() {
	t.Helper()
	started := make(chan struct{})
	release := make(chan struct{})
	go store.runBackgroundRecompute("test-holder", func() interface{} {
		close(started)
		<-release
		return nil
	})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("timed out acquiring background recompute gate")
	}
	return func() { close(release) }
}

func observeBackgroundRecomputeAttempt(store *PacketStore) <-chan string {
	attempted := make(chan string, 1)
	store.backgroundRecomputeAttemptHook = func(name string) {
		select {
		case attempted <- name:
		default:
		}
	}
	return attempted
}

func waitForBackgroundRecomputeAttempt(t *testing.T, attempted <-chan string, want string) {
	t.Helper()
	select {
	case got := <-attempted:
		if got != want {
			t.Fatalf("background recompute attempted %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for %q gate acquisition attempt", want)
	}
}

func exerciseMandatoryStartupRetry(
	t *testing.T,
	store *PacketStore,
	name string,
	start func() func(),
	priorRetained func() bool,
	recoveredPublished func() bool,
) {
	t.Helper()
	failed := make(chan struct{})
	retryStarted := make(chan struct{})
	recoverBuild := make(chan struct{})
	var calls atomic.Int32
	store.backgroundRecomputeBuildHook = func(got string) {
		if got != name {
			return
		}
		switch calls.Add(1) {
		case 1:
			close(failed)
			panic("intentional startup build failure")
		case 2:
			close(retryStarted)
			<-recoverBuild
		}
	}

	returned := make(chan func(), 1)
	go func() { returned <- start() }()
	select {
	case <-failed:
	case <-time.After(time.Second):
		t.Fatal("startup build did not reach injected failure")
	}
	select {
	case <-retryStarted:
	case <-time.After(time.Second):
		t.Fatal("startup did not release the shared gate, back off, and retry")
	}
	select {
	case stop := <-returned:
		stop()
		t.Fatal("startup returned before a successful complete generation")
	default:
	}
	if !priorRetained() {
		t.Fatal("failed startup build replaced the prior complete generation")
	}

	close(recoverBuild)
	var stop func()
	select {
	case stop = <-returned:
	case <-time.After(time.Second):
		t.Fatal("startup did not return after recovery produced a complete generation")
	}
	defer stop()
	if !recoveredPublished() {
		t.Fatal("startup returned without publishing the recovered complete generation")
	}
}

func waitForBackgroundRecomputeSkip(t *testing.T, store *PacketStore, before int64) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if store.BackgroundRecomputeSkips() > before {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("periodic refresh did not record a nonblocking gate skip; skips=%d, want > %d", store.BackgroundRecomputeSkips(), before)
}

func TestNeighborGraphStartupRetriesFailedResponseBuildWithoutPartialCache(t *testing.T) {
	tests := []struct {
		name        string
		panicOnCall int32
	}{
		{name: "default response", panicOnCall: 1},
		{name: "unfiltered response", panicOnCall: 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := NewPacketStore(nil, nil)
			failed := make(chan struct{})
			retryStarted := make(chan struct{})
			releaseRetry := make(chan struct{})
			var calls atomic.Int32
			srv := &Server{
				store: store,
				computeNeighborGraphResponseFn: func(int, float64, string, string) NeighborGraphResponse {
					call := calls.Add(1)
					if call == tt.panicOnCall {
						close(failed)
						panic("intentional startup build failure")
					}
					if call == tt.panicOnCall+1 {
						close(retryStarted)
						<-releaseRetry
					}
					return NeighborGraphResponse{}
				},
			}
			stop := make(chan struct{})
			returned := make(chan struct{})
			go func() {
				srv.startNeighborGraphRecomputer(time.Hour, stop)
				close(returned)
			}()

			select {
			case <-failed:
			case <-time.After(time.Second):
				t.Fatal("startup response build did not reach injected failure")
			}
			select {
			case <-retryStarted:
			case <-time.After(time.Second):
				t.Fatal("startup did not begin a retry after the failed response build")
			}
			select {
			case <-returned:
				t.Fatal("startup returned after a failed response build")
			default:
			}
			if srv.neighborGraphCache.snapshot.Load() != nil || srv.neighborGraphCache.ptr.Load() != nil || srv.neighborGraphCache.unfilteredPtr.Load() != nil {
				t.Fatal("failed startup response build published a partial cache")
			}

			close(releaseRetry)
			select {
			case <-returned:
			case <-time.After(time.Second):
				t.Fatal("startup did not return after a successful retry")
			}
			close(stop)
			if srv.neighborGraphCache.ptr.Load() == nil || srv.neighborGraphCache.unfilteredPtr.Load() == nil {
				t.Fatal("startup retry returned without both response caches populated")
			}
		})
	}
}

func TestAllocationHeavyRefreshersWaitForStartupGateAndPopulate(t *testing.T) {
	t.Run("neighbor graph response cache", func(t *testing.T) {
		store := NewPacketStore(nil, nil)
		srv := &Server{
			store: store,
			computeNeighborGraphResponseFn: func(int, float64, string, string) NeighborGraphResponse {
				return NeighborGraphResponse{}
			},
		}
		release := holdBackgroundRecomputeGate(t, store)
		attempted := observeBackgroundRecomputeAttempt(store)
		stop := make(chan struct{})
		returned := make(chan struct{})
		go func() {
			srv.startNeighborGraphRecomputer(time.Hour, stop)
			close(returned)
		}()
		waitForBackgroundRecomputeAttempt(t, attempted, "neighbor-graph-cache")
		select {
		case <-returned:
			t.Fatal("startup warmup bypassed the shared gate")
		default:
		}
		release()
		select {
		case <-returned:
		case <-time.After(time.Second):
			t.Fatal("startup warmup did not resume after gate release")
		}
		defer close(stop)
		if srv.neighborGraphCache.ptr.Load() == nil || srv.neighborGraphCache.unfilteredPtr.Load() == nil {
			t.Fatal("startup warmup returned without populating both neighbor graph response caches")
		}
	})

	t.Run("repeater enrichment", func(t *testing.T) {
		store := NewPacketStore(nil, nil)
		store.subpathReady.Store(true)
		store.pathHopReady.Store(true)
		release := holdBackgroundRecomputeGate(t, store)
		attempted := observeBackgroundRecomputeAttempt(store)
		returned := make(chan func(), 1)
		go func() { returned <- store.StartRepeaterEnrichmentRecomputer(24, time.Hour) }()
		waitForBackgroundRecomputeAttempt(t, attempted, "repeater-enrichment")
		select {
		case stop := <-returned:
			stop()
			t.Fatal("startup warmup bypassed the shared gate")
		default:
		}
		release()
		var stop func()
		select {
		case stop = <-returned:
		case <-time.After(time.Second):
			t.Fatal("startup warmup did not resume after gate release")
		}
		defer stop()
		store.repeaterEnrichMu.Lock()
		populated := store.repeaterRelayCache != nil && store.repeaterUsefulCache != nil
		store.repeaterEnrichMu.Unlock()
		if !populated {
			t.Fatal("startup warmup returned without populating repeater enrichment caches")
		}
	})

	t.Run("bridge scores", func(t *testing.T) {
		resetBridgeRecomputerForTest()
		defer resetBridgeRecomputerForTest()
		store := NewPacketStore(nil, nil)
		release := holdBackgroundRecomputeGate(t, store)
		attempted := observeBackgroundRecomputeAttempt(store)
		returned := make(chan func(), 1)
		go func() { returned <- store.StartBridgeScoreRecomputer(time.Hour) }()
		waitForBackgroundRecomputeAttempt(t, attempted, "bridge-scores")
		select {
		case stop := <-returned:
			stop()
			t.Fatal("startup warmup bypassed the shared gate")
		default:
		}
		release()
		var stop func()
		select {
		case stop = <-returned:
		case <-time.After(time.Second):
			t.Fatal("startup warmup did not resume after gate release")
		}
		defer stop()
		if store.bridgeScoreMap.Load() == nil {
			t.Fatal("startup warmup returned without populating bridge score cache")
		}
	})

	t.Run("usefulness axes", func(t *testing.T) {
		store := NewPacketStore(nil, nil)
		release := holdBackgroundRecomputeGate(t, store)
		attempted := observeBackgroundRecomputeAttempt(store)
		returned := make(chan func(), 1)
		go func() { returned <- store.StartUsefulnessAxesRecomputer(time.Hour) }()
		waitForBackgroundRecomputeAttempt(t, attempted, "usefulness-axes")
		select {
		case stop := <-returned:
			stop()
			t.Fatal("startup warmup bypassed the shared gate")
		default:
		}
		release()
		var stop func()
		select {
		case stop = <-returned:
		case <-time.After(time.Second):
			t.Fatal("startup warmup did not resume after gate release")
		}
		defer stop()
		if store.coverageScoreMap.Load() == nil || store.redundancyScoreMap.Load() == nil {
			t.Fatal("startup warmup returned without populating both usefulness axes caches")
		}
	})
}

func TestMandatoryStartupRefreshersRetryFailedBuilds(t *testing.T) {
	t.Run("repeater enrichment", func(t *testing.T) {
		store := NewPacketStore(nil, nil)
		store.subpathReady.Store(true)
		store.pathHopReady.Store(true)
		store.repeaterRelayCache = map[string]RepeaterRelayInfo{"prior": {}}
		store.repeaterUsefulCache = map[string]float64{"prior": 1}
		exerciseMandatoryStartupRetry(t, store, "repeater-enrichment",
			func() func() { return store.StartRepeaterEnrichmentRecomputer(24, time.Hour) },
			func() bool {
				store.repeaterEnrichMu.Lock()
				defer store.repeaterEnrichMu.Unlock()
				_, relayOK := store.repeaterRelayCache["prior"]
				_, usefulOK := store.repeaterUsefulCache["prior"]
				return relayOK && usefulOK
			},
			func() bool {
				store.repeaterEnrichMu.Lock()
				defer store.repeaterEnrichMu.Unlock()
				_, relayOld := store.repeaterRelayCache["prior"]
				_, usefulOld := store.repeaterUsefulCache["prior"]
				return !relayOld && !usefulOld
			})
	})

	t.Run("bridge scores", func(t *testing.T) {
		resetBridgeRecomputerForTest()
		defer resetBridgeRecomputerForTest()
		store := NewPacketStore(nil, nil)
		store.graph.Store(NewNeighborGraph())
		prior := map[string]float64{"prior": 1}
		store.bridgeScoreMap.Store(&prior)
		exerciseMandatoryStartupRetry(t, store, "bridge-scores",
			func() func() { return store.StartBridgeScoreRecomputer(time.Hour) },
			func() bool { return store.GetBridgeScore("prior") == 1 },
			func() bool { return store.GetBridgeScore("prior") == 0 && store.bridgeScoreMap.Load() != nil })
	})

	t.Run("usefulness axes", func(t *testing.T) {
		store := NewPacketStore(nil, nil)
		store.graph.Store(NewNeighborGraph())
		priorCoverage := map[string]float64{"prior": 1}
		priorRedundancy := map[string]float64{"prior": 1}
		store.coverageScoreMap.Store(&priorCoverage)
		store.redundancyScoreMap.Store(&priorRedundancy)
		exerciseMandatoryStartupRetry(t, store, "usefulness-axes",
			func() func() { return store.StartUsefulnessAxesRecomputer(time.Hour) },
			func() bool { return store.GetCoverageScore("prior") == 1 && store.GetRedundancyScore("prior") == 1 },
			func() bool {
				return store.GetCoverageScore("prior") == 0 && store.GetRedundancyScore("prior") == 0 &&
					store.coverageScoreMap.Load() != nil && store.redundancyScoreMap.Load() != nil
			})
	})
}

func TestAnalyticsMandatoryStartupRetriesFailedBuild(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()
	store := NewPacketStore(db, nil)
	failed := make(chan struct{})
	retried := make(chan struct{})
	var topologyAttempts atomic.Int32
	store.backgroundRecomputeBuildHook = func(name string) {
		if name != "topology" {
			return
		}
		switch topologyAttempts.Add(1) {
		case 1:
			close(failed)
			panic("intentional analytics startup build failure")
		case 2:
			close(retried)
		}
	}

	returned := make(chan func(), 1)
	go func() {
		returned <- store.StartAnalyticsRecomputers(time.Hour)
	}()

	select {
	case <-failed:
	case <-time.After(time.Second):
		t.Fatal("analytics startup did not reach injected failure")
	}
	select {
	case <-returned:
		t.Fatal("analytics startup returned after failed mandatory warmup")
	case <-time.After(25 * time.Millisecond):
	}
	select {
	case <-retried:
	case <-time.After(time.Second):
		t.Fatal("analytics startup did not retry failed mandatory warmup")
	}

	var stop func()
	select {
	case stop = <-returned:
	case <-time.After(time.Second):
		t.Fatal("analytics startup did not return after successful retry")
	}
	defer stop()
	if store.recompTopology == nil || store.recompTopology.Load() == nil {
		t.Fatal("analytics startup returned without populated topology cache")
	}
}

func TestAllocationHeavyPeriodicRefreshersSkipBusyGate(t *testing.T) {
	t.Run("neighbor graph response cache", func(t *testing.T) {
		store := NewPacketStore(nil, nil)
		srv := &Server{
			store: store,
			computeNeighborGraphResponseFn: func(int, float64, string, string) NeighborGraphResponse {
				return NeighborGraphResponse{}
			},
		}
		stop := make(chan struct{})
		srv.startNeighborGraphRecomputer(10*time.Millisecond, stop)
		defer close(stop)
		release := holdBackgroundRecomputeGate(t, store)
		defer release()
		waitForBackgroundRecomputeSkip(t, store, store.BackgroundRecomputeSkips())
	})

	t.Run("repeater enrichment", func(t *testing.T) {
		store := NewPacketStore(nil, nil)
		store.subpathReady.Store(true)
		store.pathHopReady.Store(true)
		stop := store.StartRepeaterEnrichmentRecomputer(24, 10*time.Millisecond)
		defer stop()
		release := holdBackgroundRecomputeGate(t, store)
		defer release()
		waitForBackgroundRecomputeSkip(t, store, store.BackgroundRecomputeSkips())
	})

	t.Run("bridge scores", func(t *testing.T) {
		resetBridgeRecomputerForTest()
		defer resetBridgeRecomputerForTest()
		store := NewPacketStore(nil, nil)
		stop := store.StartBridgeScoreRecomputer(10 * time.Millisecond)
		defer stop()
		release := holdBackgroundRecomputeGate(t, store)
		defer release()
		waitForBackgroundRecomputeSkip(t, store, store.BackgroundRecomputeSkips())
	})

	t.Run("usefulness axes", func(t *testing.T) {
		store := NewPacketStore(nil, nil)
		stop := store.StartUsefulnessAxesRecomputer(10 * time.Millisecond)
		defer stop()
		release := holdBackgroundRecomputeGate(t, store)
		defer release()
		waitForBackgroundRecomputeSkip(t, store, store.BackgroundRecomputeSkips())
	})
}
