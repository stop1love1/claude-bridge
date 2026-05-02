package sessions

import (
	"bytes"
	"container/list"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
)

// scanHead is the cached output of scanSessionHead: whether the file
// contains at least one real conversation turn (user/assistant/summary)
// and the first user-line preview if present.
type scanHead struct {
	HasRealEntry bool
	Preview      string
}

// scanHeadCache keeps results keyed by `<path>:<mtime>:<size>` so a
// file rewrite (which always changes either mtime or size) misses the
// cache, while a steady-state file (most older sessions never change
// after the run ends) is read at most once. Capped at 256 entries
// with insertion-order eviction — a *list.List preserves insertion
// order, so the front element is the next eviction candidate. Mirrors
// the TS Map-based implementation.
//
// Cache only successful parses. We never cache stat / read failures
// so a transient ENOENT / EMFILE doesn't poison the entry until the
// next file mutation.
const scanHeadCacheMax = 256

type cacheEntry struct {
	key  string
	val  scanHead
	node *list.Element // back-pointer for O(1) bump
}

type scanHeadCacheT struct {
	mu    sync.Mutex
	items map[string]*cacheEntry
	order *list.List // front = oldest
}

var scanHeadCache = &scanHeadCacheT{
	items: make(map[string]*cacheEntry, scanHeadCacheMax),
	order: list.New(),
}

func (c *scanHeadCacheT) get(key string) (scanHead, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[key]
	if !ok {
		return scanHead{}, false
	}
	// Insertion-order LRU bump: move to back so a hot key isn't the
	// next eviction candidate.
	c.order.MoveToBack(e.node)
	return e.val, true
}

func (c *scanHeadCacheT) put(key string, val scanHead) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.items[key]; ok {
		existing.val = val
		c.order.MoveToBack(existing.node)
		return
	}
	e := &cacheEntry{key: key, val: val}
	e.node = c.order.PushBack(e)
	c.items[key] = e
	if c.order.Len() > scanHeadCacheMax {
		front := c.order.Front()
		if front != nil {
			oldest := front.Value.(*cacheEntry)
			c.order.Remove(front)
			delete(c.items, oldest.key)
		}
	}
}

func (c *scanHeadCacheT) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items = make(map[string]*cacheEntry, scanHeadCacheMax)
	c.order = list.New()
}

// ResetScanHeadCacheForTests drops everything in the scanSessionHead
// cache. Exported so unit tests can verify miss-on-mtime-change
// without colliding with other tests' cached entries. Mirrors
// __resetScanHeadCacheForTests in the TS module.
func ResetScanHeadCacheForTests() {
	scanHeadCache.reset()
}

func scanHeadCacheKey(path string, mtimeMs, size int64) string {
	var b strings.Builder
	b.Grow(len(path) + 32)
	b.WriteString(path)
	b.WriteByte(':')
	writeInt(&b, mtimeMs)
	b.WriteByte(':')
	writeInt(&b, size)
	return b.String()
}

