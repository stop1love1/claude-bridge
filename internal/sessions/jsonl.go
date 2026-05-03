package sessions

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
)

// TailResult is the output of TailJsonl: a window of newly-completed
// JSONL records since `fromOffset`, plus the cursor that should be
// passed to the next call.
type TailResult struct {
	// Lines holds one decoded JSON value per .jsonl line. Lines whose
	// JSON failed to parse become a {"__raw":"...","__parseError":true}
	// sentinel — the SSE consumer surfaces it rather than dropping the
	// connection. Mirrors the TS shape exactly.
	Lines []any `json:"lines"`
	// Offset is the byte offset where the NEXT call should resume — i.e.
	// just past the last newline we've fully closed off.
	Offset int64 `json:"offset"`
	// LineOffsets is parallel to Lines: the byte offset where each
	// parsed line BEGINS in the file. Frontends use this to track the
	// earliest-loaded cursor when trimming or backward-paging.
	LineOffsets []int64 `json:"lineOffsets"`
}

// TailBeforeResult is the output of TailJsonlBefore: a window of
// complete lines that ends at `beforeOffset` (exclusive).
type TailBeforeResult struct {
	Lines []any `json:"lines"`
	// FromOffset is the byte offset of the first complete line returned.
	// Becomes the caller's new earliest-loaded cursor. If 0, the start
	// of the file has been reached.
	FromOffset int64 `json:"fromOffset"`
	// BeforeOffset echoes the input ceiling so the client can detect
	// stale responses.
	BeforeOffset int64   `json:"beforeOffset"`
	LineOffsets  []int64 `json:"lineOffsets"`
}

// tailChunkBytes is picked at 256 KB as a balance: large enough that
// typical session-log appends (a few KB per tail tick) finish in one
// syscall, small enough that a multi-MB tail after a long offline gap
// doesn't hold the entire window in RAM. Mirrors TAIL_CHUNK_BYTES.
const tailChunkBytes = 256 * 1024

// TailJsonl streams the tail of a .jsonl file beyond `fromOffset`,
// returning every fully-newline-terminated JSON record encountered
// (the trailing partial line is dropped — the cursor must always
// land on a line boundary so the next call doesn't double-emit it).
//
// The file may be deleted between this call and the next (task delete
// races a live SSE tail). A missing file degrades to "no new lines"
// rather than throwing into the SSE handler and dropping the
// connection. Same race-tolerance as the TS implementation.
func TailJsonl(filePath string, fromOffset int64) (TailResult, error) {
	st, err := os.Stat(filePath)
	if err != nil {
		if isNotExist(err) {
			return TailResult{Lines: []any{}, Offset: fromOffset, LineOffsets: []int64{}}, nil
		}
		return TailResult{}, err
	}
	size := st.Size()
	if fromOffset >= size {
		return TailResult{Lines: []any{}, Offset: size, LineOffsets: []int64{}}, nil
	}
	f, err := os.Open(filePath)
	if err != nil {
		if isNotExist(err) {
			return TailResult{Lines: []any{}, Offset: fromOffset, LineOffsets: []int64{}}, nil
		}
		return TailResult{}, err
	}
	defer func() { _ = f.Close() }()

	// Stream the tail in fixed-size chunks rather than allocating a
	// single buffer of size (size - fromOffset). A long-offline
	// reconnect can push that allocation into the tens-of-MB range,
	// which is wasteful when the caller almost always wants to
	// incrementally forward the offset cursor.
	//
	// We assemble whole lines on raw bytes (not decoded strings): \n
	// (0x0A) is a single byte in UTF-8 and never appears inside a
	// multi-byte sequence, so byte-level newline splitting is safe even
	// when a chunk boundary falls inside a multi-byte char. The full
	// line is decoded only after the newline closes it, by which point
	// every multi-byte sequence in the line is complete.
	buf := make([]byte, tailChunkBytes)
	lines := make([]any, 0, 16)
	lineOffsets := make([]int64, 0, 16)
	// Bytes pending for the in-progress line. Replaced on each newline.
	var pending []byte
	// Absolute file offset where pending begins.
	pendingStart := fromOffset
	// Total bytes read so far (relative to fromOffset). Used to advance
	// the cursor and to compute the absolute byte position of the next
	// newline we encounter.
	var consumed int64
	// Highest absolute offset we've fully closed off with a newline.
	// Becomes the result Offset cursor.
	lastNewlineAbsEnd := fromOffset

	for {
		n, err := f.ReadAt(buf, fromOffset+consumed)
		// ReadAt returns io.EOF when n < len(buf) at end of file. That's
		// expected — process the partial chunk first, then break.
		if n > 0 {
			chunk := buf[:n]
			lineStartInChunk := 0
			for i, b := range chunk {
				if b != '\n' {
					continue
				}
				absLineEnd := fromOffset + consumed + int64(i) + 1
				tail := chunk[lineStartInChunk:i]
				var lineBytes []byte
				if len(pending) == 0 {
					lineBytes = tail
				} else {
					lineBytes = make([]byte, 0, len(pending)+len(tail))
					lineBytes = append(lineBytes, pending...)
					lineBytes = append(lineBytes, tail...)
				}
				if len(lineBytes) > 0 {
					lines = append(lines, parseJSONLine(lineBytes))
					lineOffsets = append(lineOffsets, pendingStart)
				}
				lastNewlineAbsEnd = absLineEnd
				pending = pending[:0]
				pendingStart = absLineEnd
				lineStartInChunk = i + 1
			}
			// Carry over the unfinished tail of this chunk.
			if lineStartInChunk < len(chunk) {
				pending = append(pending, chunk[lineStartInChunk:]...)
			}
			consumed += int64(n)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				return TailResult{}, err
			}
			break
		}
		if n == 0 || n < tailChunkBytes {
			break
		}
	}
	return TailResult{
		Lines:       lines,
		Offset:      lastNewlineAbsEnd,
		LineOffsets: lineOffsets,
	}, nil
}

