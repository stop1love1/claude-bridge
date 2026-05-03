package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/pathsafe"
	"github.com/stop1love1/claude-bridge/internal/slash"
)

// ListRepos — GET /api/repos. Returns the resolved repo list (each
// app entry mapped to its absolute path). Mirrors libs/repos.ts
// resolveRepos.
func ListRepos(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{"repos": apps.ResolveRepos()})
}

// GetRepo — GET /api/repos/{name}. Returns the resolved entry by name.
// Uses the same name→cwd resolution rules as the spawn path so
// callers see the same resolution result.
func GetRepo(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if name == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "name required"})
		return
	}
	cwd, ok := apps.ResolveCwd(getBridgeRoot(), name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, apps.Resolved{Name: name, Path: cwd})
}

// slashItemDTO mirrors the Next handler's SlashCommandsItemDto shape.
// Description is *string so JSON-null surfaces for commands without a
// description (matching `description: string | null` in the TS type).
type slashItemDTO struct {
	Slug        string  `json:"slug"`
	Description *string `json:"description"`
	Source      string  `json:"source"`
}

// ListRepoSlashCommands — GET /api/repos/{name}/slash-commands.
// Returns the merged slash command set: project (per-app
// `.claude/commands/`) overrides user (`~/.claude/commands/`)
// overrides builtin. Same precedence as the claude CLI.
//
// S18 + S16/S17 unblock this — slash discovery + apps name validation
// + repos resolver are all available.
func ListRepoSlashCommands(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid app name"})
		return
	}
	cwd, ok := apps.ResolveCwd(getBridgeRoot(), name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "unknown repo"})
		return
	}

	// Per-source discovery: project (under cwd/.claude/commands), user
	// (under ~/.claude/commands), then builtins. Errors fall back to
	// empty so a missing dir doesn't 500 the response.
	project := slash.Discover([]string{filepath.Join(cwd, ".claude", "commands")})
	var user []slash.Command
	if home, err := os.UserHomeDir(); err == nil {
		user = slash.Discover([]string{filepath.Join(home, ".claude", "commands")})
	}
	builtins := slash.Builtins()

	// Merge: project > user > builtin per slug. Walk in
	// builtin → user → project order so the later layer overwrites.
	merged := make(map[string]slashItemDTO, len(builtins)+len(user)+len(project))
	mergeIn := func(cmds []slash.Command, source string) {
		for _, c := range cmds {
			prev := merged[c.Name]
			desc := prev.Description
			if c.Description != "" {
				d := c.Description
				desc = &d
			}
			merged[c.Name] = slashItemDTO{Slug: c.Name, Description: desc, Source: source}
		}
	}
	mergeIn(builtins, "builtin")
	mergeIn(user, "user")
	mergeIn(project, "project")

	items := make([]slashItemDTO, 0, len(merged))
	for _, v := range merged {
		items = append(items, v)
	}
	WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

// rawFileMaxBytes caps how much GetRepoRawFile will return. The TS port
// streamed images up to 8 MiB; this Go endpoint serves text content for
// the file picker and truncates beyond 256 KB so a giant log doesn't
// balloon the JSON response.
const rawFileMaxBytes = 256 * 1024

// repoFilesIgnoredDirs mirrors the Next handler's IGNORED_DIRS — folders
// that almost never contain user-relevant content for the file picker
// and would otherwise bloat the listing.
var repoFilesIgnoredDirs = map[string]struct{}{
	"node_modules": {}, ".git": {}, ".next": {}, ".turbo": {}, ".cache": {},
	"dist": {}, "build": {}, "out": {}, "coverage": {}, ".nuxt": {},
	".output": {}, "target": {}, "vendor": {}, ".idea": {}, ".vscode": {},
	".DS_Store": {},
}

// repoFileEntry is one row in the directory listing returned by
// ListRepoFiles. Type is "file" or "dir"; Mtime is RFC3339Nano UTC.
type repoFileEntry struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Size  int64  `json:"size"`
	Mtime string `json:"mtime"`
}

