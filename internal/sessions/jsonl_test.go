package sessions_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/sessions"
)

// writeJSONLFile writes content to a temp file and returns its absolute
// path. Used by every test below so a failure during setup fails the
// test on the right line via t.Helper().
func writeJSONLFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

func TestTailJsonl(t *testing.T) {
	t.Run("returns full content at offset=0 and new offset at EOF", func(t *testing.T) {
		dir := t.TempDir()
		file := writeJSONLFile(t, dir, "s.jsonl", "{\"a\":1}\n{\"b\":2}\n")
		out, err := sessions.TailJsonl(file, 0)
		if err != nil {
			t.Fatalf("TailJsonl: %v", err)
		}
		want := []any{
			map[string]any{"a": float64(1)},
			map[string]any{"b": float64(2)},
		}
		if !reflect.DeepEqual(out.Lines, want) {
			t.Errorf("Lines = %#v, want %#v", out.Lines, want)
		}
		if out.Offset != 16 {
			t.Errorf("Offset = %d, want 16", out.Offset)
		}
		if !reflect.DeepEqual(out.LineOffsets, []int64{0, 8}) {
			t.Errorf("LineOffsets = %#v, want [0 8]", out.LineOffsets)
		}
	})

	t.Run("returns only new lines since offset", func(t *testing.T) {
		dir := t.TempDir()
		file := writeJSONLFile(t, dir, "s.jsonl", "{\"a\":1}\n")
		first, err := sessions.TailJsonl(file, 0)
		if err != nil {
			t.Fatalf("first TailJsonl: %v", err)
		}
		writeJSONLFile(t, dir, "s.jsonl", "{\"a\":1}\n{\"b\":2}\n")
		second, err := sessions.TailJsonl(file, first.Offset)
		if err != nil {
			t.Fatalf("second TailJsonl: %v", err)
		}
		want := []any{map[string]any{"b": float64(2)}}
		if !reflect.DeepEqual(second.Lines, want) {
			t.Errorf("Lines = %#v, want %#v", second.Lines, want)
		}
		if !reflect.DeepEqual(second.LineOffsets, []int64{8}) {
			t.Errorf("LineOffsets = %#v, want [8]", second.LineOffsets)
		}
	})

	t.Run("skips incomplete trailing lines", func(t *testing.T) {
		dir := t.TempDir()
		file := writeJSONLFile(t, dir, "s.jsonl", "{\"a\":1}\n{\"b\":2")
		out, err := sessions.TailJsonl(file, 0)
		if err != nil {
			t.Fatalf("TailJsonl: %v", err)
		}
		want := []any{map[string]any{"a": float64(1)}}
		if !reflect.DeepEqual(out.Lines, want) {
			t.Errorf("Lines = %#v, want %#v", out.Lines, want)
		}
		if out.Offset != 8 {
			t.Errorf("Offset = %d, want 8", out.Offset)
		}
		if !reflect.DeepEqual(out.LineOffsets, []int64{0}) {
			t.Errorf("LineOffsets = %#v, want [0]", out.LineOffsets)
		}
	})

	t.Run("offsets stay correct when lines contain multi-byte UTF-8", func(t *testing.T) {
		dir := t.TempDir()
		// "Quản lý" mixes 1/2/3-byte UTF-8 sequences; the assertion below
		// uses len([]byte(line1)) so the test stays correct regardless of
		// the exact byte count.
		line1 := "{\"v\":\"Quản lý\"}\n"
		line2 := "{\"v\":\"OK\"}\n"
		file := writeJSONLFile(t, dir, "s.jsonl", line1+line2)
		out, err := sessions.TailJsonl(file, 0)
		if err != nil {
			t.Fatalf("TailJsonl: %v", err)
		}
		want := []any{
			map[string]any{"v": "Quản lý"},
			map[string]any{"v": "OK"},
		}
		if !reflect.DeepEqual(out.Lines, want) {
			t.Errorf("Lines = %#v, want %#v", out.Lines, want)
		}
		line1Bytes := int64(len([]byte(line1)))
		if !reflect.DeepEqual(out.LineOffsets, []int64{0, line1Bytes}) {
			t.Errorf("LineOffsets = %#v, want [0 %d]", out.LineOffsets, line1Bytes)
		}
		totalBytes := int64(len([]byte(line1 + line2)))
		if out.Offset != totalBytes {
			t.Errorf("Offset = %d, want %d", out.Offset, totalBytes)
		}
	})
}

