package meta

import (
	"container/list"
	"sync"
	"time"
)

// metaCacheTTL bounds how long a ReadMeta result stays live in-process.
// 500 ms matches libs/meta.ts so callers see writes from another
// goroutine within one polling tick. Hot callers in the same event
// loop tick (coordinator post-exit flow, listTasks, the SSE meta
// route) hit the same dir multiple times — without this each call is
// a separate ReadFile + json.Unmarshal.
//
// Invalidation is explicit through emit() (every CreateMeta /
// WriteMeta / AppendRun / UpdateRun / RemoveSessionFromTask drops the
// cache entry for the affected dir BEFORE notifying subscribers, so
// readers always observe the freshly-written state).
const metaCacheTTL = 500 * time.Millisecond

// metaCacheMaxEntries bounds RAM at a few MB on a long-running bridge
// with hundreds of active tasks. Mirrors the TS limit (1024).
const metaCacheMaxEntries = 1024

type cacheValue struct {
	value   *Meta
	expires time.Time
	node    *list.Element
}

type metaCacheT struct {
	mu    sync.Mutex
	items map[string]*cacheValue
	order *list.List // front = least-recently-used
}

var metaCache = newMetaCache()

func newMetaCache() *metaCacheT {
	return &metaCacheT{
		items: make(map[string]*cacheValue, metaCacheMaxEntries),
		order: list.New(),
	}
}

func (c *metaCacheT) get(dir string) (*Meta, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.items[dir]
	if !ok {
		return nil, false
	}
	if time.Now().After(v.expires) {
		// TTL expired — evict from both the lookup map AND the LRU
		// list. The earlier "leave it for the next put to overwrite"
		// shortcut was buggy: an expired entry that's never re-put
		// (e.g. the dir got deleted) keeps occupying an LRU slot at
		// whatever insertion-order position it had, so eviction can
		// drop a hot live entry instead. Removing on read keeps
		// `order` cleanly bounded by live entries.
		c.order.Remove(v.node)
		delete(c.items, dir)
		return nil, false
	}
	c.order.MoveToBack(v.node)
	// nil is a valid cached value (file not present) — return
	// (nil, true) so the caller distinguishes a cached-miss from no
	// cache entry at all.
	return v.value, true
}

func (c *metaCacheT) put(dir string, m *Meta) {
	c.mu.Lock()
	defer c.mu.Unlock()
	exp := time.Now().Add(metaCacheTTL)
	if existing, ok := c.items[dir]; ok {
		existing.value = m
		existing.expires = exp
		c.order.MoveToBack(existing.node)
		return
	}
	v := &cacheValue{value: m, expires: exp}
	v.node = c.order.PushBack(dir)
	c.items[dir] = v
	if c.order.Len() > metaCacheMaxEntries {
		front := c.order.Front()
		if front != nil {
			oldest := front.Value.(string)
			c.order.Remove(front)
			delete(c.items, oldest)
		}
	}
}

func (c *metaCacheT) drop(dir string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v, ok := c.items[dir]; ok {
		c.order.Remove(v.node)
		delete(c.items, dir)
	}
}

// ResetCacheForTests drops every cached entry. Tests that mutate
// meta.json out-of-band (i.e. not through this package's helpers) call
// this so subsequent ReadMeta hits the disk.
func ResetCacheForTests() {
	metaCache.mu.Lock()
	defer metaCache.mu.Unlock()
	metaCache.items = make(map[string]*cacheValue, metaCacheMaxEntries)
	metaCache.order = list.New()
}

// InvalidateCacheFor drops a single cached meta for the given task
// dir without disturbing siblings. Hot path: DeleteTask removes the
// task dir and must invalidate the cache so a follow-up GET sees the
// absence rather than serving the pre-delete snapshot. Using
// ResetCacheForTests for that would stomp every other live entry
// across the bridge.
//
// The argument is the absolute task dir (the same key ReadMeta /
// WriteMeta use), not a bare task id.
func InvalidateCacheFor(dir string) {
	metaCache.drop(dir)
}
