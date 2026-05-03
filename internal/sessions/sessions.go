// Package sessions reads Claude Code's JSONL session files from
// ~/.claude/projects/<slug>/*.jsonl, exposes a list cache and an
// append-only event channel, and serves them through /api/sessions*.
//
// The package is the Go port of libs/sessions.ts + libs/sessionEvents.ts +
// libs/sessionListCache.ts. The on-disk layout it reads is owned by
// claude-code itself; the bridge never creates session files, only
// observes what claude wrote.
package sessions

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/stop1love1/claude-bridge/internal/pathsafe"
)

// PathToSlug converts an absolute path to claude-code's project-slug
// convention. Claude collapses path separators (/, \), drive colons (:),
// AND dots (.) all to dashes — so `C:\projects\my-bridge` becomes
// `C--projects-my-bridge` and `/home/u/my.bridge` becomes
// `-home-u-my-bridge`.
//
// Mirrors the TS regex `/[\\/:.]/g`.
func PathToSlug(absPath string) string {
	var b strings.Builder
	b.Grow(len(absPath))
	for _, r := range absPath {
		switch r {
		case '/', '\\', ':', '.':
			b.WriteByte('-')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// DefaultClaudeProjectsRoot returns the platform-default location of
// claude-code's per-project session tree (`~/.claude/projects`). Tests
// override this via Reader.Root rather than mutating the env.
func DefaultClaudeProjectsRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".claude", "projects")
	}
	return filepath.Join(home, ".claude", "projects")
}

// Reader is the entry point for everything sessions-related. Its only
// piece of state is the projects root (typically ~/.claude/projects);
// holding it on a struct lets contract tests point a fixture at a
// tempdir without monkey-patching globals.
//
// Zero value is NOT useful — construct via New().
type Reader struct {
	// Root is the absolute path to ~/.claude/projects (or its fixture
	// equivalent). All path resolution happens relative to it.
	Root string
}

// New returns a Reader pointing at the default claude projects root.
func New() *Reader {
	return &Reader{Root: DefaultClaudeProjectsRoot()}
}

// ProjectDirFor resolves the actual on-disk session directory for a
// given cwd. Always looks the folder up by case-insensitive match
// against ReadDir so the returned path uses the canonical casing the
// FS chose when claude created it. We can't trust os.Stat(direct) to
// short-circuit here — Windows' filesystem is case-insensitive, so the
// call returns true even when the slug we built differs from the on-
// disk folder by case. Without this, callers comparing path strings
// (e.g. the orphan-project dedupe in /api/sessions/all) miss matches
// and surface the same folder twice with different cases.
func (r *Reader) ProjectDirFor(cwd string) string {
	slug := PathToSlug(cwd)
	direct := filepath.Join(r.Root, slug)
	entries, err := os.ReadDir(r.Root)
	if err != nil {
		return direct
	}
	lower := strings.ToLower(slug)
	for _, e := range entries {
		if strings.ToLower(e.Name()) == lower {
			return filepath.Join(r.Root, e.Name())
		}
	}
	return direct
}

// uuidRE mirrors libs/validate.ts UUID_RE — the v4-ish shape claude
// uses for session ids. Case-insensitive hex.
var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IsValidSessionID gates untrusted route params against the UUID-v4 shape
// claude assigns to session ids. Pulled into this package so the HTTP
// layer can validate without dragging the auth/validate package in.
func IsValidSessionID(s string) bool {
	return uuidRE.MatchString(s)
}

// ResolveSessionFile resolves and validates a session-jsonl file path
// for a given (repoPath, sessionID) pair coming off an HTTP request.
// Returns the absolute file path the caller may safely read from, or
// ("", false) if the request looks pathological / unauthorized.
//
// Why a dedicated helper instead of inlining
// `filepath.Join(r.ProjectDirFor(repo), sid+".jsonl")` per route:
//
//   - Path-traversal defense in depth. PathToSlug already strips /, \, :, .
//     so the slug can't contain a separator, but a future change to that
//     substitution must not silently re-open the hole. We re-verify the
//     resolved path stays inside the projects root after filepath.Clean.
//   - No probing arbitrary claude project dirs. Without this check, an
//     authenticated client could pass repo=/some/other/project and read
//     its session transcripts. We require the slug to point at a
//     directory that already exists on disk — i.e. a real project the
//     bridge would surface in /api/sessions/all anyway. New / fictional
//     paths get a 400 instead of a probe-by-status-code.
//   - Input shape. Reject NUL bytes and oversize repo strings up front;
//     reject malformed session ids via IsValidSessionID.
//
// Callers turn (false) into 400 Bad Request (or 404 — both are
// acceptable; the helper deliberately doesn't distinguish so the wire
// doesn't leak which check failed).
func (r *Reader) ResolveSessionFile(repoPath, sessionID string) (string, bool) {
	if repoPath == "" || len(repoPath) > 4096 {
		return "", false
	}
	if strings.ContainsRune(repoPath, '\x00') {
		return "", false
	}
	if !IsValidSessionID(sessionID) {
		return "", false
	}

	dir := r.ProjectDirFor(repoPath)
	// Containment: filepath.Clean (via pathsafe.Contains -> Abs)
	// normalizes any `..` that survived slug substitution; the result
	// must still be under root. pathsafe also re-checks via EvalSymlinks
	// so a future slug substitution that didn't strip a symlink
	// component still couldn't escape r.Root.
	if !pathsafe.Contains(r.Root, dir) {
		return "", false
	}
	dirClean, err := filepath.Abs(dir)
	if err != nil {
		return "", false
	}
	// The slugged dir must already exist. This is what restricts callers
	// to project dirs the user has actually used claude in — no fishing
	// for arbitrary slugs.
	st, err := os.Stat(dirClean)
	if err != nil || !st.IsDir() {
		return "", false
	}
	return filepath.Join(dirClean, sessionID+".jsonl"), true
}

