package apps

// Heuristic repo profile detector — Go port of libs/repoProfile.ts.
// Pure stdlib, never throws / never returns an error: a half-checked-out
// sibling, a malformed package.json, a missing README — all degrade to
// "empty fields" rather than failing the caller. The bridge calls this
// at app-add time and on operator-driven refresh; failure here would
// strand the whole app registry.
//
// The TS port additionally derived a keyword harvest, file-extension
// counts, prisma model names, and a `signals` block. The S16 follow-up
// scope intentionally omits those — the Go callers (coordinator prompt,
// repo scoring) consume only Stack / Features / Entrypoints / Summary.
// If the wider keyword surface is needed later, port the harvest path
// off of the existing TS module rather than guessing what's used.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// readCapBytes mirrors the TS READ_CAP_BYTES — the README/CLAUDE.md
// summary extractor only ever looks at the first 4 KB so a 50 MB README
// can't blow up memory.
const readCapBytes = 4096

// featureRule maps a feature label to substring needles. Matching is
// independent per rule, one hit -> feature added once. Order is only
// load-bearing for the de-dupe pass downstream.
type featureRule struct {
	feature string
	match   []string
}

var featureRules = []featureRule{
	{"auth", []string{"auth", "login", "jwt", "oauth", "session"}},
	{"payments", []string{"payment", "billing", "stripe", "invoice", "subscription"}},
	{"i18n", []string{"i18n", "locale", "translation", "intl"}},
	{"notifications", []string{"notification", "email", "sms", "mail", "push"}},
	{"messaging", []string{"chat", "message", "conversation", "thread"}},
	{"lms", []string{"lms", "course", "lesson", "student", "teacher", "classroom", "quiz", "exam"}},
	{"orchestration", []string{"coordinator", "bridge", "orchestrat", "agent"}},
}

// RepoProfile is the persisted heuristic snapshot for one repo. The
// shape is the slim subset of libs/repoProfile.ts the Go consumers
// actually read; bridge.json round-trip code does not touch this file.
type RepoProfile struct {
	Name        string   `json:"name"`
	Path        string   `json:"path"`
	Summary     string   `json:"summary"`
	Stack       []string `json:"stack"`
	Features    []string `json:"features"`
	Entrypoints []string `json:"entrypoints"`
	// RefreshedAt is RFC3339Nano so it round-trips with the TS
	// `new Date().toISOString()` shape on operators that already have
	// a repo-profiles.json from the legacy bun build.
	RefreshedAt string `json:"refreshedAt"`
}

// routerStyle is the Next.js routing convention detected in the repo.
// Internal — callers shouldn't care, but it changes which entrypoint
// globs we emit for a Next project.
type routerStyle int

const (
	routerUnknown routerStyle = iota
	routerApp                 // app/ or src/app/
	routerPages               // pages/ or src/pages/
	routerSrc                 // bare src/, no app or pages
)

// primaryLang is the dominant source language. Used to pick fallback
// entrypoint globs and to add a language tag to Stack.
type primaryLang int

const (
	langUnknown primaryLang = iota
	langTS
	langJS
	langPy
	langGo
	langJava
)

// parsedPackageJson is the trimmed package.json shape — only the keys
// the heuristic actually reads.
type parsedPackageJson struct {
	deps        map[string]string
	name        string
	description string
}