func TestTailJsonlChunkedReadParity(t *testing.T) {
	// tailChunkBytes is unexported in the implementation; mirror its value
	// here. If the impl ever changes the chunk size without updating this
	// constant, the boundary-straddle subtest will start failing — which
	// is the point.
	const chunk = 256 * 1024

	// multiChunkPayload builds a payload bigger than the chunk size with
	// uniquely-identifiable lines so a one-byte boundary slip would
	// corrupt at least one parse.
	multiChunkPayload := func() (content string, lineCount int, sizeBytes int64) {
		lines := make([]string, 0, 700)
		for i := 0; i < 700; i++ {
			padding := strings.Repeat("x", 800+(i%256))
			b, err := json.Marshal(map[string]any{"idx": i, "payload": padding})
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			lines = append(lines, string(b))
		}
		c := strings.Join(lines, "\n") + "\n"
		return c, len(lines), int64(len([]byte(c)))
	}

	t.Run("returns the same lines as a direct file read for a multi-chunk file", func(t *testing.T) {
		dir := t.TempDir()
		content, lineCount, sizeBytes := multiChunkPayload()
		file := writeJSONLFile(t, dir, "big.jsonl", content)
		if sizeBytes <= chunk {
			t.Fatalf("payload %d bytes; expected > %d", sizeBytes, chunk)
		}

		out, err := sessions.TailJsonl(file, 0)
		if err != nil {
			t.Fatalf("TailJsonl: %v", err)
		}
		if len(out.Lines) != lineCount {
			t.Fatalf("Lines len = %d, want %d", len(out.Lines), lineCount)
		}
		if out.Offset != sizeBytes {
			t.Errorf("Offset = %d, want %d", out.Offset, sizeBytes)
		}
		if len(out.LineOffsets) != lineCount {
			t.Errorf("LineOffsets len = %d, want %d", len(out.LineOffsets), lineCount)
		}
		first, ok := out.Lines[0].(map[string]any)
		if !ok {
			t.Fatalf("Lines[0] type = %T, want map[string]any", out.Lines[0])
		}
		if first["idx"].(float64) != 0 {
			t.Errorf("Lines[0].idx = %v, want 0", first["idx"])
		}
		last, ok := out.Lines[lineCount-1].(map[string]any)
		if !ok {
			t.Fatalf("Lines[last] type = %T, want map[string]any", out.Lines[lineCount-1])
		}
		if last["idx"].(float64) != float64(lineCount-1) {
			t.Errorf("Lines[last].idx = %v, want %d", last["idx"], lineCount-1)
		}

		direct, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read raw: %v", err)
		}
		// Spot-check the first 20 line offsets actually point to the start
		// of the corresponding JSON record in the raw file.
		limit := 20
		if lineCount < limit {
			limit = lineCount
		}
		for i := 0; i < limit; i++ {
			start := out.LineOffsets[i]
			end := bytes.IndexByte(direct[start:], '\n')
			if end <= 0 {
				t.Fatalf("no newline after offset %d", start)
			}
			var got any
			if err := json.Unmarshal(direct[start:start+int64(end)], &got); err != nil {
				t.Fatalf("parse subarray at %d: %v", start, err)
			}
			if !reflect.DeepEqual(got, out.Lines[i]) {
				t.Errorf("line %d: subarray parse != Lines[%d]", i, i)
			}
		}
	})

	t.Run("handles a small file under one chunk", func(t *testing.T) {
		dir := t.TempDir()
		file := writeJSONLFile(t, dir, "tiny.jsonl", "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n")
		out, err := sessions.TailJsonl(file, 0)
		if err != nil {
			t.Fatalf("TailJsonl: %v", err)
		}
		want := []any{
			map[string]any{"a": float64(1)},
			map[string]any{"b": float64(2)},
			map[string]any{"c": float64(3)},
		}
		if !reflect.DeepEqual(out.Lines, want) {
			t.Errorf("Lines = %#v, want %#v", out.Lines, want)
		}
		if out.Offset != 24 {
			t.Errorf("Offset = %d, want 24", out.Offset)
		}
		if !reflect.DeepEqual(out.LineOffsets, []int64{0, 8, 16}) {
			t.Errorf("LineOffsets = %#v, want [0 8 16]", out.LineOffsets)
		}
	})

	t.Run("trailing partial line is excluded; cursor lands at last newline", func(t *testing.T) {
		dir := t.TempDir()
		file := writeJSONLFile(t, dir, "partial.jsonl", "{\"a\":1}\n{\"b\":2}\n{\"c\":noterm")
		out, err := sessions.TailJsonl(file, 0)
		if err != nil {
			t.Fatalf("TailJsonl: %v", err)
		}
		want := []any{
			map[string]any{"a": float64(1)},
			map[string]any{"b": float64(2)},
		}
		if !reflect.DeepEqual(out.Lines, want) {
			t.Errorf("Lines = %#v, want %#v", out.Lines, want)
		}
		// Cursor must be just past the last \n so the next call resumes
		// at the start of the partial line and re-reads it once it
		// completes — NOT at EOF.
		if out.Offset != 16 {
			t.Errorf("Offset = %d, want 16", out.Offset)
		}
	})

	t.Run("survives a multi-byte UTF-8 char straddling a chunk boundary", func(t *testing.T) {
		dir := t.TempDir()
		// Build line1 so its newline lands BEFORE the chunk boundary, and
		// line2 so a 3-byte UTF-8 char (ả = 0xE1 0xBA 0xA3) STRADDLES it.
		padding1 := strings.Repeat("x", chunk-100)
		line1 := "{\"v\":\"" + padding1 + "\"}\n"
		line1Bytes := len([]byte(line1))
		offsetInLine2 := chunk - line1Bytes
		padLen := offsetInLine2 - 6 // {"v":" prefix = 6 bytes
		if padLen < 0 {
			padLen = 0
		}
		padding2 := strings.Repeat("y", padLen)
		line2 := "{\"v\":\"" + padding2 + "ảẢý\"}\n"
		content := line1 + line2
		file := writeJSONLFile(t, dir, "boundary.jsonl", content)
		if int64(len([]byte(content))) <= chunk {
			t.Fatalf("payload %d bytes; expected > %d", len([]byte(content)), chunk)
		}

		out, err := sessions.TailJsonl(file, 0)
		if err != nil {
			t.Fatalf("TailJsonl: %v", err)
		}
		if len(out.Lines) != 2 {
			t.Fatalf("Lines len = %d, want 2", len(out.Lines))
		}
		second, ok := out.Lines[1].(map[string]any)
		if !ok {
			t.Fatalf("Lines[1] type = %T, want map[string]any", out.Lines[1])
		}
		v, ok := second["v"].(string)
		if !ok {
			t.Fatalf("Lines[1].v type = %T, want string", second["v"])
		}
		if !strings.HasSuffix(v, "ảẢý") {
			t.Errorf("Lines[1].v does not end with the expected multi-byte chars")
		}
		totalBytes := int64(len([]byte(content)))
		if out.Offset != totalBytes {
			t.Errorf("Offset = %d, want %d", out.Offset, totalBytes)
		}
	})

	t.Run("matches direct read when called with a non-zero starting offset", func(t *testing.T) {
		dir := t.TempDir()
		file := writeJSONLFile(t, dir, "resume.jsonl", "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n{\"d\":4}\n")
		first, err := sessions.TailJsonl(file, 0)
		if err != nil {
			t.Fatalf("first TailJsonl: %v", err)
		}
		if len(first.Lines) != 4 {
			t.Fatalf("first Lines len = %d, want 4", len(first.Lines))
		}
		second, err := sessions.TailJsonl(file, 16)
		if err != nil {
			t.Fatalf("second TailJsonl: %v", err)
		}
		want := []any{
			map[string]any{"c": float64(3)},
			map[string]any{"d": float64(4)},
		}
		if !reflect.DeepEqual(second.Lines, want) {
			t.Errorf("Lines = %#v, want %#v", second.Lines, want)
		}
		if second.Offset != 32 {
			t.Errorf("Offset = %d, want 32", second.Offset)
		}
		if !reflect.DeepEqual(second.LineOffsets, []int64{16, 24}) {
			t.Errorf("LineOffsets = %#v, want [16 24]", second.LineOffsets)
		}
	})
}

