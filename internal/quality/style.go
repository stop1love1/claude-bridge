package quality

// Style fingerprint scanner — Go port of libs/styleFingerprint.ts.
//
// Walks an app's source tree and tallies micro-style indicators
// (indent, quotes, semicolons, trailing comma, named-vs-default
// exports, file-name casing). Output is rendered into the spawn
// prompt as "House style (auto-detected)" so child agents follow the
// project's existing conventions instead of imposing their own.
//
// Pure heuristic + per-line regex — no tokenizer, no AST. Robust to
// non-source files: every dimension falls back to "unknown" when the
// sample yields no signal. Walk caps mirror internal/symbol so a
// pathological monorepo can't pin the scanner.

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// StyleFingerprint is the per-app result. Field shapes mirror the TS
// `StyleFingerprint` interface but lean on Go-natural casing. App
// name and refresh timestamp are intentionally omitted — the caller
// (prompt builder) supplies those alongside the fingerprint when
// rendering, so storing them on the value would just duplicate.
type StyleFingerprint struct {
	Indent        Indent     `json:"indent"`
	Quotes        string     `json:"quotes"`        // "single" | "double" | "mixed" | "unknown"
	Semicolons    string     `json:"semicolons"`    // "always" | "never" | "mixed" | "unknown"
	TrailingComma string     `json:"trailingComma"` // "all"    | "none"  | "mixed" | "unknown"
	Exports       string     `json:"exports"`       // "named"  | "default" | "mixed" | "unknown"
	FileNaming    FileNaming `json:"fileNaming"`
	// SampledFiles is the count after skip filters and the sample cap.
	// 0 means "no source files found" — every other dimension will be
	// "unknown" in that case.
	SampledFiles int `json:"sampledFiles"`
}

// Indent splits the kind/width pair so the renderer can phrase
// "2-space indent" vs "tabs" naturally without re-parsing a string.
type Indent struct {
	Kind  string `json:"kind"`  // "spaces" | "tabs" | "unknown"
	Width int    `json:"width"` // 2 / 4 for spaces, 1 for tabs, 0 for unknown
}

// FileNaming carries per-extension casing because in mixed projects
// `Button.tsx` (Pascal) and `button-list.ts` (kebab) coexist legally
// — collapsing them into one value would advise the agent wrongly.
type FileNaming struct {
	Tsx string `json:"tsx"` // "PascalCase" | "kebab-case" | "camelCase" | "mixed" | "unknown"
	Ts  string `json:"ts"`
}

var styleSourceExts = map[string]struct{}{
	".ts": {}, ".tsx": {}, ".js": {}, ".jsx": {},
}

// styleSkipDirs intentionally lives apart from symbol.skipDirs so we
// can tune one without affecting the other. The TS list adds
// `__tests__`, `__mocks__`, and `public` because test fixtures and
// build assets carry style noise (snapshot files, vendored CSS-in-JS
// dumps) the agent should never copy.
var styleSkipDirs = map[string]struct{}{
	"node_modules": {}, ".git": {}, "dist": {}, "build": {},
	".next": {}, "out": {}, "coverage": {},
	".bridge-state": {}, ".uploads": {}, ".cache": {}, ".turbo": {},
	"__tests__": {}, "__mocks__": {}, "public": {},
}

var styleSkipFileSuffixes = []string{
	".test.ts", ".test.tsx", ".test.js", ".test.jsx",
	".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx",
	".d.ts",
}

const (
	// Walk caps mirror internal/symbol so the two scanners share a
	// consistent worst-case footprint when run back-to-back during
	// spawn prep. Higher than the TS port (50 / 32 KB / depth 5)
	// because the Go binary processes them an order of magnitude
	// faster — we can afford a wider sample for a stronger signal.
	styleFileWalkCap  = 1500
	styleReadCapBytes = 64 * 1024
	styleWalkDepthCap = 6
)

// exportDefaultRE / exportNamedRE split the TS regex pair into two
// anchored patterns so we can dispatch with a single match per line
// instead of grepping twice. Both expect the line to be already
// trimmed so leading whitespace doesn't break the `^` anchor.
var (
	exportDefaultRE = regexp.MustCompile(`^export\s+default\b`)
	exportNamedRE   = regexp.MustCompile(`^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\b`)
)