// systemTagRE matches the wrapper tags claude-code (and the VS Code
// integration) inject around the first user message. They aren't user-
// typed and shouldn't dominate the preview — strip them out before
// picking a title. Mirrors libs/sessions.ts SYSTEM_TAG_RE.
var systemTagRE = regexp.MustCompile(`(?is)<(ide_opened_file|ide_selection|system-reminder|command-message|command-name|command-args|local-command-stdout|local-command-stderr)>.*?</[a-z_-]+>`)

func cleanText(raw string) string {
	return strings.TrimSpace(systemTagRE.ReplaceAllString(raw, ""))
}

// extractText pulls the user-typed text out of a message content
// payload, ignoring system-tag wrappers that the VS Code claude
// integration injects (`<ide_opened_file>`, etc.). For an array of
// text blocks, returns the first block that has real content after
// stripping; falls back to a stripped concat if no block stands alone.
//
// content can be a string, an array of {type, text}, or anything else
// (tool_use blocks, attachments) — we only extract from text.
func extractText(content any) string {
	switch v := content.(type) {
	case string:
		return cleanText(v)
	case []any:
		var combined strings.Builder
		for _, blk := range v {
			var text string
			switch b := blk.(type) {
			case string:
				text = b
			case map[string]any:
				if t, _ := b["type"].(string); t == "text" {
					text, _ = b["text"].(string)
				}
			}
			if text == "" {
				continue
			}
			cleaned := cleanText(text)
			if cleaned != "" {
				return cleaned
			}
			combined.WriteByte(' ')
			combined.WriteString(text)
		}
		// Every block was system-tag boilerplate — return whatever
		// cleaned text remains, even if it's empty.
		return cleanText(combined.String())
	}
	return ""
}

// Entry is one row in the sessions list — one .jsonl file under a
// project dir that holds at least one real conversation turn.
type Entry struct {
	// SessionID is the .jsonl basename without the extension.
	SessionID string `json:"sessionId"`
	// FilePath is the absolute on-disk path to the .jsonl.
	FilePath string `json:"filePath"`
	// Mtime is the file modification time in milliseconds since epoch
	// (matches the JS Date.getTime() the TS code uses).
	Mtime int64 `json:"mtime"`
	// Size is the file size in bytes.
	Size int64 `json:"size"`
	// Preview is the first ~120 chars of the first user message,
	// system-tags stripped. Empty for sessions whose first turn is
	// not user-typed.
	Preview string `json:"preview"`
}

// OrphanProject is one ~/.claude/projects/<slug>/ folder that holds at
// least one session and isn't already covered via the explicit repos
// list. The cwd is recovered from the newest session's first lines.
type OrphanProject struct {
	// Name is the basename of the recovered cwd (or the slug, if no
	// cwd field was found in any line).
	Name string `json:"name"`
	// Path is the recovered cwd (or the slug, if not found).
	Path string `json:"path"`
	// ProjectDir is the absolute path under r.Root.
	ProjectDir string `json:"projectDir"`
}

// ListSessions enumerates all claude session files (.jsonl) under
// projectDir. Uses the standard ~/.claude/projects/<slug>/ layout —
// we never create our own session files; we just read what claude
// wrote.
//
// Stub files (`{"type":"last-prompt",…}`) that claude writes as
// resume/rewind pointers share the .jsonl extension but contain no
// real conversation. They're filtered out via scanSessionHead so the
// sessions panel doesn't surface them as empty "orphan" rows.
//
// Result is sorted newest-mtime-first to match the TS ordering.
func ListSessions(projectDir string) []Entry {
	entries, err := os.ReadDir(projectDir)
	if err != nil {
		return nil
	}
	out := make([]Entry, 0, len(entries))
	for _, ent := range entries {
		name := ent.Name()
		if !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		full := filepath.Join(projectDir, name)
		st, err := ent.Info()
		if err != nil {
			continue
		}
		head := scanSessionHead(full)
		if !head.HasRealEntry {
			continue
		}
		out = append(out, Entry{
			SessionID: strings.TrimSuffix(name, ".jsonl"),
			FilePath:  full,
			Mtime:     st.ModTime().UnixMilli(),
			Size:      st.Size(),
			Preview:   head.Preview,
		})
	}
	// Newest first. Stable sort by mtime descending; ties keep ReadDir
	// order which on most platforms is filesystem-natural.
	sortByMtimeDesc(out)
	return out
}