// resolveRepoSubpath validates that `rel` resolves to a path strictly
// inside `root`. Returns the absolute target path and true on success;
// "" + false when the path escapes.
//
// Both the empty string and "." map to the repo root itself. Any
// embedded NUL byte rejects immediately. Absolute rels are accepted
// when (and only when) they already resolve strictly inside the abs
// root — the file picker historically passes back the same abs path
// it received, so AllowAbsolute preserves that contract.
//
// Thin wrapper around pathsafe.Resolve — the heavy lifting (lexical +
// EvalSymlinks + parent walk + symlink-ancestor reject) lives in the
// shared package so every caller in the bridge enforces identical
// semantics. Don't inline a hand-rolled containment check here; the
// shared one is the only audited copy.
func resolveRepoSubpath(root, rel string) (string, bool) {
	got, err := pathsafe.Resolve(root, rel, pathsafe.AllowAbsolute())
	if err != nil {
		return "", false
	}
	return got, true
}

// ListRepoFiles — GET /api/repos/{name}/files?path=<rel>. Returns a
// shallow directory listing under the resolved subpath. The TS handler
// at app/api/repos/[name]/files/route.ts recursively flattened files
// for a fuzzy picker; this Go port returns one level of children
// (dir/file with size + mtime) so the UI can drive its own tree.
func ListRepoFiles(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid app name"})
		return
	}
	cwd, ok := apps.ResolveCwd(getBridgeRoot(), name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "unknown repo"})
		return
	}

	rel := r.URL.Query().Get("path")
	target, ok := resolveRepoSubpath(cwd, rel)
	if !ok {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
		return
	}

	stat, err := os.Stat(target)
	if err != nil {
		if os.IsNotExist(err) {
			WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !stat.IsDir() {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "not a directory"})
		return
	}

	dirents, err := os.ReadDir(target)
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	entries := make([]repoFileEntry, 0, len(dirents))
	for _, d := range dirents {
		nm := d.Name()
		if _, skip := repoFilesIgnoredDirs[nm]; skip {
			continue
		}
		info, err := d.Info()
		if err != nil {
			// Best-effort: skip entries we can't stat rather than 500ing
			// the whole listing.
			continue
		}
		typ := "file"
		if info.IsDir() {
			typ = "dir"
		}
		entries = append(entries, repoFileEntry{
			Name:  nm,
			Type:  typ,
			Size:  info.Size(),
			Mtime: info.ModTime().UTC().Format(time.RFC3339Nano),
		})
	}
	WriteJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// GetRepoRawFile — GET /api/repos/{name}/raw?path=<rel>. Returns the
// file's contents as JSON `{path, content, size, truncated}`. Caps at
// rawFileMaxBytes; truncated:true when the file exceeds the cap.
//
// The TS port at app/api/repos/[name]/raw/route.ts streamed image
// MIME types as a binary response for the chat preview path. This Go
// handler is the file-picker reader, so it always returns JSON text.
func GetRepoRawFile(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid app name"})
		return
	}
	cwd, ok := apps.ResolveCwd(getBridgeRoot(), name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "unknown repo"})
		return
	}
	rel := r.URL.Query().Get("path")
	if rel == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "path required"})
		return
	}
	target, ok := resolveRepoSubpath(cwd, rel)
	if !ok {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
		return
	}
	stat, err := os.Stat(target)
	if err != nil {
		if os.IsNotExist(err) {
			WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !stat.Mode().IsRegular() {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "not a file"})
		return
	}

	f, err := os.Open(target)
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer func() { _ = f.Close() }()

	// Read up to cap+1 so we can detect a file that's exactly at or above
	// the cap and flag truncated:true.
	buf, err := io.ReadAll(io.LimitReader(f, rawFileMaxBytes+1))
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	truncated := false
	if len(buf) > rawFileMaxBytes {
		buf = buf[:rawFileMaxBytes]
		truncated = true
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"path":      rel,
		"content":   string(buf),
		"size":      stat.Size(),
		"truncated": truncated,
	})
}

// appRepo adapts an apps.App to the apps.RepoLike interface required by
// RefreshProfiles. The TS port built RepoLike literals from declared
// repos via { name, path, exists }; the Go App struct uses fields
// rather than methods, so this thin wrapper bridges the gap without
// touching the apps package.
type appRepo struct {
	name string
	path string
}

