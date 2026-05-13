package server

import (
	"testing"
	"time"
)

func TestCloseAllSubscribers(t *testing.T) {
	s := newTestState(t)

	// Register two SSE subscribers via the public API rather than poking the
	// internal map directly — this guarantees we exercise the same code path
	// that real handlers use.
	ch1 := s.Subscribe()
	ch2 := s.Subscribe()

	// Populate at least one fileChangeTimer so CloseAllSubscribers exercises
	// its timer-cleanup branch.
	s.mu.Lock()
	s.fileChangeTimers["/x"] = time.AfterFunc(time.Hour, func() {})
	s.mu.Unlock()

	s.CloseAllSubscribers()

	// Both channels should be closed: receive should return !ok promptly. If
	// the channel is still open, the receive will block forever, so use a
	// timeout to fail fast on regression.
	select {
	case _, ok := <-ch1:
		if ok {
			t.Fatal("ch1 should be closed")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("read from ch1 blocked; channel was not closed")
	}
	select {
	case _, ok := <-ch2:
		if ok {
			t.Fatal("ch2 should be closed")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("read from ch2 blocked; channel was not closed")
	}

	// Subscriber map should be empty.
	s.subMu.Lock()
	if len(s.subscribers) != 0 {
		t.Fatalf("expected empty subscribers, got %d", len(s.subscribers))
	}
	s.subMu.Unlock()

	// fileChangeTimers should also be empty after cleanup.
	s.mu.Lock()
	if len(s.fileChangeTimers) != 0 {
		t.Fatalf("expected empty fileChangeTimers, got %d", len(s.fileChangeTimers))
	}
	s.mu.Unlock()
}

func TestRestartChAndShutdownChAccessors(t *testing.T) {
	s := newTestState(t)

	// RestartCh and ShutdownCh return read-only channels backed by the State's
	// internal channels.
	rc := s.RestartCh()
	sc := s.ShutdownCh()
	if rc == nil || sc == nil {
		t.Fatal("RestartCh/ShutdownCh returned nil")
	}

	// Push to the underlying channels and read via the accessors.
	s.restartCh <- "/some/path"
	select {
	case v := <-rc:
		if v != "/some/path" {
			t.Fatalf("got %q, want /some/path", v)
		}
	default:
		t.Fatal("expected restart channel to deliver value")
	}

	s.shutdownCh <- struct{}{}
	select {
	case <-sc:
		// ok
	default:
		t.Fatal("expected shutdown channel to deliver value")
	}
}
