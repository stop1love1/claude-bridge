// Package slash enumerates the slash commands a claude-code session can
// see: the hard-coded built-ins shipped with claude itself, plus the
// user-defined `*.md` files under `~/.claude/commands/` and per-app
// `<repo>/.claude/commands/`.
//
// This is the Go port of libs/claudeBuiltinSlash.ts and a (deliberately
// trimmed) port of libs/claudeSlashDiscovery.ts. The TS module also
// walks `.claude/skills/<name>/SKILL.md` and parses YAML `name:` fields
// out of front-matter; the Go side only needs the simpler commands-dir
// flow today, so SKILL.md discovery is intentionally NOT ported here —
// add it in a follow-up if/when a caller needs it.
package slash

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Command describes one slash command surfaced to the UI / completion.
// Name is the slug without the leading "/" (lower-case); Description
// is best-effort (empty if the file lacked a front-matter `description:`
// or a leading `# heading`); Source is one of "builtin", "user", "app";
// Path is the absolute path of the source .md file (empty for builtins).
type Command struct {
	Name        string
	Description string
	Source      string
	Path        string
}

// builtinCommands mirrors libs/data/claude-builtin-slash.json. Kept as
// a Go literal so the package has no runtime file dependency — the JSON
// is the source of truth in TS, but the Go port is small enough that
// inlining is cheaper than embedding + parsing on every call.
var builtinCommands = []Command{
	{Name: "add-dir", Description: "Additional working directories", Source: "builtin"},
	{Name: "agents", Description: "Manage custom AI subagents", Source: "builtin"},
	{Name: "batch", Description: "Bundled skill — batch operations", Source: "builtin"},
	{Name: "bug", Description: "Report bugs to Anthropic", Source: "builtin"},
	{Name: "clear", Description: "Clear conversation history", Source: "builtin"},
	{Name: "claude-api", Description: "Bundled skill — Claude API", Source: "builtin"},
	{Name: "compact", Description: "Compress conversation context", Source: "builtin"},
	{Name: "config", Description: "Open Settings (config)", Source: "builtin"},
	{Name: "context", Description: "Inspect context window usage", Source: "builtin"},
	{Name: "cost", Description: "Show token usage / cost", Source: "builtin"},
	{Name: "debug", Description: "Bundled skill — debugging", Source: "builtin"},
	{Name: "doctor", Description: "Installation health check", Source: "builtin"},
	{Name: "help", Description: "List commands and help", Source: "builtin"},
	{Name: "hooks", Description: "Hooks configuration", Source: "builtin"},
	{Name: "init", Description: "Initialize CLAUDE.md / project memory", Source: "builtin"},
	{Name: "login", Description: "Switch Anthropic account", Source: "builtin"},
	{Name: "logout", Description: "Sign out", Source: "builtin"},
	{Name: "loop", Description: "Bundled skill — recurring tasks", Source: "builtin"},
	{Name: "mcp", Description: "Manage MCP servers", Source: "builtin"},
	{Name: "memory", Description: "Edit memory / CLAUDE.md", Source: "builtin"},
	{Name: "model", Description: "Choose model", Source: "builtin"},
	{Name: "permissions", Description: "Permissions", Source: "builtin"},
	{Name: "pr_comments", Description: "PR comments", Source: "builtin"},
	{Name: "resume", Description: "Resume session picker", Source: "builtin"},
	{Name: "review", Description: "Code review", Source: "builtin"},
	{Name: "rewind", Description: "Rewind conversation or code", Source: "builtin"},
	{Name: "sandbox", Description: "Sandboxed bash", Source: "builtin"},
	{Name: "simplify", Description: "Bundled skill — simplify", Source: "builtin"},
	{Name: "status", Description: "Session / status", Source: "builtin"},
	{Name: "terminal-setup", Description: "Terminal key bindings", Source: "builtin"},
	{Name: "usage", Description: "Plan usage / rate limits", Source: "builtin"},
	{Name: "vim", Description: "Vim-style editing", Source: "builtin"},
}

// Builtins returns a copy of the hard-coded slash commands shipped with
// claude-code. Returns a fresh slice each call so callers can't mutate
// the package-level table.
func Builtins() []Command {
	out := make([]Command, len(builtinCommands))
	copy(out, builtinCommands)
	return out
}

