package memory

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/stop1love1/claude-bridge/internal/symbol"
)

// Reference-attach caps. Per-file size mirrors PinnedPerFileCapBytes
// because the prompt rendering treats both kinds of attachment the
// same way; the count cap is intentionally smaller than PinnedMaxFiles
// because reference picks are speculative — quality > quantity.
const (
	ReferencePerFileCapBytes = 4 * 1024
	ReferenceMaxFiles        = 3
	// ReferenceMinScore is the minimum keyword overlap a candidate
	// file needs to earn an attachment slot. Below 2 we'd be injecting
	// noise — a single accidental token match is not signal.
	ReferenceMinScore = 2
)

// stopwords skipped during task-body tokenization. Trimmed to the
// most common spawn-prompt offenders — same list as libs/contextAttach.ts.
// A map gives O(1) membership without pulling in a set type.
var stopwords = map[string]struct{}{
	"the": {}, "and": {}, "a": {}, "an": {}, "of": {}, "to": {},
	"for": {}, "in": {}, "on": {}, "at": {}, "is": {}, "are": {},
	"be": {}, "by": {}, "as": {}, "or": {}, "with": {}, "this": {},
	"that": {}, "add": {}, "fix": {}, "update": {}, "create": {},
	"make": {}, "build": {}, "use": {}, "new": {}, "old": {},
	"from": {}, "into": {}, "out": {}, "do": {}, "did": {}, "done": {},
	"task": {}, "todo": {}, "should": {}, "would": {}, "need": {},
	"needs": {}, "want": {}, "wants": {}, "please": {}, "review": {},
	"implement": {}, "function": {}, "feature": {},
}

// tokenSplitRE matches every run of non-alphanumeric characters — the
// inverse of the tokenizer's "keep-set". Compiled once because the
// hot path is the spawn flow and we don't want to re-parse the regex
// on every prompt build.
var tokenSplitRE = regexp.MustCompile(`[^a-z0-9]+`)

// numericTokenRE drops pure-numeric tokens (years, line numbers,
// version digits) so a task body referencing "2025" or "v3" doesn't
// match every file with those digits in its path.
var numericTokenRE = regexp.MustCompile(`^\d+$`)

// ReferenceFile is one auto-attached file picked by the keyword
// heuristic. Rel is always posix-style so the rendered prompt is
// platform-stable.
type ReferenceFile struct {
	Rel       string
	Content   string
	Truncated bool
	// Score is the summed keyword-overlap score that earned the file
	// its slot. Surfaced in the prompt's "## Reference files" intro
	// so the agent understands why a file was attached.
	Score int
}

// AttachOptions bundles the inputs to AttachReferences. ExcludePaths
// is typically the operator's pinned-file list — we skip those so the
// reference slot doesn't waste space duplicating already-pinned content.
type AttachOptions struct {
	AppPath      string
	ExcludePaths []string
}

