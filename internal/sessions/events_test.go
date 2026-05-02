package sessions

import (
	"sync"
	"testing"
	"time"
)

func TestEventsBasicSubscribe(t *testing.T) {
	t.Run("Subscribe receives PartialEvent", func(t *testing.T) {
		r := NewEventsRegistry()
		var mu sync.Mutex
		var got []PartialEvent
		cancel := r.Subscribe("sid", SubscriptionHandlers{
			OnPartial: func(p PartialEvent) {
				mu.Lock()
				defer mu.Unlock()
				got = append(got, p)
			},
		})
		defer cancel()

		r.EmitPartial("sid", PartialEvent{MessageID: "msg_1", Index: 0, Text: "hello"})
		r.EmitPartial("sid", PartialEvent{MessageID: "msg_2", Index: 1, Text: "world"})

		mu.Lock()
		defer mu.Unlock()
		if len(got) != 2 {
			t.Fatalf("want 2 partials, got %d", len(got))
		}
		if got[0].MessageID != "msg_1" || got[0].Text != "hello" {
			t.Errorf("first partial = %+v, want msg_1/hello", got[0])
		}
		if got[1].MessageID != "msg_2" || got[1].Index != 1 || got[1].Text != "world" {
			t.Errorf("second partial = %+v, want msg_2/index 1/world", got[1])
		}
	})

	t.Run("Subscribe receives StatusEvent", func(t *testing.T) {
		r := NewEventsRegistry()
		var mu sync.Mutex
		var got []StatusEvent
		cancel := r.Subscribe("sid", SubscriptionHandlers{
			OnStatus: func(s StatusEvent) {
				mu.Lock()
				defer mu.Unlock()
				got = append(got, s)
			},
		})
		defer cancel()

		r.EmitStatus("sid", StatusEvent{Kind: "thinking"})
		r.EmitStatus("sid", StatusEvent{Kind: "running", Label: "bash"})

		mu.Lock()
		defer mu.Unlock()
		if len(got) != 2 {
			t.Fatalf("want 2 statuses, got %d", len(got))
		}
		if got[0].Kind != "thinking" || got[0].Label != "" {
			t.Errorf("first status = %+v, want thinking/empty label", got[0])
		}
		if got[1].Kind != "running" || got[1].Label != "bash" {
			t.Errorf("second status = %+v, want running/bash", got[1])
		}
	})

	t.Run("Subscribe receives AliveEvent and IsAlive flips", func(t *testing.T) {
		r := NewEventsRegistry()
		var mu sync.Mutex
		var got []bool
		cancel := r.Subscribe("sid", SubscriptionHandlers{
			OnAlive: func(a bool) {
				mu.Lock()
				defer mu.Unlock()
				got = append(got, a)
			},
		})
		defer cancel()

		if r.IsAlive("sid") {
			t.Fatal("IsAlive before any emit should be false")
		}

		r.EmitAlive("sid", true)
		if !r.IsAlive("sid") {
			t.Error("IsAlive after EmitAlive(true) should be true")
		}

		r.EmitAlive("sid", false)
		if r.IsAlive("sid") {
			t.Error("IsAlive after EmitAlive(false) should be false")
		}

		mu.Lock()
		defer mu.Unlock()
		if len(got) != 2 || got[0] != true || got[1] != false {
			t.Errorf("alive observations = %v, want [true false]", got)
		}
	})

	t.Run("Cancel detaches handler", func(t *testing.T) {
		r := NewEventsRegistry()
		var mu sync.Mutex
		var got []PartialEvent
		cancel := r.Subscribe("sid", SubscriptionHandlers{
			OnPartial: func(p PartialEvent) {
				mu.Lock()
				defer mu.Unlock()
				got = append(got, p)
			},
		})

		r.EmitPartial("sid", PartialEvent{MessageID: "msg_before", Text: "a"})
		mu.Lock()
		if len(got) != 1 {
			mu.Unlock()
			t.Fatalf("want 1 partial before cancel, got %d", len(got))
		}
		mu.Unlock()

		cancel()
		// Idempotency: a second cancel call must not panic.
		cancel()

		r.EmitPartial("sid", PartialEvent{MessageID: "msg_after", Text: "b"})
		mu.Lock()
		defer mu.Unlock()
		if len(got) != 1 {
			t.Errorf("want 1 partial after cancel, got %d (handler still attached)", len(got))
		}
	})

	t.Run("Multiple subscribers all receive", func(t *testing.T) {
		r := NewEventsRegistry()
		var muA, muB sync.Mutex
		var gotA, gotB []PartialEvent
		cancelA := r.Subscribe("sid", SubscriptionHandlers{
			OnPartial: func(p PartialEvent) {
				muA.Lock()
				defer muA.Unlock()
				gotA = append(gotA, p)
			},
		})
		defer cancelA()
		cancelB := r.Subscribe("sid", SubscriptionHandlers{
			OnPartial: func(p PartialEvent) {
				muB.Lock()
				defer muB.Unlock()
				gotB = append(gotB, p)
			},
		})
		defer cancelB()

		r.EmitPartial("sid", PartialEvent{MessageID: "msg_1", Text: "x"})

		muA.Lock()
		defer muA.Unlock()
		muB.Lock()
		defer muB.Unlock()
		if len(gotA) != 1 || len(gotB) != 1 {
			t.Errorf("want both subscribers to receive 1 partial; gotA=%d gotB=%d", len(gotA), len(gotB))
		}
	})

	t.Run("Per-session isolation", func(t *testing.T) {
		r := NewEventsRegistry()
		var mu sync.Mutex
		var got []PartialEvent
		cancel := r.Subscribe("sid-A", SubscriptionHandlers{
			OnPartial: func(p PartialEvent) {
				mu.Lock()
				defer mu.Unlock()
				got = append(got, p)
			},
		})
		defer cancel()

		r.EmitPartial("sid-B", PartialEvent{MessageID: "msg_1", Text: "should not arrive"})

		mu.Lock()
		defer mu.Unlock()
		if len(got) != 0 {
			t.Errorf("subscriber to sid-A received %d events from sid-B emit", len(got))
		}
	})

	t.Run("nil handler in SubscriptionHandlers is fine", func(t *testing.T) {
		r := NewEventsRegistry()
		var mu sync.Mutex
		var got []PartialEvent
		cancel := r.Subscribe("sid", SubscriptionHandlers{
			OnPartial: func(p PartialEvent) {
				mu.Lock()
				defer mu.Unlock()
				got = append(got, p)
			},
			// OnAlive and OnStatus deliberately nil.
		})
		defer cancel()

		// These must not panic even though no handler is registered for
		// the alive/status channels on this session.
		r.EmitAlive("sid", true)
		r.EmitStatus("sid", StatusEvent{Kind: "thinking"})
		r.EmitPartial("sid", PartialEvent{MessageID: "msg_1", Text: "ok"})

		mu.Lock()
		defer mu.Unlock()
		if len(got) != 1 {
			t.Errorf("OnPartial should still fire; got %d", len(got))
		}
	})
}

