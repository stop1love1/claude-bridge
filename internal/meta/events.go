package meta

import "sync"

// MetaChangeKind discriminates the per-task lifecycle event the bus
// emits. Names match libs/meta.ts MetaChangeEvent.kind exactly so the
// SSE route in S12 can serialize them straight to the client.
type MetaChangeKind string

const (
	MetaChangeSpawned     MetaChangeKind = "spawned"
	MetaChangeTransition  MetaChangeKind = "transition"
	MetaChangeUpdated     MetaChangeKind = "updated"
	MetaChangeWriteMeta   MetaChangeKind = "writeMeta"
	MetaChangeRetried     MetaChangeKind = "retried"
	MetaChangeTaskSection MetaChangeKind = "task-section"
)

// MetaChangeEvent is the payload pushed to subscribers whenever a
// task's meta.json mutates. Mirrors the TS shape exactly so the SSE
// stream can JSON-encode it without translation.
type MetaChangeEvent struct {
	TaskID      string         `json:"taskId"`
	Kind        MetaChangeKind `json:"kind"`
	SessionID   string         `json:"sessionId,omitempty"`
	Run         *Run           `json:"run,omitempty"`
	PrevStatus  RunStatus      `json:"prevStatus,omitempty"`
	RetryOf     string         `json:"retryOf,omitempty"`
	PrevSection TaskSection    `json:"prevSection,omitempty"`
	NextSection TaskSection    `json:"nextSection,omitempty"`
	TaskTitle   string         `json:"taskTitle,omitempty"`
	TaskChecked bool           `json:"taskChecked,omitempty"`
}

type metaSubscriber struct {
	taskID string // empty = subscribe to every task
	cb     func(MetaChangeEvent)
}

type metaEventBus struct {
	mu          sync.Mutex
	subscribers []*metaSubscriber
}

var bus = &metaEventBus{}

// SubscribeMeta attaches cb to the bus, filtered to events whose
// TaskID matches the given taskID. Returns a closer that detaches.
// Mirrors libs/meta.ts subscribeMeta.
func SubscribeMeta(taskID string, cb func(MetaChangeEvent)) (cancel func()) {
	return subscribe(taskID, cb)
}

// SubscribeMetaAll attaches cb to every task's lifecycle event. Used
// by cross-task aggregators (Telegram notifier, /api/sessions/all
// cache buster) where filtering at the subscriber level is the wrong
// shape. Mirrors libs/meta.ts subscribeMetaAll.
func SubscribeMetaAll(cb func(MetaChangeEvent)) (cancel func()) {
	return subscribe("", cb)
}

func subscribe(taskID string, cb func(MetaChangeEvent)) func() {
	sub := &metaSubscriber{taskID: taskID, cb: cb}
	bus.mu.Lock()
	bus.subscribers = append(bus.subscribers, sub)
	bus.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			bus.mu.Lock()
			defer bus.mu.Unlock()
			for i, s := range bus.subscribers {
				if s == sub {
					bus.subscribers = append(bus.subscribers[:i], bus.subscribers[i+1:]...)
					return
				}
			}
		})
	}
}

// emit drops the cache entry for dir (so readers see fresh state) and
// fans the event out to matching subscribers. Mirrors libs/meta.ts
// emit() exactly: invalidate first, notify second.
//
// Subscribers may call back into ReadMeta synchronously, so the cache
// drop MUST happen before the notify. A subscriber callback that
// panics is isolated — we recover so one bad consumer can't strand
// the rest.
func emit(dir string, ev MetaChangeEvent) {
	if dir != "" {
		metaCache.drop(dir)
	}
	bus.mu.Lock()
	subs := append([]*metaSubscriber(nil), bus.subscribers...)
	bus.mu.Unlock()
	for _, s := range subs {
		if s.taskID != "" && s.taskID != ev.TaskID {
			continue
		}
		safeCall(s.cb, ev)
	}
}

func safeCall(cb func(MetaChangeEvent), ev MetaChangeEvent) {
	defer func() { _ = recover() }()
	cb(ev)
}

// EmitRetried fires a retried event after the bridge auto-spawns a
// fix agent. AppendRun has already fired spawned for the new run; this
// is the follow-up the UI uses to draw the retry-of arrow without
// scanning every run. Mirrors libs/meta.ts emitRetried.
func EmitRetried(dir string, retryRun Run, retryOf string) {
	emit(dir, MetaChangeEvent{
		TaskID:    taskIDFromDir(dir),
		Kind:      MetaChangeRetried,
		SessionID: retryRun.SessionID,
		Run:       &retryRun,
		RetryOf:   retryOf,
	})
}

// EmitTaskSection fires a task-section event when a task moves between
// sections. Skip the call when prev == next — no-op writes (e.g.
// renaming the title) shouldn't ping the notifier.
func EmitTaskSection(dir string, prev, next TaskSection, title string, checked bool) {
	if prev == next {
		return
	}
	emit(dir, MetaChangeEvent{
		TaskID:      taskIDFromDir(dir),
		Kind:        MetaChangeTaskSection,
		PrevSection: prev,
		NextSection: next,
		TaskTitle:   title,
		TaskChecked: checked,
	})
}