// File-name casing patterns. PascalCase requires at least one
// lowercase letter so all-caps acronyms ("XHR", "URL") fall into the
// `mixed` bucket alongside SCREAMING_SNAKE — they are valid names
// but not a casing the agent should mimic for new files.
var (
	pascalShapeRE = regexp.MustCompile(`^[A-Z][A-Za-z0-9]*$`)
	hasLowerRE    = regexp.MustCompile(`[a-z]`)
	kebabRE       = regexp.MustCompile(`^[a-z]+(-[a-z0-9]+)+$`)
	camelRE       = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*$`)
	testSuffixRE  = regexp.MustCompile(`(?i)\.(test|spec)$`)
)

// indentLeadingRE checks whether a line is indented at all. We use a
// regex (not strings.HasPrefix on each whitespace char) because the
// TS port did the same and we want behaviorally identical output.
var indentLeadingRE = regexp.MustCompile(`^\s`)

// lineCommentStripRE drops a `//`-style trailing line comment so the
// last meaningful character (used for semicolon / trailing-comma
// classification) is the code, not the comment text.
var lineCommentStripRE = regexp.MustCompile(`//.*$`)

// styleTally collects per-dimension counts during the walk. Field
// names mirror the TS interface so cross-referencing the two ports
// stays trivial; the cost of slightly verbose Go field names is worth
// it.
type styleTally struct {
	spaces2 int
	spaces4 int
	tabs    int

	singleQuotes int
	doubleQuotes int

	endsSemi int
	endsBare int

	trailingComma   int
	noTrailingComma int

	defaultExports int
	namedExports   int

	tsxPascal, tsxKebab, tsxCamel, tsxOther int
	tsPascal, tsKebab, tsCamel, tsOther     int
}

func styleFileShouldSkip(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	for _, suf := range styleSkipFileSuffixes {
		if strings.HasSuffix(name, suf) {
			return true
		}
	}
	return false
}

func styleDirShouldSkip(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	_, ok := styleSkipDirs[name]
	return ok
}

func styleIsSourceFile(name string) bool {
	dot := strings.LastIndex(name, ".")
	if dot <= 0 {
		return false
	}
	_, ok := styleSourceExts[strings.ToLower(name[dot:])]
	return ok
}

// sampleFiles walks one root and returns the source files under it,
// biased toward `.ts`/`.tsx` (the most representative for project
// style). The bias is enforced by collecting the two extension
// families separately and concatenating ts-first, then truncating to
// styleFileWalkCap.
func sampleFiles(root string) []string {
	var tsFiles []string
	var jsFiles []string

	var visit func(dir string, depth int)
	visit = func(dir string, depth int) {
		if depth > styleWalkDepthCap {
			return
		}
		// Doubling the cap during the walk keeps the bias logic correct
		// even when the tree is overwhelmingly .ts: we still get a full
		// styleFileWalkCap of ts files before any js fills remaining
		// slots. Without the doubling, an early-stop on `2*cap` could
		// chop ts off mid-stride.
		if len(tsFiles)+len(jsFiles) >= styleFileWalkCap*2 {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() {
				if styleDirShouldSkip(name) {
					continue
				}
				visit(filepath.Join(dir, name), depth+1)
			} else if e.Type().IsRegular() {
				if styleFileShouldSkip(name) || !styleIsSourceFile(name) {
					continue
				}
				full := filepath.Join(dir, name)
				if strings.HasSuffix(name, ".ts") || strings.HasSuffix(name, ".tsx") {
					tsFiles = append(tsFiles, full)
				} else {
					jsFiles = append(jsFiles, full)
				}
			}
		}
	}
	visit(root, 0)

	if len(tsFiles) >= styleFileWalkCap {
		return tsFiles[:styleFileWalkCap]
	}
	need := styleFileWalkCap - len(tsFiles)
	if need > len(jsFiles) {
		need = len(jsFiles)
	}
	return append(tsFiles, jsFiles[:need]...)
}

// safeReadCappedStyle reads at most styleReadCapBytes from path. We
// duplicate symbol.safeReadCapped instead of exporting it because the
// two packages should be free to tune their caps independently.
func safeReadCappedStyle(p string) (string, bool) {
	f, err := os.Open(p)
	if err != nil {
		return "", false
	}
	defer f.Close()
	buf := make([]byte, styleReadCapBytes)
	n, err := f.Read(buf)
	if err != nil && n == 0 {
		return "", false
	}
	return string(buf[:n]), true
}

// classifyFileName buckets a stem into a casing label. The trailing
// `.test`/`.spec` marker is stripped before classification so a
// kebab-cased component named `button-list.test.tsx` still classifies
// as kebab — without the strip, the dot would push it into `mixed`.
func classifyFileName(stem string) string {
	if stem == "" {
		return "unknown"
	}
	norm := testSuffixRE.ReplaceAllString(stem, "")
	if pascalShapeRE.MatchString(norm) && hasLowerRE.MatchString(norm) {
		return "PascalCase"
	}
	if kebabRE.MatchString(norm) {
		return "kebab-case"
	}
	if camelRE.MatchString(norm) {
		return "camelCase"
	}
	return "mixed"
}

// tallyFile is the single-pass per-line counter. Each indicator
// increments at most once per non-empty, non-comment line so a
// single huge file can't dominate the result.
func tallyFile(text, fileName string, t *styleTally) {
	lines := strings.Split(text, "\n")
	inBlockComment := false

	for _, raw := range lines {
		// Tolerate CRLF — TS's split(/\r?\n/) handles it natively;
		// here we strip the trailing \r so end-of-line classification
		// sees the actual code character.
		line := strings.TrimRight(raw, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}

		if inBlockComment {
			if strings.Contains(line, "*/") {
				inBlockComment = false
			}
			continue
		}
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "/*") {
			if !strings.Contains(trimmed, "*/") {
				inBlockComment = true
			}
			continue
		}
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		if strings.HasPrefix(trimmed, "*") {
			// JSDoc continuation line — also skip.
			continue
		}

		// Indent: only inspect lines that begin with whitespace.
		if indentLeadingRE.MatchString(line) {
			switch {
			case strings.HasPrefix(line, "\t"):
				t.tabs++
			case strings.HasPrefix(line, "    "):
				t.spaces4++
			case strings.HasPrefix(line, "  "):
				t.spaces2++
			}
		}

		// Quotes: count occurrences per line, attribute the line to
		// whichever wins. Inside-string occurrences add noise but the
		// law of large numbers across a 1500-file walk evens it out.
		sq := strings.Count(line, "'")
		dq := strings.Count(line, `"`)
		if sq > dq {
			t.singleQuotes++
		} else if dq > sq {
			t.doubleQuotes++
		}

		// Semicolons / trailing-comma: classify by the last non-comment
		// character on the line. We strip a trailing `// …` first so
		// `foo() // note` still classifies on the `)`.
		stripped := strings.TrimRight(lineCommentStripRE.ReplaceAllString(line, ""), " \t")
		if len(stripped) > 0 {
			last := stripped[len(stripped)-1]
			if last == ';' {
				t.endsSemi++
			} else if isWordOrCloseBracket(last) {
				// Skip lines that end an opening structure (`{`), an
				// object key (`:`), or a list item (`,`) — those aren't
				// statement terminators.
				if last != '{' && last != ',' && last != ':' {
					t.endsBare++
				}
			}

			// Trailing comma in multi-line lists: indented lines that
			// end with `,` vote "all", indented lines that end with a
			// closing bracket without a trailing comma vote "none".
			// Top-level statements rarely end in `,` so the indent
			// gate keeps the signal clean.
			if indentLeadingRE.MatchString(line) {
				switch last {
				case ',':
					t.trailingComma++
				case ')', ']', '}':
					t.noTrailingComma++
				}
			}
		}

		// Exports.
		if exportDefaultRE.MatchString(trimmed) {
			t.defaultExports++
		} else if exportNamedRE.MatchString(trimmed) {
			t.namedExports++
		}
	}

	// File-name casing per extension.
	dot := strings.LastIndex(fileName, ".")
	if dot <= 0 {
		return
	}
	ext := strings.ToLower(fileName[dot:])
	stem := fileName[:dot]
	casing := classifyFileName(stem)
	switch ext {
	case ".tsx":
		switch casing {
		case "PascalCase":
			t.tsxPascal++
		case "kebab-case":
			t.tsxKebab++
		case "camelCase":
			t.tsxCamel++
		default:
			t.tsxOther++
		}
	case ".ts":
		switch casing {
		case "PascalCase":
			t.tsPascal++
		case "kebab-case":
			t.tsKebab++
		case "camelCase":
			t.tsCamel++
		default:
			t.tsOther++
		}
	}
}

