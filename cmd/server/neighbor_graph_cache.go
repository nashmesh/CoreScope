package main

import (
	"bytes"
	"encoding/json"
	"log"
	"runtime/debug"
	"strconv"
	"sync/atomic"
	"time"
)

// #1481 P0-1: cached default-filter neighbor-graph response.
//
// The /api/analytics/neighbor-graph handler does graph build + per-edge
// score + filter + ~900KB JSON marshal on every request. The default
// (no-region, no-role, minCount=5, minScore=0.1) shape covers the
// overwhelming majority of organic traffic; cache the fully-built AND
// pre-marshaled response so warm reads are a single Write. Recomputed
// every 5 minutes in the background — never on the hot path.

const neighborGraphCacheInterval = 5 * time.Minute

const neighborGraphStartupRetryInterval = 100 * time.Millisecond

// neighborGraphCacheEntry holds both the response struct (kept for
// tests / structured access) and the pre-marshaled bytes that the
// handler writes verbatim.
type neighborGraphCacheEntry struct {
	resp NeighborGraphResponse
	json []byte
	at   time.Time
}

type neighborGraphCacheSnapshot struct {
	defaultEntry    *neighborGraphCacheEntry
	unfilteredEntry *neighborGraphCacheEntry
}

type neighborGraphCacheField struct {
	// snapshot is the canonical read path so both response shapes become
	// visible in one atomic publication.
	snapshot atomic.Pointer[neighborGraphCacheSnapshot]
	// Keep the per-shape pointers for focused cache seeding and inspection.
	// Runtime reads prefer snapshot once the recomputer has published one.
	ptr atomic.Pointer[neighborGraphCacheEntry]
	// unfiltered = the (minCount=1, minScore=0, no region/role) shape
	// the analytics tab actually hits. Cached separately so the UI
	// tab also benefits from the warm path; client-side sliders then
	// filter from full data. #1483 follow-up to perf claim.
	unfilteredPtr atomic.Pointer[neighborGraphCacheEntry]
}

// startNeighborGraphRecomputer launches a background goroutine that
// rebuilds the default-shape response every interval. Returns when
// the stop channel is closed.
func (s *Server) startNeighborGraphRecomputer(interval time.Duration, stop <-chan struct{}) {
	if interval <= 0 {
		interval = neighborGraphCacheInterval
	}
	// Startup warmup is mandatory. Retry failed builds with bounded backoff,
	// releasing the shared gate between attempts, so Start cannot return with
	// nil or partial response caches and persistent failures do not busy-spin.
	for {
		populated := false
		if s.store != nil {
			s.store.runBackgroundRecompute("neighbor-graph-cache", func() interface{} {
				populated = s.recomputeNeighborGraphCache()
				return struct{}{}
			})
		} else {
			// Preserve compatibility for focused callers that construct a Server
			// without a PacketStore.
			populated = s.recomputeNeighborGraphCache()
		}
		if populated {
			break
		}
		time.Sleep(neighborGraphStartupRetryInterval)
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				if s.store != nil {
					_, _ = s.store.tryBackgroundRecompute("neighbor-graph-cache", func() interface{} {
						s.recomputeNeighborGraphCache()
						return struct{}{}
					})
				} else {
					s.recomputeNeighborGraphCache()
				}
			case <-stop:
				return
			}
		}
	}()
}

