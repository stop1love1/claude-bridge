package api

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/memory"
	"github.com/stop1love1/claude-bridge/internal/quality"
	"github.com/stop1love1/claude-bridge/internal/symbol"
)

// ListApps — GET /api/apps. Returns the registry snapshot. Errors
// are surfaced as 500; an empty registry returns `{ "apps": [] }`.
func ListApps(w http.ResponseWriter, _ *http.Request) {
	r := apps.GetDefault()
	list, err := r.LoadApps()
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []apps.App{}
	}
	WriteJSON(w, http.StatusOK, map[string]any{"apps": list})
}

// AddAppBody is the POST /api/apps request shape. Mirrors the TS
// handler — name + path required; description optional.
type AddAppBody struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Description string `json:"description,omitempty"`
}

// AddApp — POST /api/apps. Validates name + path, appends to the
// registry. Returns 409 on duplicate name.
func AddApp(w http.ResponseWriter, r *http.Request) {
	defer func() { _ = r.Body.Close() }()
	var body AddAppBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if !apps.IsValidAppName(body.Name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	if body.Path == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "path required"})
		return
	}
	app := apps.App{Name: body.Name, Path: body.Path, Description: body.Description}
	if err := apps.GetDefault().AddApp(app); err != nil {
		if err == apps.ErrDuplicateName {
			WriteJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusCreated, app)
}

// GetApp — GET /api/apps/{name}. Returns the named app.
func GetApp(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	a, ok := apps.GetDefault().FindByName(name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, a)
}

// DeleteApp — DELETE /api/apps/{name}. Removes the named app.
// Returns 404 when missing.
func DeleteApp(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	removed, err := apps.GetDefault().RemoveApp(name)
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !removed {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// AutoDetectApps — POST /api/apps/auto-detect. Stub for S16: the full
// scanApp.ts heuristic (walks sibling dirs, identifies frameworks via
// package.json / Cargo.toml / go.mod) ports later. For now we return
// an empty list with a deferred note so the UI's auto-detect dialog
// renders without 404.
func AutoDetectApps(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"candidates": []any{},
		"deferred":   "scanApp.ts heuristic ports later",
	})
}

// BulkReplaceApps — POST /api/apps/bulk. Replaces the entire registry
// with the supplied array. Used by the auto-detect dialog's "Save all"
// flow: the operator sees the full candidate list, edits/checks
// rows, then submits the final desired registry in one shot.
//
// Body shape — accept either `{"apps": [...]}` (matches the TS POST
// body for parity with the per-item add handler) or a top-level array
// `[...]` for callers that prefer the bare list. Every entry must
// have a valid name + non-empty path; any failure rejects the whole
// batch (atomic replace) so the operator never ends up with a half-
// applied manifest.
func BulkReplaceApps(w http.ResponseWriter, r *http.Request) {
	defer func() { _ = r.Body.Close() }()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "read body: " + err.Error()})
		return
	}

	// Probe the JSON shape — array or object. Use json.RawMessage so we
	// don't decode the inner App slice twice on the object branch.
	var newApps []apps.App
	trimmed := bytesTrimSpace(body)
	if len(trimmed) == 0 {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "empty body"})
		return
	}
	if trimmed[0] == '[' {
		if err := json.Unmarshal(body, &newApps); err != nil {
			WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
			return
		}
	} else {
		var wrapper struct {
			Apps []apps.App `json:"apps"`
		}
		if err := json.Unmarshal(body, &wrapper); err != nil {
			WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
			return
		}
		newApps = wrapper.Apps
	}
	if newApps == nil {
		newApps = []apps.App{}
	}

	// Validate up-front. A duplicate name or invalid entry rejects the
	// whole batch — the alternative (silently dropping bad entries)
	// would leave the operator confused about what got saved.
	seen := make(map[string]bool, len(newApps))
	for i, a := range newApps {
		if !apps.IsValidAppName(a.Name) {
			WriteJSON(w, http.StatusBadRequest, map[string]any{
				"error": "invalid app name",
				"index": i,
				"name":  a.Name,
			})
			return
		}
		if strings.TrimSpace(a.Path) == "" {
			WriteJSON(w, http.StatusBadRequest, map[string]any{
				"error": "path required",
				"index": i,
				"name":  a.Name,
			})
			return
		}
		if seen[a.Name] {
			WriteJSON(w, http.StatusBadRequest, map[string]any{
				"error": "duplicate app name",
				"name":  a.Name,
			})
			return
		}
		seen[a.Name] = true
	}

	reg := apps.GetDefault()
	manifest, err := reg.Load()
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	manifest.Apps = newApps
	if err := reg.Save(manifest); err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"apps": newApps})
}

// bytesTrimSpace is a stdlib-free leading-whitespace trim used by
// BulkReplaceApps to peek at the first non-space byte (`[` vs `{`).
// Avoids importing bytes for this single call site.
func bytesTrimSpace(b []byte) []byte {
	i := 0
	for i < len(b) {
		c := b[i]
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
			break
		}
		i++
	}
	return b[i:]
}

