package memory

import (
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// Storage layout. Mirrors libs/memory.ts so the Next reader and the Go
// reader see the same on-disk file bytewise — operators can flip
// between bridges mid-task without re-seeding memory.
const (
	MemoryDirName  = ".bridge"
	MemoryFileName = "memory.md"

	// MaxFileBytes caps the on-disk file. A runaway memory.md (operator
	// pasting a transcript instead of a one-line learning) would blow
	// the prompt budget and still grow unbounded; trimming here keeps
	// both the file and every downstream read bounded.
	MaxFileBytes = 32 * 1024
	// MaxEntryBytes caps a single appended entry. 1 KB is enough for a
	// "When X → do Y because Z" rule but rejects pasted code blocks.
	MaxEntryBytes = 1024
	// PromptInjectLimit is the default number of newest entries
	// TopMemoryEntries surfaces. Matches the TS limit so the prompt
	// section size stays parity'd.
	PromptInjectLimit = 12
)

// MemoryFilePath is the absolute path to an app's memory file. Exposed
// so the UI / hooks can show "edit raw" affordances pointed at the
// same path the loader reads.
func MemoryFilePath(appPath string) string {
	return filepath.Join(appPath, MemoryDirName, MemoryFileName)
}

// LoadMemory returns the raw memory file for an app, or "" when absent
// / unreadable / appPath invalid. The TS sibling returns null for the
// "nothing to surface" case; Go uses the empty string with a bool to
// keep the API allocation-free in the hot path. Callers usually treat
// any of the three failure modes (missing file, non-absolute path,
// read error) as "no memory yet" — explicit error returns would force
// every caller to ignore the error anyway.
func LoadMemory(appPath string) (string, bool) {
	if appPath == "" || !filepath.IsAbs(appPath) {
		return "", false
	}
	file := MemoryFilePath(appPath)
	buf, err := os.ReadFile(file)
	if err != nil {
		return "", false
	}
	if len(buf) > MaxFileBytes {
		buf = buf[:MaxFileBytes]
	}
	text := strings.TrimSpace(string(buf))
	if text == "" {
		return "", false
	}
	return text, true
}

// TopMemoryEntries returns up to limit non-empty, non-header bullets
// from the head of the memory file. Used by the prompt builder when
// injecting `## Memory` — splits on newline because AppendMemory
// guarantees one bullet per line.
//
// Pass limit <= 0 for the default PromptInjectLimit.
func TopMemoryEntries(appPath string, limit int) []string {
	if limit <= 0 {
		limit = PromptInjectLimit
	}
	raw, ok := LoadMemory(appPath)
	if !ok {
		return nil
	}
	out := make([]string, 0, limit)
	for _, lineRaw := range strings.Split(raw, "\n") {
		// Tolerate CR-terminated lines from operators editing on
		// Windows; the TS regex `/\r?\n/` would split them, here we
		// trim because we already split on `\n`.
		line := strings.TrimSpace(strings.TrimRight(lineRaw, "\r"))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") { // operator-added headers
			continue
		}
		out = append(out, line)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// AppendMemory pushes entry to the head of the file. Returns the
// bullet as actually persisted plus ok=true; ok=false signals the
// input was unusable (empty entry, invalid path, write failure).
//
// The lock is keyed on appPath rather than the file path because two
// concurrent appends could both observe the same prior file, both
// prepend, and the second atomic rename would silently drop the
// first append. WithTaskLock gives us serialization across the whole
// read-modify-write window.
//
// Idempotent: if the most recent entry is byte-equal to the proposed
// bullet (after the same flatten/trim steps), AppendMemory returns
// the existing bullet without rewriting. Avoids double-appends when
// a hook retries on transient failure.
func AppendMemory(appPath, entry string) (string, bool) {
	if appPath == "" || !filepath.IsAbs(appPath) {
		return "", false
	}
	trimmed := strings.TrimSpace(entry)
	if trimmed == "" {
		return "", false
	}

	// Flatten newlines + a leading bullet marker so each appended
	// entry is exactly one line. Strip a leading "- " or "* " so we
	// don't end up with "-- foo" when the operator already pre-bulleted.
	flattened := stripLeadingBullet(trimmed)
	flattened = collapseWhitespace(flattened)
	if len(flattened) > MaxEntryBytes {
		flattened = truncateUTF8(flattened, MaxEntryBytes)
	}
	bullet := "- " + flattened

	var result string
	var resultOK bool
	_ = meta.WithTaskLock(appPath, func() error {
		existing, hadExisting := LoadMemory(appPath)
		if hadExisting {
			// Compare against the first non-empty line — the file
			// stores newest-first so the head is always the most
			// recent entry.
			for _, ln := range strings.Split(existing, "\n") {
				ln = strings.TrimSpace(strings.TrimRight(ln, "\r"))
				if ln == "" {
					continue
				}
				if ln == bullet {
					result = bullet
					resultOK = true
					return nil
				}
				break
			}
		}

		var next string
		if hadExisting {
			next = bullet + "\n" + existing
		} else {
			next = bullet
		}

		capped := capFileBytes(next, MaxFileBytes)

		if err := meta.WriteStringAtomic(MemoryFilePath(appPath), capped+"\n", nil); err != nil {
			return nil // surfaced via resultOK == false
		}
		result = bullet
		resultOK = true
		return nil
	})
	return result, resultOK
}

// RenderMemorySection returns the prompt block for `## Memory`.
// Returns "" when entries is empty so callers can skip the heading
// entirely — matches the TS sibling's contract and lets buildChildPrompt
// concatenate without nil-guards on every section.
func RenderMemorySection(entries []string) string {
	if len(entries) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("## Memory (learnings from prior tasks in this app)\n")
	b.WriteString("\n")
	b.WriteString("Durable rules accreted from past tasks. Format `When X → do Y because Z`. Honor these unless the current task explicitly overrides — the team chose to remember each one for a reason.\n")
	b.WriteString("\n")
	for _, e := range entries {
		if strings.HasPrefix(e, "-") {
			b.WriteString(e)
		} else {
			b.WriteString("- ")
			b.WriteString(e)
		}
		b.WriteString("\n")
	}
	b.WriteString("\n")
	return b.String()
}

// stripLeadingBullet drops a single "- " or "* " prefix. We don't
// loop because the TS source only strips one marker — repeated
// bullet markers in the input are user intent and shouldn't be
// silently collapsed.
func stripLeadingBullet(s string) string {
	if len(s) >= 2 && (s[0] == '-' || s[0] == '*') && (s[1] == ' ' || s[1] == '\t') {
		return strings.TrimLeft(s[2:], " \t")
	}
	return s
}

// collapseWhitespace replaces every run of unicode whitespace with a
// single ASCII space. Mirrors the TS `replace(/\s+/g, " ")` — NOT
// just splitting on `\n` because operators sometimes paste tab-
// indented blocks and we want them flattened too.
func collapseWhitespace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inSpace := false
	for _, r := range s {
		if isSpace(r) {
			if !inSpace {
				b.WriteByte(' ')
				inSpace = true
			}
			continue
		}
		b.WriteRune(r)
		inSpace = false
	}
	return strings.TrimSpace(b.String())
}

func isSpace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	}
	// Mirror JS \s coverage of NBSP + line/paragraph separators
	// without pulling in unicode tables for every codepoint.
	return r == 0x00A0 || r == 0x2028 || r == 0x2029
}

// truncateUTF8 returns at most maxBytes bytes of s without splitting a
// UTF-8 codepoint. The TS path used Buffer.subarray then re-decoded;
// we trim to a rune boundary directly so a Vietnamese / emoji entry
// at the cap doesn't end in a replacement char.
func truncateUTF8(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// capFileBytes truncates the full file payload to maxBytes on a UTF-8
// boundary AND drops any partial trailing line so TopMemoryEntries
// never serves a half-bullet. Mirrors the TS `lastIndexOf("\n")`
// heuristic exactly.
func capFileBytes(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	trimmed := truncateUTF8(s, maxBytes)
	if i := strings.LastIndexByte(trimmed, '\n'); i >= 0 {
		return trimmed[:i]
	}
	return trimmed
}