// ReadSessionCwd recovers the absolute cwd claude recorded when it
// created a session. The slug-encoding PathToSlug uses is lossy (every
// /, \, :, and . collapses to -), so we can't reverse a project folder
// name back to a path on disk reliably. But every transcript line
// carries the original cwd as a field — read the first lines until we
// find one and pull it out. Used to surface sessions whose project
// folder isn't a bridge sibling (worktrees, unrelated repos, etc).
//
// Returns ("", false) when the file can't be read or no cwd field is
// present in the head window. The window is intentionally generous
// (256 KB) because real transcripts now begin with a queue-operation +
// a multi-KB attachment payload, and a single line carrying a base64
// image attachment can itself span >100 KB. A 16 KB cap was empirically
// too tight on those sessions.
func ReadSessionCwd(filePath string) (string, bool) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", false
	}
	defer func() { _ = f.Close() }()

	// headBytes caps how much of the file we'll inspect before giving up.
	// We use a bufio.Reader (no per-line ceiling) rather than a Scanner
	// so an oversize attachment line doesn't fail the whole scan with
	// bufio.ErrTooLong — that would silently break orphan-project
	// recovery for any session whose head contains a big attachment.
	const headBytes = 256 * 1024
	r := bufio.NewReader(io.LimitReader(f, headBytes))
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			trimmed := line
			if trimmed[len(trimmed)-1] == '\n' {
				trimmed = trimmed[:len(trimmed)-1]
			}
			if len(trimmed) > 0 && trimmed[len(trimmed)-1] == '\r' {
				trimmed = trimmed[:len(trimmed)-1]
			}
			if len(strings.TrimSpace(string(trimmed))) > 0 {
				var obj struct {
					Cwd string `json:"cwd"`
				}
				// Per-line errors (bad JSON, partially-flushed line) are
				// swallowed — the next line might still carry the cwd.
				if jerr := json.Unmarshal(trimmed, &obj); jerr == nil && obj.Cwd != "" {
					return obj.Cwd, true
				}
			}
		}
		if err != nil {
			// io.EOF (full file consumed) or io.ErrUnexpectedEOF / the
			// LimitReader-induced EOF when we hit headBytes — both mean
			// "no cwd in the inspected window". A read error mid-stream
			// is treated identically to keep this best-effort: a single
			// flaky read shouldn't break orphan recovery.
			return "", false
		}
	}
}

// DiscoverOrphanProjects scans the projects root for folders we haven't
// already covered via the explicit repos list, and returns one entry
// per folder with the cwd recovered from its newest session. The caller
// decides how to render these (typically as additional groups in the
// sessions list).
//
// excludeDirs is the set of project-dir paths already emitted —
// anything in it is skipped to avoid duplicate groups.
func (r *Reader) DiscoverOrphanProjects(excludeDirs map[string]struct{}) []OrphanProject {
	entries, err := os.ReadDir(r.Root)
	if err != nil {
		return nil
	}
	out := make([]OrphanProject, 0, len(entries))
	for _, ent := range entries {
		name := ent.Name()
		// Dot-prefixed entries are claude-internal backups (.bak,
		// .tombstones, etc.) — they may contain stale .jsonl files
		// whose cwd collides with a live project, which would surface
		// the same folder twice with subtly different casing. Skip
		// them, same way the bridge's sibling-iteration filter does.
		if strings.HasPrefix(name, ".") {
			continue
		}
		projectDir := filepath.Join(r.Root, name)
		if _, skip := excludeDirs[projectDir]; skip {
			continue
		}
		if !ent.IsDir() {
			continue
		}
		sessions := ListSessions(projectDir)
		if len(sessions) == 0 {
			continue
		}
		// The newest session is usually the freshest source of truth —
		// read its cwd. Fall back to the slug itself if no cwd field
		// is present (very old files, manually placed jsonl, etc.) so
		// the group is at least visible rather than silently dropped.
		cwd, ok := ReadSessionCwd(sessions[0].FilePath)
		path := name
		folderName := name
		if ok {
			path = cwd
			folderName = filepath.Base(cwd)
		}
		out = append(out, OrphanProject{
			Name:       folderName,
			Path:       path,
			ProjectDir: projectDir,
		})
	}
	return out
}

// sortByMtimeDesc is a tiny stable insertion sort tailored to small N
// (a typical project dir has ≤ a few hundred sessions). Avoiding the
// sort package keeps the dependency surface small and matches the TS
// `Array.sort((a,b) => b.mtime - a.mtime)` semantics exactly.
func sortByMtimeDesc(out []Entry) {
	for i := 1; i < len(out); i++ {
		j := i
		for j > 0 && out[j].Mtime > out[j-1].Mtime {
			out[j], out[j-1] = out[j-1], out[j]
			j--
		}
	}
}