// isWordOrCloseBracket mirrors TS `/[\w)\]]/` for ASCII. We don't
// bother with full Unicode \w because TS source files are ASCII for
// keywords/punctuation; an emoji at end-of-line is statistical noise
// either way.
func isWordOrCloseBracket(b byte) bool {
	switch {
	case b >= 'a' && b <= 'z':
		return true
	case b >= 'A' && b <= 'Z':
		return true
	case b >= '0' && b <= '9':
		return true
	case b == '_':
		return true
	case b == ')':
		return true
	case b == ']':
		return true
	}
	return false
}

// majorityBucket is the input row to pickMajority. Generics would let
// us bind the label type, but Go's regexp + struct mix here doesn't
// benefit — every label is a string anyway.
type majorityBucket struct {
	Label string
	Count int
}

// pickMajority returns the dominant label from a tally. When every
// bucket is zero, returns fallbackUnknown — the caller treats this
// as "no signal, hide the section". When at least one bucket has
// counts but no label crosses the threshold, returns fallbackMixed.
//
// Threshold defaults vary by dimension (semicolons want 0.7,
// trailing-comma is fuzzier so 0.6) — passing the cfg explicitly
// keeps each call site honest about the strength of evidence
// required.
func pickMajority(buckets []majorityBucket, threshold float64, fallbackUnknown, fallbackMixed string) string {
	total := 0
	for _, b := range buckets {
		total += b.Count
	}
	if total == 0 {
		return fallbackUnknown
	}
	// Sort descending by count; stable so equal counts preserve input
	// order, which matches the TS Array.prototype.sort callback shape.
	sort.SliceStable(buckets, func(i, j int) bool {
		return buckets[i].Count > buckets[j].Count
	})
	top := buckets[0]
	if float64(top.Count)/float64(total) >= threshold {
		return top.Label
	}
	return fallbackMixed
}

