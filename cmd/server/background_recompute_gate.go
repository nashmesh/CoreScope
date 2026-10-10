package main

import (
	"log"
	"time"
)

const mandatoryBackgroundRecomputeRetryInterval = 100 * time.Millisecond

func (s *PacketStore) initBackgroundRecomputeGate() {
	s.backgroundRecomputeGateOnce.Do(func() {
		s.backgroundRecomputeGate = make(chan struct{}, 1)
	})
}

// runBackgroundRecompute waits for the gate. It is used for mandatory startup
// warmups, where every cache must be populated before Start returns.
func (s *PacketStore) runBackgroundRecompute(name string, compute func() interface{}) interface{} {
	if compute == nil {
		return nil
	}
	s.initBackgroundRecomputeGate()
	if s.backgroundRecomputeAttemptHook != nil {
		s.backgroundRecomputeAttemptHook(name)
	}
	s.backgroundRecomputeGate <- struct{}{}
	defer func() { <-s.backgroundRecomputeGate }()
	return compute()
}

// runMandatoryBackgroundRecompute retries until a complete generation is
// built. Each failed attempt releases the shared gate before the bounded
// backoff so unrelated refreshers can make progress.
func (s *PacketStore) runMandatoryBackgroundRecompute(name string, compute func() bool) {
	for {
		result := s.runBackgroundRecompute(name, func() interface{} { return compute() })
		if ok, _ := result.(bool); ok {
			return
		}
		time.Sleep(mandatoryBackgroundRecomputeRetryInterval)
	}
}

// tryBackgroundRecompute runs one allocation-heavy background refresh at a
// time. A tick that arrives while another refresh is active is skipped rather
// than queued: cached snapshots remain valid, and the next periodic tick will
// retry without building an unbounded backlog.
func (s *PacketStore) tryBackgroundRecompute(name string, compute func() interface{}) (interface{}, bool) {
	if compute == nil {
		return nil, false
	}
	s.initBackgroundRecomputeGate()
	if s.backgroundRecomputeAttemptHook != nil {
		s.backgroundRecomputeAttemptHook(name)
	}
	select {
	case s.backgroundRecomputeGate <- struct{}{}:
		defer func() { <-s.backgroundRecomputeGate }()
		return compute(), true
	default:
		skips := s.backgroundRecomputeSkips.Add(1)
		log.Printf("[recompute] skipped %s refresh while another background refresh is active (total_skips=%d)", name, skips)
		return nil, false
	}
}

func (s *PacketStore) BackgroundRecomputeSkips() int64 {
	return s.backgroundRecomputeSkips.Load()
}