// TailJsonlBefore reads a window of complete lines that ENDS at
// `beforeOffset` (exclusive). The window is at most `maxBytes` long,
// but always starts on a line boundary — we scan forward past any
// partial leading line. Used to paginate backward through a session
// .jsonl when the user scrolls up.
//
// `maxBytes` defaults to 64 KB when ≤ 0, matching the TS default.
func TailJsonlBefore(filePath string, beforeOffset, maxBytes int64) (TailBeforeResult, error) {
	if maxBytes <= 0 {
		maxBytes = 64 * 1024
	}
	st, err := os.Stat(filePath)
	if err != nil {
		if isNotExist(err) {
			return TailBeforeResult{Lines: []any{}, FromOffset: 0, BeforeOffset: beforeOffset, LineOffsets: []int64{}}, nil
		}
		return TailBeforeResult{}, err
	}
	size := st.Size()
	ceiling := beforeOffset
	if ceiling > size {
		ceiling = size
	}
	if ceiling <= 0 {
		return TailBeforeResult{Lines: []any{}, FromOffset: 0, BeforeOffset: ceiling, LineOffsets: []int64{}}, nil
	}
	proposedStart := ceiling - maxBytes
	if proposedStart < 0 {
		proposedStart = 0
	}
	f, err := os.Open(filePath)
	if err != nil {
		if isNotExist(err) {
			return TailBeforeResult{Lines: []any{}, FromOffset: ceiling, BeforeOffset: ceiling, LineOffsets: []int64{}}, nil
		}
		return TailBeforeResult{}, err
	}
	defer func() { _ = f.Close() }()

	length := ceiling - proposedStart
	buf := make([]byte, length)
	n, err := f.ReadAt(buf, proposedStart)
	if err != nil && !errors.Is(err, io.EOF) {
		return TailBeforeResult{}, err
	}
	if n == 0 {
		return TailBeforeResult{Lines: []any{}, FromOffset: ceiling, BeforeOffset: ceiling, LineOffsets: []int64{}}, nil
	}
	data := buf[:n]

	// If we did not start at byte 0, the first line in `data` is almost
	// certainly the tail of a record that began before our window —
	// skip past it. Operate on raw bytes so the offset stays correct
	// when a multi-byte UTF-8 char straddles proposedStart.
	dataStart := 0
	if proposedStart > 0 {
		firstNl := indexByte(data, '\n')
		if firstNl < 0 {
			return TailBeforeResult{Lines: []any{}, FromOffset: ceiling, BeforeOffset: ceiling, LineOffsets: []int64{}}, nil
		}
		dataStart = firstNl + 1
	}

	// Drop a trailing partial line. With a clean beforeOffset from the
	// caller this is usually a no-op, but handle it defensively.
	lastNl := lastIndexByte(data, '\n')
	endByte := dataStart
	if lastNl >= 0 {
		endByte = lastNl
	}
	if endByte <= dataStart {
		return TailBeforeResult{Lines: []any{}, FromOffset: ceiling, BeforeOffset: ceiling, LineOffsets: []int64{}}, nil
	}

	lines := make([]any, 0, 16)
	lineOffsets := make([]int64, 0, 16)
	lineStart := dataStart
	for i := dataStart; i <= endByte; i++ {
		if data[i] != '\n' {
			continue
		}
		lineBytes := data[lineStart:i]
		if len(lineBytes) > 0 {
			lines = append(lines, parseJSONLine(lineBytes))
			lineOffsets = append(lineOffsets, proposedStart+int64(lineStart))
		}
		lineStart = i + 1
	}
	fromOff := ceiling
	if len(lineOffsets) > 0 {
		fromOff = lineOffsets[0]
	}
	return TailBeforeResult{
		Lines:        lines,
		FromOffset:   fromOff,
		BeforeOffset: ceiling,
		LineOffsets:  lineOffsets,
	}, nil
}

// parseJSONLine decodes a line into json.Unmarshal's idiomatic dynamic
// type (map[string]any / []any / string / float64 / bool / nil). On
// parse failure, returns the {__raw, __parseError} sentinel so the
// caller can surface the malformed line rather than silently swallow
// it. The TS version does the same trick with a JS object; we use a
// map so json.Marshal round-trips it identically.
func parseJSONLine(b []byte) any {
	var v any
	if err := json.Unmarshal(b, &v); err == nil {
		return v
	}
	return map[string]any{
		"__raw":        string(b),
		"__parseError": true,
	}
}

func isNotExist(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

// indexByte / lastIndexByte are tiny helpers; the bytes package would
// pull in the bytes import per file, and the inline search is cheaper
// than the function-call overhead for hot paths.
func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}

func lastIndexByte(b []byte, c byte) int {
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] == c {
			return i
		}
	}
	return -1
}