func TestEventsEvictionTimer(t *testing.T) {
	t.Run("Eviction after EmitAlive(false) when no subscribers remain", func(t *testing.T) {
		r := NewEventsRegistry()
		r.evictDelay = 50 * time.Millisecond

		const sid = "sid-evict"
		cancel := r.Subscribe(sid, SubscriptionHandlers{
			OnAlive: func(bool) {},
		})
		cancel()
		r.EmitAlive(sid, false)

		// Wait well past evictDelay so the AfterFunc has fired and the
		// post-fire mutation under r.mu has settled.
		time.Sleep(200 * time.Millisecond)

		r.mu.Lock()
		_, present := r.emitters[sid]
		aliveStored := r.alive[sid]
		r.mu.Unlock()

		if present {
			t.Error("emitter entry should have been evicted")
		}
		if aliveStored {
			t.Error("alive flag should have been cleared on eviction")
		}
		if r.IsAlive(sid) {
			t.Error("IsAlive should report false after eviction")
		}
	})

	t.Run("Reschedule when a subscriber re-attaches during the eviction delay", func(t *testing.T) {
		r := NewEventsRegistry()
		r.evictDelay = 100 * time.Millisecond

		const sid = "sid-resub"
		cancel := r.Subscribe(sid, SubscriptionHandlers{
			OnAlive: func(bool) {},
		})
		cancel()
		r.EmitAlive(sid, false)

		// Two-phase wait: re-attach BEFORE the original evictDelay
		// elapses, then wait past it. The fired timer should observe a
		// listener and reschedule rather than evict, so the entry must
		// still be present.
		time.Sleep(50 * time.Millisecond)
		cancel2 := r.Subscribe(sid, SubscriptionHandlers{
			OnAlive: func(bool) {},
		})
		time.Sleep(200 * time.Millisecond)

		r.mu.Lock()
		_, present := r.emitters[sid]
		r.mu.Unlock()
		if !present {
			t.Fatal("emitter should have been rescheduled, not evicted, while a subscriber was attached")
		}

		// Now drop the late subscriber and wait past one more eviction
		// cycle — the rescheduled timer should fire and evict cleanly.
		cancel2()
		time.Sleep(300 * time.Millisecond)

		r.mu.Lock()
		_, present = r.emitters[sid]
		r.mu.Unlock()
		if present {
			t.Error("emitter should have been evicted after late subscriber detached")
		}
	})
}