// DetectRepoProfile is the pure heuristic entry point. Always returns a
// populated RepoProfile — fields are zero/empty when nothing was
// detected. Never blocks on the network, never opens an LLM, never
// returns an error: callers chain it from cache-refresh paths where a
// per-repo failure must not poison the rest of the batch.
func DetectRepoProfile(name, path string) RepoProfile {
	pkg := parsePackageJson(path)
	lang := detectPrimaryLang(path, pkg)
	router := detectRouterStyle(path)
	stack := deriveStack(pkg, path, lang)
	entrypoints := deriveEntrypoints(stack, router, lang, path)

	// Summary first — features mines its text for orchestration/auth/etc
	// keywords, matching the TS port's behavior of feeding the summary
	// into the feature haystack.
	summary := extractSummary(path, pkg, name, stack)
	features := deriveFeatures(stack, pkg, path, summary)

	return RepoProfile{
		Name:        name,
		Path:        path,
		Summary:     summary,
		Stack:       stack,
		Features:    features,
		Entrypoints: entrypoints,
		RefreshedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
}

// safeReadText reads up to capBytes from path. Returns "" on any error
// (missing file, perms, …). The TS port distinguished nil vs "" — Go
// callers only ever check `if text != ""`, so collapse to one shape.
func safeReadText(path string, capBytes int) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, capBytes)
	n, _ := f.Read(buf)
	return string(buf[:n])
}