func (a appRepo) Name() string { return a.name }
func (a appRepo) Path() string { return a.path }
func (a appRepo) Exists() bool {
	if a.path == "" {
		return false
	}
	st, err := os.Stat(a.path)
	return err == nil && st.IsDir()
}

// loadRepoLikes returns every registered app as a RepoLike slice. Used
// by the profile endpoints that need to call RefreshProfiles.
func loadRepoLikes() []apps.RepoLike {
	list, err := apps.GetDefault().LoadApps()
	if err != nil {
		return nil
	}
	out := make([]apps.RepoLike, 0, len(list))
	for _, a := range list {
		out = append(out, appRepo{name: a.Name, path: a.ResolvedPath()})
	}
	return out
}

// ListRepoProfiles — GET /api/repos/profiles. Returns the cached
// profile slice. The TS port lazily auto-built on a stale cache; this
// Go handler returns the cache as-is and lets the operator hit
// /api/repos/profiles/refresh explicitly. Cleaner: a GET should never
// kick off filesystem walks under the bridge's load.
func ListRepoProfiles(w http.ResponseWriter, _ *http.Request) {
	profiles := apps.LoadProfiles(getBridgeRoot())
	if profiles == nil {
		profiles = []apps.RepoProfile{}
	}
	WriteJSON(w, http.StatusOK, map[string]any{"profiles": profiles})
}

// refreshBody is the optional POST body for RefreshRepoProfiles. The TS
// handler accepted `{ repo: string }`; we accept the same field plus
// the ?name=... query the prompt called out so the UI can pick either.
type refreshBody struct {
	Repo string `json:"repo,omitempty"`
}

// RefreshRepoProfiles — POST /api/repos/profiles/refresh. Re-runs
// DetectRepoProfile for every registered app (or one when ?name= /
// {"repo":"..."} is supplied) and writes the result back to the cache.
// Returns `{refreshed, profiles}` so the UI can show a count.
func RefreshRepoProfiles(w http.ResponseWriter, r *http.Request) {
	defer func() { _ = r.Body.Close() }()

	target := strings.TrimSpace(r.URL.Query().Get("name"))
	if target == "" {
		// Fall back to JSON body — empty body is fine, refresh-all.
		var body refreshBody
		if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
			target = strings.TrimSpace(body.Repo)
		}
	}

	allRepos := loadRepoLikes()
	var toRefresh []apps.RepoLike
	if target != "" {
		if !apps.IsValidAppName(target) {
			WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid repo"})
			return
		}
		for _, r := range allRepos {
			if r.Name() == target {
				toRefresh = []apps.RepoLike{r}
				break
			}
		}
		if len(toRefresh) == 0 {
			WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown repo: " + target})
			return
		}
	} else {
		toRefresh = allRepos
	}

	profiles, err := apps.RefreshProfiles(getBridgeRoot(), toRefresh)
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"refreshed": len(toRefresh),
		"profiles":  profiles,
	})
}

// GetRepoProfile — GET /api/repos/profiles/{name}. Filters the cached
// list for the named repo. 404 when the cache has no entry for it
// (the operator hasn't run a refresh yet, or the app isn't registered).
func GetRepoProfile(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	for _, p := range apps.LoadProfiles(getBridgeRoot()) {
		if p.Name == name {
			WriteJSON(w, http.StatusOK, p)
			return
		}
	}
	WriteJSON(w, http.StatusNotFound, map[string]string{"error": "profile not found: " + name})
}

// DeleteRepoProfile — DELETE /api/repos/profiles/{name}. Drops the
// named entry from the cache and rewrites the file. The TS module
// didn't expose a delete endpoint; this is the Go-only convenience
// matching the prompt's spec.
func DeleteRepoProfile(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	root := getBridgeRoot()
	cur := apps.LoadProfiles(root)
	out := make([]apps.RepoProfile, 0, len(cur))
	found := false
	for _, p := range cur {
		if p.Name == name {
			found = true
			continue
		}
		out = append(out, p)
	}
	if !found {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "profile not found: " + name})
		return
	}
	if err := apps.SaveProfiles(root, out); err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}