func writeInt(b *strings.Builder, n int64) {
	// Avoid pulling in strconv just for this — small fixed-width ints,
	// hot path on every list call.
	if n == 0 {
		b.WriteByte('0')
		return
	}
	if n < 0 {
		b.WriteByte('-')
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	b.Write(buf[i:])
}

// scanSessionHead is the cached entrypoint. Stats the file upfront so
// the cache key reflects the on-disk file we're about to read. A
// failure on stat is non-cacheable; we fall through to the uncached
// read which itself returns {false,""} for a missing file.
//
// mtime is sampled in integer ms (matches Windows' native granularity
// and survives a utime round-trip on POSIX without sub-ms drift),
// matching the TS `st.mtime.getTime()` choice.
func scanSessionHead(filePath string) scanHead {
	st, err := os.Stat(filePath)
	if err != nil {
		return scanSessionHeadUncached(filePath)
	}
	mtimeMs := st.ModTime().UnixMilli()
	size := st.Size()
	key := scanHeadCacheKey(filePath, mtimeMs, size)
	if hit, ok := scanHeadCache.get(key); ok {
		return hit
	}
	val := scanSessionHeadUncached(filePath)
	scanHeadCache.put(key, val)
	return val
}

const (
	scanChunkBytes = 16 * 1024
	scanMaxBytes   = 4 * 1024 * 1024
	previewMaxLen  = 120
)

// scanSessionHeadUncached streams a .jsonl session file in 16 KB
// chunks, returning whether it contains at least one real conversation
// turn (user/assistant/summary) and the first user-line preview if
// present. Bounded at scanMaxBytes so a runaway file can't pin the
// bridge — at that point we conservatively treat whatever we've seen
// so far as the answer (almost always: a real session whose user line
// lives even further in, included).
//
// Streaming (vs. a fixed-size head slice) is required because modern
// claude transcripts begin with a `queue-operation` + a multi-KB
// `attachment` payload — the first user/assistant/summary entry
// routinely lives well past byte 8192. A small head window silently
// hides every such session as a "stub".
func scanSessionHeadUncached(filePath string) scanHead {
	f, err := os.Open(filePath)
	if err != nil {
		return scanHead{}
	}
	defer func() { _ = f.Close() }()

	buf := make([]byte, scanChunkBytes)
	var leftover []byte
	var hasRealEntry bool
	var preview string
	var consumed int

	for consumed < scanMaxBytes {
		n, err := f.Read(buf)
		if n > 0 {
			consumed += n
			data := buf[:n]
			combined := append(leftover, data...)
			lastNl := bytes.LastIndexByte(combined, '\n')
			if lastNl < 0 {
				leftover = combined
			} else {
				ready := combined[:lastNl]
				leftover = append(leftover[:0], combined[lastNl+1:]...)
				for _, line := range bytes.Split(ready, []byte{'\n'}) {
					hasRealEntry, preview = consumeHeadLine(line, hasRealEntry, preview)
					if hasRealEntry && preview != "" {
						return scanHead{HasRealEntry: true, Preview: preview}
					}
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			break
		}
	}
	// Drain trailing partial line (common at EOF without trailing newline).
	if len(leftover) > 0 {
		hasRealEntry, preview = consumeHeadLine(leftover, hasRealEntry, preview)
	}
	return scanHead{HasRealEntry: hasRealEntry, Preview: preview}
}

// consumeHeadLine decodes a single line and updates the running
// (hasRealEntry, preview) accumulators. Mirrors the inner `consume`
// closure from libs/sessions.ts. Returns the new state — caller is
// responsible for stopping the scan when both fields are populated.
func consumeHeadLine(line []byte, hasRealEntry bool, preview string) (bool, string) {
	if len(bytes.TrimSpace(line)) == 0 {
		return hasRealEntry, preview
	}
	var obj struct {
		Type    string `json:"type"`
		Message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &obj); err != nil {
		// Partial / malformed line — keep scanning.
		return hasRealEntry, preview
	}
	if obj.Type != "user" && obj.Type != "assistant" && obj.Type != "summary" {
		return hasRealEntry, preview
	}
	hasRealEntry = true
	if preview == "" && obj.Type == "user" {
		// Decode the content payload lazily (it can be a string OR an
		// array of blocks). json.Unmarshal into `any` gives us the
		// dynamic shape extractText expects.
		var content any
		_ = json.Unmarshal(obj.Message.Content, &content)
		text := extractText(content)
		preview = trimPreview(text)
	}
	return hasRealEntry, preview
}

// trimPreview collapses runs of whitespace to a single space and caps
// the length to previewMaxLen runes. Mirrors the TS chain
// `.trim().replace(/\s+/g, " ").slice(0, 120)`.
//
// We slice by RUNE (not byte) — slicing by byte mid-codepoint would
// emit invalid UTF-8 for any non-ASCII preview (the regression case
// is "Quản lý" / Vietnamese previews).
func trimPreview(s string) string {
	s = strings.TrimSpace(s)
	// Collapse internal whitespace runs to a single space.
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if isSpaceRune(r) {
			if !prevSpace {
				b.WriteByte(' ')
			}
			prevSpace = true
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	collapsed := b.String()
	// Slice by rune count.
	if previewMaxLen >= len(collapsed) {
		// Fast path — len(string) is byte length, so this is a safe
		// over-estimate of rune count. If bytes ≤ 120 then runes ≤ 120.
		return collapsed
	}
	// Walk runes to find the byte position of the 121st rune.
	count := 0
	for i := range collapsed {
		if count == previewMaxLen {
			return collapsed[:i]
		}
		count++
	}
	return collapsed
}

func isSpaceRune(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\v', '\f', '\r':
		return true
	}
	return false
}