func TestTailJsonlBefore(t *testing.T) {
	t.Run("returns lines ending at beforeOffset, starting on a line boundary", func(t *testing.T) {
		dir := t.TempDir()
		file := writeJSONLFile(t, dir, "s.jsonl", "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n")
		out, err := sessions.TailJsonlBefore(file, 24, 1024)
		if err != nil {
			t.Fatalf("TailJsonlBefore: %v", err)
		}
		want := []any{
			map[string]any{"a": float64(1)},
			map[string]any{"b": float64(2)},
			map[string]any{"c": float64(3)},
		}
		if !reflect.DeepEqual(out.Lines, want) {
			t.Errorf("Lines = %#v, want %#v", out.Lines, want)
		}
		if out.FromOffset != 0 {
			t.Errorf("FromOffset = %d, want 0", out.FromOffset)
		}
		if !reflect.DeepEqual(out.LineOffsets, []int64{0, 8, 16}) {
			t.Errorf("LineOffsets = %#v, want [0 8 16]", out.LineOffsets)
		}
	})

	t.Run("starts on a line boundary when window mid-record", func(t *testing.T) {
		dir := t.TempDir()
		file := writeJSONLFile(t, dir, "s.jsonl", "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n")
		// Window of 12 bytes ending at byte 24 starts mid `{"b":2}\n`;
		// the helper must skip the partial leading line.
		out, err := sessions.TailJsonlBefore(file, 24, 12)
		if err != nil {
			t.Fatalf("TailJsonlBefore: %v", err)
		}
		want := []any{map[string]any{"c": float64(3)}}
		if !reflect.DeepEqual(out.Lines, want) {
			t.Errorf("Lines = %#v, want %#v", out.Lines, want)
		}
		if out.FromOffset != 16 {
			t.Errorf("FromOffset = %d, want 16", out.FromOffset)
		}
		if !reflect.DeepEqual(out.LineOffsets, []int64{16}) {
			t.Errorf("LineOffsets = %#v, want [16]", out.LineOffsets)
		}
	})

	t.Run("returns empty + fromOffset=0 when beforeOffset is 0", func(t *testing.T) {
		dir := t.TempDir()
		file := writeJSONLFile(t, dir, "s.jsonl", "{\"a\":1}\n")
		// maxBytes=0 triggers the 64 KB default, mirroring the TS test's
		// reliance on the default arg.
		out, err := sessions.TailJsonlBefore(file, 0, 0)
		if err != nil {
			t.Fatalf("TailJsonlBefore: %v", err)
		}
		if !reflect.DeepEqual(out.Lines, []any{}) {
			t.Errorf("Lines = %#v, want []", out.Lines)
		}
		if out.FromOffset != 0 {
			t.Errorf("FromOffset = %d, want 0", out.FromOffset)
		}
	})
}