// memoryGetLimit caps the number of entries the GET handler returns —
// matches the spec ("top N from TopMemoryEntries with N=10").
const memoryGetLimit = 10

// GetAppMemory — GET /api/apps/{name}/memory. Returns the raw memory
// markdown plus the top-N parsed bullets so the UI can render either
// the full file (edit affordance) or the structured list (chips).
func GetAppMemory(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	app, ok := apps.GetDefault().FindByName(name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	cwd := app.ResolvedPath()
	raw, _ := memory.LoadMemory(cwd)
	entries := memory.TopMemoryEntries(cwd, memoryGetLimit)
	if entries == nil {
		entries = []string{}
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"memory":  raw,
		"entries": entries,
	})
}

// AppendMemoryBody is the POST /api/apps/{name}/memory request shape.
type AppendMemoryBody struct {
	Entry string `json:"entry"`
}

// AppendAppMemory — POST /api/apps/{name}/memory. Appends one entry
// to the app's memory.md and returns the updated raw markdown plus
// `appended: bool`. Idempotent at the storage layer — AppendMemory
// returns the same bullet without rewriting when the head already
// matches, so a retry never doubles the entry. Reports
// `appended: false` only when the input was unusable (empty after
// trim, bad path, write failure).
func AppendAppMemory(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	app, ok := apps.GetDefault().FindByName(name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	defer func() { _ = r.Body.Close() }()
	var body AppendMemoryBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if strings.TrimSpace(body.Entry) == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "entry is empty"})
		return
	}
	if len(body.Entry) > memory.MaxEntryBytes {
		WriteJSON(w, http.StatusBadRequest, map[string]string{
			"error": "entry exceeds max length",
		})
		return
	}

	cwd := app.ResolvedPath()
	bullet, appended := memory.AppendMemory(cwd, body.Entry)
	if !appended {
		// AppendMemory swallows the underlying failure (bad cwd, write
		// error, idempotent no-op). Surface it via a log line so the
		// operator can correlate "memory chip didn't appear" with a
		// concrete cause; we still 200 with appended=false so the UI
		// has a single, well-typed signal to render.
		log.Printf("apps: AppendMemory returned !appended for %s (entry=%q bullet=%q)", name, body.Entry, bullet)
	}
	raw, _ := memory.LoadMemory(cwd)
	WriteJSON(w, http.StatusOK, map[string]any{
		"memory":   raw,
		"appended": appended,
	})
}

// scanAppBridgeRepo lets RefreshProfiles re-detect this one app
// without forcing the full registry through the refresh path. The
// shape mirrors apps.RepoLike — Name / Path / Exists — and is local
// to the scan handler so the apps package doesn't need a new helper.
type scanAppBridgeRepo struct {
	name string
	path string
}

func (r scanAppBridgeRepo) Name() string { return r.name }
func (r scanAppBridgeRepo) Path() string { return r.path }
func (r scanAppBridgeRepo) Exists() bool {
	st, err := os.Stat(r.path)
	return err == nil && st.IsDir()
}

// ScanApp — POST /api/apps/{name}/scan. Triggers the three on-demand
// scanners against one app:
//
//   - symbol.Build → top-level export index (used by the spawn
//     prompt's "available helpers" block).
//   - quality.BuildFingerprint → micro-style snapshot.
//   - apps.RefreshProfiles → re-runs DetectRepoProfile for this app
//     and persists the merged cache.
//
// The handler runs the scans inline (no background queue) — they're
// cheap (regex-only walks bounded at ~1500 files each) and the UI's
// "Refresh" button needs the freshly computed profile back in the
// response to update the card.
//
// Symbol-dirs come from the app's `symbolDirs` extras key (same shape
// as the spawn-time read in tasks_agents.go) so a per-app override
// in bridge.json is honored here too.
func ScanApp(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	app, ok := apps.GetDefault().FindByName(name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	cwd := app.ResolvedPath()
	if cwd == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "app path empty"})
		return
	}

	symbolDirs := decodeStringList(app.Extras["symbolDirs"])
	idx := symbol.Build(name, cwd, symbolDirs)
	fp := quality.BuildFingerprint(cwd, nil)

	// Refresh just this app's profile entry. RefreshProfiles preserves
	// every other repo's cached profile because it seeds the merge
	// from LoadProfiles before re-detecting only the apps we pass.
	bridgeRoot := getBridgeRoot()
	profiles, _ := apps.RefreshProfiles(bridgeRoot, []apps.RepoLike{
		scanAppBridgeRepo{name: name, path: cwd},
	})
	var profile *apps.RepoProfile
	for i := range profiles {
		if profiles[i].Name == name {
			cp := profiles[i]
			profile = &cp
			break
		}
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"ok":                true,
		"symbolCount":       len(idx.Symbols),
		"styleSampledFiles": fp.SampledFiles,
		"profile":           profile,
	})
}