// recomputeNeighborGraphCache builds and pre-marshals the default-shape
// responses and publishes them only after both builds succeed. Panic-defensive so a single bad
// rebuild doesn't kill the background goroutine — but logs the panic
// and increments a counter so operators see the failure (#1483 follow-up).
func (s *Server) recomputeNeighborGraphCache() (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[neighbor-graph-cache] rebuild panic: %v\n%s", r, debug.Stack())
			atomic.AddUint64(&s.neighborGraphCacheRebuildFailures, 1)
			ok = false
		}
	}()
	start := time.Now()
	resp := s.buildDefaultNeighborGraphResponse()
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(resp); err != nil {
		log.Printf("[neighbor-graph-cache] marshal error: %v", err)
		atomic.AddUint64(&s.neighborGraphCacheRebuildFailures, 1)
		return false
	}
	entry := &neighborGraphCacheEntry{
		resp: resp,
		json: buf.Bytes(),
		at:   time.Now(),
	}

	// Build + cache the analytics-tab shape (minCount=1, minScore=0).
	// This is what the UI actually fetches so it can slider client-side.
	// Cached separately so its TTL stays aligned with the default cache.
	uResp := s.computeNeighborGraphResponseDispatch(1, 0, "", "")
	var uBuf bytes.Buffer
	if err := json.NewEncoder(&uBuf).Encode(uResp); err != nil {
		log.Printf("[neighbor-graph-cache] unfiltered marshal error: %v", err)
		atomic.AddUint64(&s.neighborGraphCacheRebuildFailures, 1)
		return false
	}
	uEntry := &neighborGraphCacheEntry{
		resp: uResp,
		json: uBuf.Bytes(),
		at:   time.Now(),
	}

	// Publish the pair atomically so readers cannot observe response shapes
	// from different rebuilds. Keep the per-shape mirrors for focused callers.
	s.neighborGraphCache.snapshot.Store(&neighborGraphCacheSnapshot{
		defaultEntry:    entry,
		unfilteredEntry: uEntry,
	})
	s.neighborGraphCache.ptr.Store(entry)
	s.neighborGraphCache.unfilteredPtr.Store(uEntry)
	log.Printf("[neighbor-graph-cache] rebuild ok in %v, nodes=%d, unfiltered_nodes=%d", time.Since(start), len(resp.Nodes), len(uResp.Nodes))
	return true
}

// loadNeighborGraphCache returns the cached default response if present.
func (s *Server) loadNeighborGraphCache() (NeighborGraphResponse, bool) {
	e := s.loadDefaultNeighborGraphCacheEntry()
	if e == nil {
		return NeighborGraphResponse{}, false
	}
	return e.resp, true
}

// loadNeighborGraphCacheBytes returns the pre-marshaled JSON for the
// cached default response if present, along with the age of the
// snapshot (zero when no entry is present).
func (s *Server) loadNeighborGraphCacheBytes() ([]byte, time.Duration, bool) {
	e := s.loadDefaultNeighborGraphCacheEntry()
	if e == nil || len(e.json) == 0 {
		return nil, 0, false
	}
	age := time.Duration(0)
	if !e.at.IsZero() {
		age = time.Since(e.at)
	}
	return e.json, age, true
}

// loadNeighborGraphCacheBytesUnfiltered returns the pre-marshaled JSON
// for the (minCount=1, minScore=0) cache shape used by the analytics
// tab. #1483 follow-up.
func (s *Server) loadNeighborGraphCacheBytesUnfiltered() ([]byte, time.Duration, bool) {
	e := s.loadUnfilteredNeighborGraphCacheEntry()
	if e == nil || len(e.json) == 0 {
		return nil, 0, false
	}
	age := time.Duration(0)
	if !e.at.IsZero() {
		age = time.Since(e.at)
	}
	return e.json, age, true
}

func (s *Server) loadDefaultNeighborGraphCacheEntry() *neighborGraphCacheEntry {
	if snapshot := s.neighborGraphCache.snapshot.Load(); snapshot != nil {
		return snapshot.defaultEntry
	}
	return s.neighborGraphCache.ptr.Load()
}

func (s *Server) loadUnfilteredNeighborGraphCacheEntry() *neighborGraphCacheEntry {
	if snapshot := s.neighborGraphCache.snapshot.Load(); snapshot != nil {
		return snapshot.unfilteredEntry
	}
	return s.neighborGraphCache.unfilteredPtr.Load()
}

// cacheAgeSecondsHeader formats a time.Duration as integer seconds for
// the X-Cache-Age-Seconds response header.
func cacheAgeSecondsHeader(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	return strconv.FormatInt(int64(d/time.Second), 10)
}
