package server

import (
	"testing"
)

func TestCloseAllSubscribers(t *testing.T) {
	s := newTestState(t)

	// Register two SSE subscribers.
	ch1 := make(chan sseEvent, 1)
	ch2 := make(chan sseEvent, 1)
	s.subMu.Lock()
	s.subscribers[ch1] = struct{}{}
	s.subscribers[ch2] = struct{}{}
	s.subMu.Unlock()

	s.CloseAllSubscribers()

	// Both channels should be closed (receiving immediately yields zero value).
	if _, ok := <-ch1; ok {
		t.Fatal("ch1 should be closed")
	}
	if _, ok := <-ch2; ok {
		t.Fatal("ch2 should be closed")
	}

	// Subscriber map should be empty.
	s.subMu.Lock()
	if len(s.subscribers) != 0 {
		t.Fatalf("expected empty subscribers, got %d", len(s.subscribers))
	}
	s.subMu.Unlock()
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