// Tokenize lowercases, splits on non-alphanumeric runs, and filters
// out short / stopword / pure-numeric tokens. Returns deduplicated,
// stable-ordered tokens (insertion order on first sight) so two calls
// with the same input produce the same slice — the scoring side relies
// on that determinism only for test reproducibility.
//
// Exported so the recent-direction picker can reuse the exact same
// tokenization as the reference attacher (matches libs/contextAttach.ts
// exporting `tokenize` for `recentDirection.ts` to import).
func Tokenize(text string) []string {
	if text == "" {
		return nil
	}
	lower := strings.ToLower(text)
	pieces := tokenSplitRE.Split(lower, -1)
	seen := make(map[string]struct{}, len(pieces))
	out := make([]string, 0, len(pieces))
	for _, raw := range pieces {
		t := strings.TrimSpace(raw)
		if t == "" || len(t) < 3 {
			continue
		}
		if _, skip := stopwords[t]; skip {
			continue
		}
		if numericTokenRE.MatchString(t) {
			continue
		}
		if _, dup := seen[t]; dup {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return out
}

// ScoreSymbol counts substring matches of taskTokens inside the
// symbol's `file + " " + name` haystack. Substring match (not whole
// word) so `formInput` is matched by `form` and `useFormState` is
// matched by `form` — that's how the agent's loose "this is about
// forms" intent maps onto the index.
func ScoreSymbol(s symbol.SymbolEntry, taskTokens []string) int {
	if len(taskTokens) == 0 {
		return 0
	}
	haystack := strings.ToLower(s.File + " " + s.Name)
	score := 0
	for _, tok := range taskTokens {
		if strings.Contains(haystack, tok) {
			score++
		}
	}
	return score
}

// CandidateFile is one file in the scored-and-ranked result of
// PickCandidateFiles. Score is the sum of every symbol in this file
// scored against the task tokens.
type CandidateFile struct {
	File  string
	Score int
}

// PickCandidateFiles aggregates per-symbol scores into per-file scores,
// drops files below ReferenceMinScore, and returns the survivors
// sorted by score descending (file path ascending breaks ties so the
// output is deterministic).
//
// Exported so recent-direction can pick a "touched dir" using the same
// file-ranking logic — keeps the heuristic in one place.
func PickCandidateFiles(symbols []symbol.SymbolEntry, taskTokens []string) []CandidateFile {
	if len(taskTokens) == 0 {
		return nil
	}
	fileScores := make(map[string]int)
	for _, s := range symbols {
		inc := ScoreSymbol(s, taskTokens)
		if inc == 0 {
			continue
		}
		fileScores[s.File] += inc
	}
	out := make([]CandidateFile, 0, len(fileScores))
	for file, score := range fileScores {
		if score < ReferenceMinScore {
			continue
		}
		out = append(out, CandidateFile{File: file, Score: score})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].File < out[j].File
	})
	return out
}

// AttachReferences picks up to ReferenceMaxFiles files from index by
// keyword overlap with taskBody, reads each (capped + truncation flag),
// and returns them ranked by score. Returns nil when the index is
// empty, the task body produces no useful tokens, no candidate scored
// above the threshold, or every candidate failed to read.
//
// The signature matches the per-task spawn shape: one task body, one
// shared symbol index per app, attach-time options. Errors at the
// per-file level are swallowed (we just skip that file) — the prompt
// builder doesn't need to know that a candidate file vanished between
// indexing and reading; it just gets fewer references this turn.
func AttachReferences(taskBody string, index symbol.SymbolIndex, opts AttachOptions) []ReferenceFile {
	if len(index.Symbols) == 0 {
		return nil
	}
	tokens := Tokenize(taskBody)
	if len(tokens) == 0 {
		return nil
	}
	if opts.AppPath == "" || !filepath.IsAbs(opts.AppPath) {
		// Without an absolute app root we can't safely resolve any
		// candidate path — bail rather than guessing against cwd.
		return nil
	}

	exclude := make(map[string]struct{}, len(opts.ExcludePaths))
	for _, p := range opts.ExcludePaths {
		exclude[filepath.ToSlash(p)] = struct{}{}
	}

	candidates := PickCandidateFiles(index.Symbols, tokens)
	out := make([]ReferenceFile, 0, ReferenceMaxFiles)
	for _, c := range candidates {
		if len(out) >= ReferenceMaxFiles {
			break
		}
		norm := filepath.ToSlash(c.File)
		if _, skip := exclude[norm]; skip {
			continue
		}
		abs, ok := resolveSafely(opts.AppPath, c.File)
		if !ok {
			continue
		}
		content, truncated, ok := readReferenceCapped(abs)
		if !ok {
			continue
		}
		out = append(out, ReferenceFile{
			Rel:       norm,
			Content:   content,
			Truncated: truncated,
			Score:     c.Score,
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// readReferenceCapped is the reference-side twin of pinned.go's
// readCapped, kept separate so a future cap divergence between the two
// flows doesn't force one knob for both. Same N+1 buffer trick so a
// file exactly at the cap reports truncated=false.
func readReferenceCapped(absPath string) (string, bool, bool) {
	f, err := os.Open(absPath)
	if err != nil {
		return "", false, false
	}
	defer f.Close()
	buf := make([]byte, ReferencePerFileCapBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", false, false
	}
	truncated := n > ReferencePerFileCapBytes
	if truncated {
		n = ReferencePerFileCapBytes
	}
	return string(buf[:n]), truncated, true
}
