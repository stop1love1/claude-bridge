// Package symbol scans an app's "shared helper" directories and
// extracts top-level exports as a flat SymbolEntry list. The result
// feeds the spawn prompt as a list of "available helpers" so child
// agents reuse what already exists instead of re-inventing it (the
// most common cause of style drift in LLM-generated code).
//
// This is the Go port of libs/symbolIndex.ts. Heuristic regex match —
// no TypeScript AST, no tree-sitter — because the four export shapes
// we care about (`export const|function|class|interface|type`) cover
// every helper the agent realistically reuses; the long tail
// (re-exports, decorators, `export default`) adds noise without
// helping the agent find code.
package symbol

import (
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// SymbolKind tags how the agent should think about an entry. The
// `component` bucket is split off from `const`/`function` when the
// name is PascalCase AND the file is .tsx/.jsx — this lets the prompt
// renderer group React components separately from utility helpers.
type SymbolKind string

const (
	KindFunction  SymbolKind = "function"
	KindConst     SymbolKind = "const"
	KindClass     SymbolKind = "class"
	KindInterface SymbolKind = "interface"
	KindType      SymbolKind = "type"
	KindComponent SymbolKind = "component"
)

// SymbolEntry is one extracted top-level export. Signature is the
// trailing slice of the export's first line after the name (trimmed,
// whitespace-collapsed, capped) — it gives the agent arity / param
// shape without making it open the file.
type SymbolEntry struct {
	Name string     `json:"name"`
	Kind SymbolKind `json:"kind"`
	// File is relative to the app root with posix separators so the
	// rendered prompt looks identical on Windows and Linux operators.
	File      string `json:"file"`
	Signature string `json:"signature"`
}

// SymbolIndex is the per-app result of one scan. RefreshedAt is
// RFC3339Nano so it round-trips with the TS `new Date().toISOString()`
// shape that the existing symbolStore.ts cache files use.
type SymbolIndex struct {
	AppName     string        `json:"appName"`
	RefreshedAt string        `json:"refreshedAt"`
	ScannedDirs []string      `json:"scannedDirs"`
	FileCount   int           `json:"fileCount"`
	Symbols     []SymbolEntry `json:"symbols"`
}

// Defaults the TS port and Go port both honor. Kept private — bridge
// callers either pass an explicit dir list or pass nil/[] to opt into
// these.
var defaultDirs = []string{"lib", "utils", "hooks", "components/ui"}

var sourceExts = map[string]struct{}{
	".ts": {}, ".tsx": {}, ".js": {}, ".jsx": {}, ".mjs": {}, ".cjs": {},
}

var skipDirs = map[string]struct{}{
	"node_modules": {}, ".git": {}, "dist": {}, "build": {},
	".next": {}, "out": {}, "coverage": {},
	".bridge-state": {}, ".uploads": {}, ".cache": {}, ".turbo": {},
	"__tests__": {}, "__mocks__": {},
}

var skipFileSuffixes = []string{
	".test.ts", ".test.tsx", ".test.js", ".test.jsx",
	".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx",
	".d.ts",
}

const (
	fileWalkCap   = 1500
	symbolCap     = 400
	readCapBytes  = 64 * 1024
	signatureCap  = 120
	walkDepthCap  = 6
	signatureCont = "…"
)

// exportRE captures `export <kind> <name>` headers. Group 1 = kind,
// group 2 = identifier. `async`/`abstract` modifiers are tolerated but
// don't change the bucket. `default` exports fall through and are
// dropped in extractExports — the captured name would be the keyword
// `default`, not the export's identity.
//
// Go's regexp is RE2 (no lookaround), but the TS regex doesn't need
// any — direct port works.
var exportRE = regexp.MustCompile(
	`(?m)^export\s+(?:async\s+|abstract\s+)?(function|const|let|var|class|interface|type)\s+([A-Za-z_$][\w$]*)`,
)

// componentNameRE matches PascalCase identifiers — the React
// convention the renderer uses to split components from helpers.
var componentNameRE = regexp.MustCompile(`^[A-Z][A-Za-z0-9]*$`)

// whitespaceRunRE collapses any run of whitespace to a single space
// inside the signature snippet so multi-line type declarations don't
// blow past the cap on stray indentation alone.
var whitespaceRunRE = regexp.MustCompile(`\s+`)

func looksLikeComponent(name, file string) bool {
	if !componentNameRE.MatchString(name) {
		return false
	}
	return strings.HasSuffix(file, ".tsx") || strings.HasSuffix(file, ".jsx")
}

func fileShouldSkip(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	for _, suf := range skipFileSuffixes {
		if strings.HasSuffix(name, suf) {
			return true
		}
	}
	return false
}

func dirShouldSkip(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	_, ok := skipDirs[name]
	return ok
}

func isSourceFile(name string) bool {
	dot := strings.LastIndex(name, ".")
	if dot <= 0 {
		return false
	}
	_, ok := sourceExts[strings.ToLower(name[dot:])]
	return ok
}

// walkSourceFiles is a depth-bounded, count-bounded directory walker.
// Returns the absolute paths of every source file under root that
// passes the skip filters. Stops early once fileWalkCap is hit so a
// stray symlink loop or a pathological monorepo can't pin the
// scanner.
func walkSourceFiles(root string) (files []string, capped bool) {
	var visit func(dir string, depth int)
	visit = func(dir string, depth int) {
		if capped || depth > walkDepthCap {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if capped {
				return
			}
			name := e.Name()
			if e.IsDir() {
				if dirShouldSkip(name) {
					continue
				}
				visit(filepath.Join(dir, name), depth+1)
			} else if e.Type().IsRegular() {
				if fileShouldSkip(name) || !isSourceFile(name) {
					continue
				}
				files = append(files, filepath.Join(dir, name))
				if len(files) >= fileWalkCap {
					capped = true
					return
				}
			}
		}
	}
	visit(root, 0)
	return files, capped
}

// extractExports pulls every top-level `export <kind> <name>` out of
// text. fileRel is needed only to decide whether a const/function
// counts as a React component (needs a .tsx/.jsx extension).
func extractExports(text, fileRel string) []SymbolEntry {
	var out []SymbolEntry
	matches := exportRE.FindAllStringSubmatchIndex(text, -1)
	for _, m := range matches {
		// m: [start, end, kindStart, kindEnd, nameStart, nameEnd]
		rawKind := text[m[2]:m[3]]
		name := text[m[4]:m[5]]
		if name == "" || name == "default" {
			continue
		}

		var kind SymbolKind
		switch rawKind {
		case "function":
			kind = KindFunction
		case "class":
			kind = KindClass
		case "interface":
			kind = KindInterface
		case "type":
			kind = KindType
		default: // const, let, var
			kind = KindConst
		}
		if (kind == KindConst || kind == KindFunction) && looksLikeComponent(name, fileRel) {
			kind = KindComponent
		}

		// Capture the rest of the line after the matched header so
		// the signature reflects the body's first line (e.g. the
		// arrow function's params + arrow).
		headerEnd := m[1]
		lineEnd := strings.IndexByte(text[headerEnd:], '\n')
		var tail string
		if lineEnd == -1 {
			tail = text[headerEnd:]
		} else {
			tail = text[headerEnd : headerEnd+lineEnd]
		}
		tail = strings.TrimSpace(whitespaceRunRE.ReplaceAllString(tail, " "))
		signature := tail
		if len(signature) > signatureCap {
			signature = signature[:signatureCap] + signatureCont
		}

		out = append(out, SymbolEntry{
			Name:      name,
			Kind:      kind,
			File:      fileRel,
			Signature: signature,
		})
	}
	return out
}

// safeReadCapped reads at most readCapBytes from path and returns the
// bytes as a string. Returns ("", false) on any error — the caller
// just skips this file. We intentionally don't surface the error
// because a single unreadable file shouldn't fail the whole index.
func safeReadCapped(p string) (string, bool) {
	f, err := os.Open(p)
	if err != nil {
		return "", false
	}
	defer f.Close()
	buf := make([]byte, readCapBytes)
	n, err := f.Read(buf)
	if err != nil && n == 0 {
		return "", false
	}
	return string(buf[:n]), true
}

// Build scans appRoot and returns its SymbolIndex. Always returns;
// falls back to an empty Symbols list when nothing matches. Never
// panics on bad input — missing dirs, unreadable files, and walks
// past the cap all fail silently.
//
// dirs nil or empty → use defaultDirs. Pass an explicit list to
// honor a per-app `symbolDirs` override from bridge.json.
func Build(appName, appRoot string, dirs []string) SymbolIndex {
	if appName == "" {
		appName = filepath.Base(appRoot)
	}
	target := dirs
	if len(target) == 0 {
		target = defaultDirs
	}

	idx := SymbolIndex{
		AppName:     appName,
		RefreshedAt: time.Now().UTC().Format(time.RFC3339Nano),
		ScannedDirs: []string{},
		Symbols:     []SymbolEntry{},
	}

	for _, rel := range target {
		// Defense-in-depth: bridge.json is operator-trusted, but a
		// stray `../../etc` entry in `symbolDirs` would otherwise let
		// the scanner walk outside the app. Reject absolute paths and
		// any relative path that resolves outside appRoot.
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

		idx.ScannedDirs = append(idx.ScannedDirs, rel)
		files, _ := walkSourceFiles(root)
		idx.FileCount += len(files)

		stop := false
		for _, abs := range files {
			text, ok := safeReadCapped(abs)
			if !ok {
				continue
			}
			relPath, err := filepath.Rel(appRoot, abs)
			if err != nil {
				continue
			}
			fileRel := filepath.ToSlash(relPath)
			// Belt-and-braces: filepath.ToSlash handles \\ → / on
			// Windows, but path.Clean normalizes any redundant ./
			// segments so the rendered prompt is stable.
			fileRel = path.Clean(fileRel)

			for _, s := range extractExports(text, fileRel) {
				if len(idx.Symbols) >= symbolCap {
					stop = true
					break
				}
				idx.Symbols = append(idx.Symbols, s)
			}
			if stop {
				break
			}
		}
		if len(idx.Symbols) >= symbolCap {
			break
		}
	}

	return idx
}