// parsePackageJson reads + parses package.json, merging dependencies +
// devDependencies + peerDependencies into a single map (the heuristic
// doesn't care which bucket a dep came from).
func parsePackageJson(repoPath string) *parsedPackageJson {
	body, err := os.ReadFile(filepath.Join(repoPath, "package.json"))
	if err != nil {
		return nil
	}
	var raw struct {
		Name             string            `json:"name"`
		Description      string            `json:"description"`
		Dependencies     map[string]string `json:"dependencies"`
		DevDependencies  map[string]string `json:"devDependencies"`
		PeerDependencies map[string]string `json:"peerDependencies"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	deps := make(map[string]string, len(raw.Dependencies)+len(raw.DevDependencies)+len(raw.PeerDependencies))
	for k, v := range raw.Dependencies {
		deps[k] = v
	}
	for k, v := range raw.DevDependencies {
		deps[k] = v
	}
	for k, v := range raw.PeerDependencies {
		deps[k] = v
	}
	return &parsedPackageJson{deps: deps, name: raw.Name, description: raw.Description}
}

// existsAny is true when any of `names` exists at the root of repoPath.
func existsAny(repoPath string, names []string) bool {
	for _, n := range names {
		if _, err := os.Stat(filepath.Join(repoPath, n)); err == nil {
			return true
		}
	}
	return false
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func detectRouterStyle(repoPath string) routerStyle {
	if dirExists(filepath.Join(repoPath, "app")) || dirExists(filepath.Join(repoPath, "src", "app")) {
		return routerApp
	}
	if dirExists(filepath.Join(repoPath, "pages")) || dirExists(filepath.Join(repoPath, "src", "pages")) {
		return routerPages
	}
	if dirExists(filepath.Join(repoPath, "src")) {
		return routerSrc
	}
	return routerUnknown
}

// detectPrimaryLang prefers explicit signature files (pyproject.toml,
// go.mod, pom.xml) over the package.json fallback so a polyglot repo
// with package.json + go.mod still tags as Go (the more specific
// signal — Node-based tooling lives next to almost every primary lang).
func detectPrimaryLang(repoPath string, pkg *parsedPackageJson) primaryLang {
	if existsAny(repoPath, []string{"pyproject.toml", "requirements.txt"}) {
		return langPy
	}
	if existsAny(repoPath, []string{"go.mod"}) {
		return langGo
	}
	if existsAny(repoPath, []string{"pom.xml", "build.gradle"}) {
		return langJava
	}
	if pkg != nil {
		if _, ok := pkg.deps["typescript"]; ok {
			return langTS
		}
		if existsAny(repoPath, []string{"tsconfig.json"}) {
			return langTS
		}
		return langJS
	}
	return langUnknown
}

// deriveStack inspects package.json deps + filesystem signature files
// and returns a stable de-duped slice of stack tags. A dep-based hit
// can still win even when the file-based confirmation is missing (the
// repo may be brand-new and the operator hasn't run `next init` yet).
func deriveStack(pkg *parsedPackageJson, repoPath string, lang primaryLang) []string {
	seen := make(map[string]bool)
	out := []string{}
	add := func(tag string) {
		if seen[tag] {
			return
		}
		seen[tag] = true
		out = append(out, tag)
	}

	var deps map[string]string
	if pkg != nil {
		deps = pkg.deps
	}
	hasNext := dep(deps, "next")
	hasReact := dep(deps, "react") || dep(deps, "react-dom")
	hasNest := dep(deps, "@nestjs/core")

	if hasNext {
		add("next")
	}
	// react is implied by next — omit to keep the tag set short.
	if hasReact && !hasNext {
		add("react")
	}
	if dep(deps, "vue") {
		add("vue")
	}
	if dep(deps, "svelte") {
		add("svelte")
	}
	if hasNest {
		add("nestjs")
	}
	if dep(deps, "express") && !hasNext {
		add("express")
	}
	if dep(deps, "tailwindcss") {
		add("tailwindcss")
	}
	if dep(deps, "prisma") || dep(deps, "@prisma/client") {
		add("prisma")
	}
	if dep(deps, "typeorm") {
		add("typeorm")
	}
	if dep(deps, "@anthropic-ai/sdk") {
		add("anthropic-sdk")
	}
	if dep(deps, "playwright") || dep(deps, "@playwright/test") {
		add("playwright")
	}

	// File-based confirmation / fallback. Keeps the tag accurate when a
	// dep was hoisted into a workspace package.json the heuristic
	// doesn't see.
	if existsAny(repoPath, []string{
		"next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs",
	}) {
		add("next")
	}
	if _, err := os.Stat(filepath.Join(repoPath, "prisma", "schema.prisma")); err == nil {
		add("prisma")
	}
	if existsAny(repoPath, []string{
		"tailwind.config.js", "tailwind.config.mjs", "tailwind.config.ts", "tailwind.config.cjs",
	}) {
		add("tailwindcss")
	}

	switch lang {
	case langPy:
		add("python")
	case langGo:
		add("go")
	case langJava:
		add("java")
	case langTS:
		add("typescript")
	}

	return out
}

func dep(deps map[string]string, name string) bool {
	if deps == nil {
		return false
	}
	_, ok := deps[name]
	return ok
}

// deriveFeatures scans the union of (stack tags, dep names, top-level
// dir names) for the FEATURE_RULES needles. The TS port also fed
// keyword + prisma-model harvests; this Go cut leans on dep names +
// dirs because every consumer of features today only cares about the
// rough business-domain bucket.
func deriveFeatures(stack []string, pkg *parsedPackageJson, repoPath, summary string) []string {
	parts := make([]string, 0, len(stack)+8)
	parts = append(parts, stack...)
	if pkg != nil {
		for k := range pkg.deps {
			parts = append(parts, k)
		}
		if pkg.name != "" {
			parts = append(parts, pkg.name)
		}
		if pkg.description != "" {
			parts = append(parts, pkg.description)
		}
	}
	if summary != "" {
		parts = append(parts, summary)
	}
	parts = append(parts, topLevelDirs(repoPath)...)
	blob := strings.ToLower(strings.Join(parts, " "))

	seen := make(map[string]bool)
	out := []string{}
	for _, rule := range featureRules {
		for _, needle := range rule.match {
			if strings.Contains(blob, needle) {
				if !seen[rule.feature] {
					seen[rule.feature] = true
					out = append(out, rule.feature)
				}
				break
			}
		}
	}
	return out
}

// topLevelDirs returns visible (non-dot) top-level directory names.
// Bounded by a single readdir — the heuristic never recurses, so a
// pathological tree depth can't lock us up.
func topLevelDirs(repoPath string) []string {
	entries, err := os.ReadDir(repoPath)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		out = append(out, name)
	}
	return out
}

// deriveEntrypoints picks glob patterns the coordinator can hand to a
// child agent's "look here first" tool list. Next.js + NestJS get
// framework-aware patterns; everything else falls back to a single
// language-keyed glob.
func deriveEntrypoints(stack []string, router routerStyle, lang primaryLang, repoPath string) []string {
	stackHas := func(s string) bool {
		for _, t := range stack {
			if t == s {
				return true
			}
		}
		return false
	}
	out := []string{}
	hasNext := stackHas("next")
	hasNest := stackHas("nestjs")

	if hasNext {
		switch router {
		case routerApp:
			out = append(out, "app/api/**/*.ts", "app/**/*.tsx")
		case routerPages:
			out = append(out, "pages/api/**/*.ts", "pages/**/*.tsx")
		default:
			out = append(out, "app/**/*.tsx", "pages/**/*.tsx")
		}
	}
	if hasNest {
		out = append(out,
			"src/**/*.controller.ts",
			"src/**/*.service.ts",
			"src/**/*.module.ts",
		)
	}
	if !hasNext && !hasNest {
		switch lang {
		case langTS, langJS:
			if dirExists(filepath.Join(repoPath, "src")) {
				out = append(out, "src/**/*.ts")
			}
			if dirExists(filepath.Join(repoPath, "lib")) {
				out = append(out, "lib/**/*.ts")
			}
			if len(out) == 0 {
				out = append(out, "**/*.ts")
			}
		case langPy:
			out = append(out, "**/*.py")
		case langGo:
			out = append(out, "**/*.go")
		case langJava:
			out = append(out, "src/main/java/**/*.java")
		}
	}
	return dedupeStrings(out)
}

func dedupeStrings(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// extractSummary picks the human-readable one-liner. Preference order
// matches the TS port: CLAUDE.md > README.md > package.json description >
// synthesized fallback. The fallback exists so a wholly-undocumented
// repo still surfaces *something* in the coordinator prompt.
func extractSummary(repoPath string, pkg *parsedPackageJson, name string, stack []string) string {
	if intro := extractMarkdownIntro(safeReadText(filepath.Join(repoPath, "CLAUDE.md"), readCapBytes)); intro != "" {
		return intro
	}
	if intro := extractMarkdownIntro(safeReadText(filepath.Join(repoPath, "README.md"), readCapBytes)); intro != "" {
		return intro
	}
	if pkg != nil && pkg.description != "" {
		return pkg.description
	}
	if len(stack) == 0 {
		return name + " — repo (no README found, no recognised stack)"
	}
	tag := strings.Join(firstN(stack, 4), " + ")
	return name + " — " + tag + " (no README found)"
}

func firstN(in []string, n int) []string {
	if len(in) <= n {
		return in
	}
	return in[:n]
}

// extractMarkdownIntro pulls "first heading — first paragraph" out of a
// markdown blob. Skips fenced code blocks, blockquotes, table rows.
// Empty input -> empty output (caller's preference chain falls through).
func extractMarkdownIntro(md string) string {
	if md == "" {
		return ""
	}
	lines := strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n")
	heading := ""
	paragraph := ""
	inFence := false
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if heading == "" && isMarkdownHeading(line) {
			heading = strings.TrimSpace(strings.TrimLeft(line, "# "))
			continue
		}
		if heading != "" && line != "" &&
			!strings.HasPrefix(line, "#") &&
			!strings.HasPrefix(line, ">") &&
			!strings.HasPrefix(line, "|") {
			paragraph = line
			break
		}
	}
	if heading != "" && paragraph != "" {
		return heading + " — " + paragraph
	}
	if heading != "" {
		return heading
	}
	return paragraph
}

// isMarkdownHeading is true for `#` … `######` followed by space + text.
// Avoids the regexp dep just for one shape.
func isMarkdownHeading(line string) bool {
	if !strings.HasPrefix(line, "#") {
		return false
	}
	i := 0
	for i < len(line) && line[i] == '#' && i < 6 {
		i++
	}
	return i >= 1 && i <= 6 && i < len(line) && line[i] == ' '
}
