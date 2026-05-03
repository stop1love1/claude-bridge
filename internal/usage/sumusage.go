package usage

import (
	"bufio"
	"container/list"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
)

// SessionUsage is the per-session token total. Cache reads are tracked
// separately so the UI can show how much context was served from cache
// vs. fresh.
//
// JSON tags use lowerCamelCase to match the Next response shape exactly.
type SessionUsage struct {
	InputTokens         int64 `json:"inputTokens"`
	OutputTokens        int64 `json:"outputTokens"`
	CacheCreationTokens int64 `json:"cacheCreationTokens"`
	CacheReadTokens     int64 `json:"cacheReadTokens"`
	// Turns is the number of assistant entries that contributed a usage
	// block.
	Turns int64 `json:"turns"`
}

// Add returns the elementwise sum of two usage rows. Mirrors addUsage
// in the TS module.
func Add(a, b SessionUsage) SessionUsage {
	return SessionUsage{
		InputTokens:         a.InputTokens + b.InputTokens,
		OutputTokens:        a.OutputTokens + b.OutputTokens,
		CacheCreationTokens: a.CacheCreationTokens + b.CacheCreationTokens,
		CacheReadTokens:     a.CacheReadTokens + b.CacheReadTokens,
		Turns:               a.Turns + b.Turns,
	}
}

// usageCacheMax caps the (path, mtime, size)-keyed result cache. Most
// sessions stop changing the moment the run ends, so a second / Nth
// /api/sessions/all poll hits this cache for every steady-state file.
// 256 entries is plenty for a long-running dashboard with hundreds of
// sessions and bounded RAM (~tens of KB). Mirrors USAGE_CACHE_MAX in TS.
const usageCacheMax = 256

type usageCacheEntry struct {
	key  string
	val  SessionUsage
	node *list.Element
}

type usageCacheT struct {
	mu    sync.Mutex
	items map[string]*usageCacheEntry
	order *list.List
}

var usageCache = &usageCacheT{
	items: make(map[string]*usageCacheEntry, usageCacheMax),
	order: list.New(),
}

func (c *usageCacheT) get(key string) (SessionUsage, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[key]
	if !ok {
		return SessionUsage{}, false
	}
	c.order.MoveToBack(e.node)
	return e.val, true
}

func (c *usageCacheT) put(key string, val SessionUsage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.items[key]; ok {
		existing.val = val
		c.order.MoveToBack(existing.node)
		return
	}
	e := &usageCacheEntry{key: key, val: val}
	e.node = c.order.PushBack(e)
	c.items[key] = e
	if c.order.Len() > usageCacheMax {
		front := c.order.Front()
		if front != nil {
			oldest := front.Value.(*usageCacheEntry)
			c.order.Remove(front)
			delete(c.items, oldest.key)
		}
	}
}

func (c *usageCacheT) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items = make(map[string]*usageCacheEntry, usageCacheMax)
	c.order = list.New()
}

// ResetUsageCacheForTests drops everything in the usage cache. Exported
// so unit tests can verify miss-on-mtime-change without colliding with
// other tests' cached entries. Mirrors __resetUsageCacheForTests.
func ResetUsageCacheForTests() {
	usageCache.reset()
}

func usageCacheKey(path string, mtimeMs, size int64) string {
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

// SumUsageFromJsonl walks a session's .jsonl and sums the per-turn
// `message.usage` block. Cache reads are tracked separately so the UI
// can show how much context was served from cache vs. fresh.
//
// Returns zeros for missing / unreadable files so callers can sum
// across an array of session paths without dealing with sparse data.
//
// Cache only successful parses. Stat / read failures fall through to
// a zero result that is NOT cached — a transient ENOENT / EMFILE must
// not poison the entry until the next file mutation. Mirrors the TS
// behavior exactly.
func SumUsageFromJsonl(filePath string) SessionUsage {
	var zero SessionUsage
	st, err := os.Stat(filePath)
	if err != nil {
		// File missing or unreadable → uncached zero.
		return zero
	}
	mtimeMs := st.ModTime().UnixMilli()
	size := st.Size()
	key := usageCacheKey(filePath, mtimeMs, size)
	if hit, ok := usageCache.get(key); ok {
		return hit
	}

	out, err := sumUsageFromJsonlUncached(filePath)
	if err != nil {
		return zero
	}
	usageCache.put(key, out)
	return out
}

func sumUsageFromJsonlUncached(filePath string) (SessionUsage, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return SessionUsage{}, err
	}
	defer func() { _ = f.Close() }()

	// bufio.Scanner imposes a fixed line ceiling (default 64 KB, even
	// after Buffer()) — when a single line exceeds it, Scanner.Err returns
	// bufio.ErrTooLong and the surrounding cache-no-poison guard would
	// silently zero out the entire session. Claude transcripts routinely
	// embed multi-MB base64 image attachments, so any fixed cap is wrong.
	// Use a Reader with ReadBytes('\n') so individual lines have no length
	// limit, and treat per-line errors as recoverable: a single garbled or
	// over-long line should not void the whole file's worth of usage.
	r := bufio.NewReader(f)
	var out SessionUsage
	for {
		line, err := r.ReadBytes('\n')
		// ReadBytes may return data along with a non-nil err (typically
		// io.EOF on the trailing partial line). Process whatever bytes
		// came back before deciding whether to stop.
		if len(line) > 0 {
			// Strip the trailing newline (and stray \r on Windows-edited
			// files) for cleaner empty-line detection / json parsing.
			trimmed := line
			if trimmed[len(trimmed)-1] == '\n' {
				trimmed = trimmed[:len(trimmed)-1]
			}
			if len(trimmed) > 0 && trimmed[len(trimmed)-1] == '\r' {
				trimmed = trimmed[:len(trimmed)-1]
			}
			if len(trimmed) > 0 {
				var entry struct {
					Type    string `json:"type"`
					Message struct {
						Usage *struct {
							InputTokens              int64 `json:"input_tokens"`
							OutputTokens             int64 `json:"output_tokens"`
							CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
							CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
						} `json:"usage"`
					} `json:"message"`
				}
				if jerr := json.Unmarshal(trimmed, &entry); jerr == nil {
					if entry.Type == "assistant" && entry.Message.Usage != nil {
						u := entry.Message.Usage
						out.InputTokens += u.InputTokens
						out.OutputTokens += u.OutputTokens
						out.CacheCreationTokens += u.CacheCreationInputTokens
						out.CacheReadTokens += u.CacheReadInputTokens
						out.Turns++
					}
				}
				// Malformed JSON on a single line is intentionally
				// swallowed — claude occasionally writes partially-flushed
				// rows when a session crashes; one bad row shouldn't
				// invalidate the rest of the file.
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				// Clean end-of-file. Final partial line (no trailing \n)
				// was already processed above.
				return out, nil
			}
			// Best-effort: a transient mid-stream read error shouldn't
			// flip a parse-so-far into a zero. Stop here and return the
			// partial sum as success — the (path, mtime, size) cache key
			// will invalidate on the next file mutation anyway.
			return out, nil
		}
	}
}