// Discover walks each root looking for `*.md` files at the top level
// (NOT recursive — claude's commands dir is flat) and returns one
// Command per file. The slug is the basename minus `.md`, lower-cased
// and slug-normalized; the description is parsed from the file body
// (see parseDescription). Files whose name doesn't normalize to a valid
// slug are skipped silently.
//
// Source is assigned by heuristic: a root that lives inside the user's
// home dir gets "user"; everything else (per-app `<repo>/.claude/...`)
// gets "app". This matches the TS module's project-vs-user distinction
// without forcing callers to thread a source label per root.
//
// Non-existent / unreadable roots are skipped silently — the caller is
// expected to pass a superset of likely locations and accept that some
// won't be present.
//
// Result is sorted by Name, then by Path, so output is deterministic
// across multiple roots that contributed the same slug.
func Discover(roots []string) []Command {
	home, _ := os.UserHomeDir()
	homeAbs, _ := filepath.Abs(home)

	var out []Command
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		source := sourceFor(root, homeAbs)
		for _, ent := range entries {
			if ent.IsDir() {
				continue
			}
			name := ent.Name()
			if !strings.HasSuffix(strings.ToLower(name), ".md") {
				continue
			}
			slug := normSlug(strings.TrimSuffix(name, filepath.Ext(name)))
			if slug == "" {
				continue
			}
			full := filepath.Join(root, name)
			abs, err := filepath.Abs(full)
			if err != nil {
				abs = full
			}
			body, err := os.ReadFile(full)
			desc := ""
			if err == nil {
				desc = parseDescription(string(body))
			}
			out = append(out, Command{
				Name:        slug,
				Description: desc,
				Source:      source,
				Path:        abs,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// sourceFor labels a root as "user" if it lives under the user's home
// directory (the personal `~/.claude/commands` location), else "app"
// (per-repo `<cwd>/.claude/commands`). Falls back to "app" when home
// cannot be resolved or paths can't be made absolute — this is the
// safer default; mislabeling a personal commands dir as "app" only
// affects the UI badge, never security/permissions.
func sourceFor(root, homeAbs string) string {
	if homeAbs == "" {
		return "app"
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "app"
	}
	// Case-insensitive on Windows. Comparing both lower-cased is good
	// enough — a legitimate POSIX path wouldn't have casing collisions
	// with a different real dir.
	a := strings.ToLower(abs)
	h := strings.ToLower(homeAbs)
	if a == h || strings.HasPrefix(a, h+string(filepath.Separator)) {
		return "user"
	}
	return "app"
}

// frontMatterRE captures a leading YAML front-matter block delimited by
// `---` lines. The body group is everything between the delimiters.
// Tolerates both LF and CRLF line endings (claude-code is cross-platform
// and these files are commonly authored on Windows).
var frontMatterRE = regexp.MustCompile(`(?s)\A---\r?\n(.*?)\r?\n---\s*`)

// descriptionInFM extracts a `description:` field out of a YAML front-
// matter block. We don't pull in a YAML parser — the format here is a
// flat list of `key: value` lines and we only ever read one key, so a
// regex is faster and avoids a dependency. Strips matching surrounding
// quotes ('...' or "...") if present.
var descriptionInFM = regexp.MustCompile(`(?m)^description:\s*(.+?)\s*$`)

// headingRE matches the first ATX-style `# heading` line in the body.
// Allows up to three leading spaces (CommonMark) and one or more `#`s
// for any heading level; we keep the raw text after the hashes.
var headingRE = regexp.MustCompile(`(?m)^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$`)

// parseDescription pulls a one-line description out of a markdown file,
// preferring (in order):
//
//  1. A YAML front-matter `description:` field, if there's a `---`-
//     delimited block at the very top of the file.
//  2. The first `#`-prefixed heading in the rest of the body.
//
// Returns "" if neither is found — the caller is expected to treat an
// empty description as "no description available", not as an error.
//
// The TS module is loose about what counts as a description (it picks
// "the first non-empty line of the body"); we tighten that to "the
// first heading" because the bridge UI renders these in a tooltip and
// arbitrary first lines (often a quoted instruction or a code fence)
// look terrible there. Callers that want the looser TS behavior can
// post-process the file themselves.
func parseDescription(content string) string {
	body := content
	if m := frontMatterRE.FindStringSubmatchIndex(content); m != nil {
		fm := content[m[2]:m[3]]
		if dm := descriptionInFM.FindStringSubmatch(fm); dm != nil {
			return trimQuotes(strings.TrimSpace(dm[1]))
		}
		// Front-matter present but no description — strip it and look
		// for a heading in the remaining body.
		body = content[m[1]:]
	}
	if hm := headingRE.FindStringSubmatch(body); hm != nil {
		return strings.TrimSpace(hm[1])
	}
	return ""
}

// trimQuotes drops a single matching pair of surrounding quotes. YAML
// allows either ' or " around scalar values; we accept both. Mismatched
// pairs (e.g. `"foo'`) are left as-is — better to expose the weird
// input than to silently mangle it.
func trimQuotes(s string) string {
	if len(s) < 2 {
		return s
	}
	first, last := s[0], s[len(s)-1]
	if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
		return s[1 : len(s)-1]
	}
	return s
}

// slugCharRE matches the characters claude-code allows in a slash slug:
// letters, digits, and a few separators. Mirrors the TS regex
// `/^[a-zA-Z0-9][a-zA-Z0-9:_-]*(?:\/[a-zA-Z0-9:_-]+)?$/` (loosened to
// not require the leading-alnum constraint here — we apply it via the
// first-char check after lower-casing).
var slugCharRE = regexp.MustCompile(`^[a-z0-9][a-z0-9:_/-]*$`)

// normSlug lower-cases and validates a candidate slug. Returns "" when
// the input cannot represent a slash command (empty after trim, leading
// non-alnum, contains illegal chars). Whitespace runs collapse to a
// single `-` so a filename like `My Cool Cmd.md` becomes `my-cool-cmd`.
func normSlug(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.TrimLeft(s, "/")
	// Collapse internal whitespace to dashes (matches the TS
	// `replace(/\s+/g, "-")`).
	s = whitespaceRE.ReplaceAllString(s, "-")
	s = strings.ToLower(s)
	if s == "" || !slugCharRE.MatchString(s) {
		return ""
	}
	return s
}

var whitespaceRE = regexp.MustCompile(`\s+`)