// BuildFingerprint scans appRoot (or the listed sub-dirs when
// non-empty) and returns a StyleFingerprint. Always returns a
// well-formed value, even when the app has zero source files —
// every dimension falls through to "unknown" / 0 in that case.
//
// dirs nil or empty → walk the entire app root with the standard
// skip-dir set. A non-empty list scopes the walk to those
// sub-directories; entries that escape appRoot or don't exist are
// silently skipped (defense-in-depth against operator-edited
// bridge.json).
func BuildFingerprint(appRoot string, dirs []string) StyleFingerprint {
	var files []string
	if len(dirs) == 0 {
		files = sampleFiles(appRoot)
	} else {
		seen := make(map[string]struct{})
		for _, rel := range dirs {
			if rel == "" || filepath.IsAbs(rel) {
				continue
			}
			root := filepath.Join(appRoot, rel)
			within, err := filepath.Rel(appRoot, root)
			if err != nil || strings.HasPrefix(within, "..") || filepath.IsAbs(within) {
				continue
			}
			info, err := os.Stat(root)
			if err != nil || !info.IsDir() {
				continue
			}
			for _, f := range sampleFiles(root) {
				if _, dup := seen[f]; dup {
					continue
				}
				seen[f] = struct{}{}
				files = append(files, f)
				if len(files) >= styleFileWalkCap {
					break
				}
			}
			if len(files) >= styleFileWalkCap {
				break
			}
		}
	}

	t := &styleTally{}
	for _, abs := range files {
		text, ok := safeReadCappedStyle(abs)
		if !ok {
			continue
		}
		tallyFile(text, filepath.Base(abs), t)
	}

	// Indent: spaces2 / spaces4 / tabs share a 0.6 threshold (lower
	// than quotes/semis) because most projects mix the occasional
	// 4-space block (long signatures wrapping) into an otherwise
	// 2-space file — 0.7 would push too many indents into "mixed".
	indentWinner := pickMajority(
		[]majorityBucket{
			{"spaces2", t.spaces2},
			{"spaces4", t.spaces4},
			{"tabs", t.tabs},
		},
		0.6, "unknown", "mixed",
	)
	var indent Indent
	switch indentWinner {
	case "spaces2":
		indent = Indent{Kind: "spaces", Width: 2}
	case "spaces4":
		indent = Indent{Kind: "spaces", Width: 4}
	case "tabs":
		indent = Indent{Kind: "tabs", Width: 1}
	case "mixed":
		// Sane default when the tally is split: 2-space wins by
		// frequency in the wider TS ecosystem so a guess that way is
		// least likely to surprise the agent.
		indent = Indent{Kind: "spaces", Width: 2}
	default:
		indent = Indent{Kind: "unknown", Width: 0}
	}

	quotes := pickMajority(
		[]majorityBucket{
			{"single", t.singleQuotes},
			{"double", t.doubleQuotes},
		},
		0.7, "unknown", "mixed",
	)
	semicolons := pickMajority(
		[]majorityBucket{
			{"always", t.endsSemi},
			{"never", t.endsBare},
		},
		0.7, "unknown", "mixed",
	)
	trailingComma := pickMajority(
		[]majorityBucket{
			{"all", t.trailingComma},
			{"none", t.noTrailingComma},
		},
		0.6, "unknown", "mixed",
	)
	exports := pickMajority(
		[]majorityBucket{
			{"named", t.namedExports},
			{"default", t.defaultExports},
		},
		0.6, "unknown", "mixed",
	)
	tsx := pickMajority(
		[]majorityBucket{
			{"PascalCase", t.tsxPascal},
			{"kebab-case", t.tsxKebab},
			{"camelCase", t.tsxCamel},
		},
		0.6, "unknown", "mixed",
	)
	ts := pickMajority(
		[]majorityBucket{
			{"PascalCase", t.tsPascal},
			{"kebab-case", t.tsKebab},
			{"camelCase", t.tsCamel},
		},
		0.6, "unknown", "mixed",
	)

	return StyleFingerprint{
		Indent:        indent,
		Quotes:        quotes,
		Semicolons:    semicolons,
		TrailingComma: trailingComma,
		Exports:       exports,
		FileNaming:    FileNaming{Tsx: tsx, Ts: ts},
		SampledFiles:  len(files),
	}
}
