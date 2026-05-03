// Package apps reads + writes the bridge's app registry from
// `~/.claude/bridge.json` (or wherever BridgeRoot points). The file
// is the operator's canonical list of repos the bridge knows how to
// dispatch into. Stored outside the bridge project so a `git pull` /
// version upgrade on the bridge repo never touches the operator's
// app roster.
//
// Ported from libs/apps.ts in S16 — the focused subset needed to
// unblock the cross-package consumers (repos resolver, sessions list,
// task usage breakdown). Rich per-app settings (verify chain, quality
// gates, retry budgets, memory distill, speculative dispatch) are
// declared in the JSON but read through json.RawMessage passthrough
// so meta-level round-trips don't drop fields the verify-chain port
// will need later.
package apps

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/stop1love1/claude-bridge/internal/git"
	"github.com/stop1love1/claude-bridge/internal/meta"
)

// schemaVersion is the bridge.json `version` field. Reserved for future
// schema migrations; today every reader accepts version 1.
const schemaVersion = 1

// appNameRE gates the per-app name charset. Same shape as a folder
// slug — no slashes / dots / spaces — so a name can be safely
// path-joined or used as a CSS id.
var appNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// IsValidAppName reports whether s matches the registry's name charset.
func IsValidAppName(s string) bool {
	return appNameRE.MatchString(s)
}

// App is one entry in the registry. The fields ported here are the
// minimum a coordinator + the sessions-list endpoint need to dispatch
// into the right cwd. The verify / quality / retry / memory / dispatch
// fields the TS module owns are passed through verbatim via Extras so
// a bridge.json round-trip via this package preserves them.
type App struct {
	Name        string       `json:"name"`
	Path        string       `json:"path"` // raw — exactly what the user wrote
	Description string       `json:"description,omitempty"`
	Git         git.Settings `json:"git,omitempty"`

	// Extras holds every other key the TS module knows about (verify,
	// quality, retry, memory, dispatch, capabilities, pinnedFiles,
	// symbolDirs). Round-tripped verbatim until those subsystems port.
	Extras map[string]json.RawMessage `json:"-"`

	// resolvedPath is filepath.Abs(rawPath) relative to BridgeRoot,
	// memoized at load time. Not serialized — Path is the canonical
	// on-disk shape.
	resolvedPath string
}

// ResolvedPath returns the absolute path the App points at, computed
// against the BridgeRoot the registry was loaded with.
func (a *App) ResolvedPath() string {
	if a.resolvedPath != "" {
		return a.resolvedPath
	}
	return a.Path
}

// MarshalJSON re-merges the explicit struct fields with the Extras
// passthrough so a round-trip preserves every key the TS module
// declared.
func (a App) MarshalJSON() ([]byte, error) {
	out := make(map[string]json.RawMessage, 4+len(a.Extras))
	for k, v := range a.Extras {
		out[k] = v
	}
	put := func(key string, val any) error {
		b, err := json.Marshal(val)
		if err != nil {
			return err
		}
		out[key] = b
		return nil
	}
	if err := put("name", a.Name); err != nil {
		return nil, err
	}
	if err := put("path", a.Path); err != nil {
		return nil, err
	}
	if a.Description != "" {
		if err := put("description", a.Description); err != nil {
			return nil, err
		}
	}
	if !isZeroGitSettings(a.Git) {
		if err := put("git", a.Git); err != nil {
			return nil, err
		}
	}
	return json.Marshal(out)
}

// UnmarshalJSON decodes the fields we know about and stashes the rest
// in Extras for round-trip preservation.
func (a *App) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["name"]; ok {
		_ = json.Unmarshal(v, &a.Name)
		delete(raw, "name")
	}
	if v, ok := raw["path"]; ok {
		_ = json.Unmarshal(v, &a.Path)
		delete(raw, "path")
	}
	if v, ok := raw["description"]; ok {
		_ = json.Unmarshal(v, &a.Description)
		delete(raw, "description")
	}
	if v, ok := raw["git"]; ok {
		_ = json.Unmarshal(v, &a.Git)
		delete(raw, "git")
	}
	if len(raw) > 0 {
		a.Extras = raw
	}
	return nil
}

func isZeroGitSettings(s git.Settings) bool {
	return s.BranchMode == "" && s.FixedBranch == "" && !s.AutoCommit && !s.AutoPush
}

// Manifest is the on-disk shape of bridge.json. Apps is the list this
// package owns; Extras carries every other top-level key (auth tokens,
// telegram settings, …) verbatim so a write-back from this module
// doesn't blow away keys the TS sister-modules wrote.
type Manifest struct {
	Version int                        `json:"version"`
	Apps    []App                      `json:"apps"`
	Extras  map[string]json.RawMessage `json:"-"`
}

// MarshalJSON merges the explicit fields with Extras so round-trips
// preserve unknown top-level keys.
func (m Manifest) MarshalJSON() ([]byte, error) {
	out := make(map[string]json.RawMessage, 2+len(m.Extras))
	for k, v := range m.Extras {
		out[k] = v
	}
	if err := jsonPut(out, "version", m.Version); err != nil {
		return nil, err
	}
	if err := jsonPut(out, "apps", m.Apps); err != nil {
		return nil, err
	}
	return json.Marshal(out)
}

// UnmarshalJSON partitions the top-level keys.
func (m *Manifest) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["version"]; ok {
		_ = json.Unmarshal(v, &m.Version)
		delete(raw, "version")
	}
	if v, ok := raw["apps"]; ok {
		_ = json.Unmarshal(v, &m.Apps)
		delete(raw, "apps")
	}
	if len(raw) > 0 {
		m.Extras = raw
	}
	if m.Version == 0 {
		m.Version = schemaVersion
	}
	return nil
}

func jsonPut(out map[string]json.RawMessage, key string, val any) error {
	b, err := json.Marshal(val)
	if err != nil {
		return err
	}
	out[key] = b
	return nil
}

// Registry holds an in-memory snapshot of bridge.json. The TS module
// keyed off a 1-second cache; we use the same staleness window so
// repeated handler calls within one tick don't re-read the file.
type Registry struct {
	BridgeRoot string

	mu    sync.RWMutex
	cache *Manifest
}

// New returns a registry that reads bridge.json from the given root.
// Empty root means "current working directory" — production callers
// pass the resolved BRIDGE_ROOT.
func New(bridgeRoot string) *Registry {
	if bridgeRoot == "" {
		bridgeRoot = "."
	}
	return &Registry{BridgeRoot: bridgeRoot}
}

// Default is the package-global registry. cmd/bridge serve calls
// SetDefault(...) at startup; tests construct their own via New().
var (
	defaultMu sync.RWMutex
	defaults  *Registry
)

// SetDefault installs the package-global registry. Idempotent.
func SetDefault(r *Registry) {
	defaultMu.Lock()
	defer defaultMu.Unlock()
	defaults = r
}

// GetDefault returns the package-global registry. Falls back to
// New(".") when SetDefault has not been called — keeps tests that
// don't bother wiring it from panicking.
func GetDefault() *Registry {
	defaultMu.RLock()
	defer defaultMu.RUnlock()
	if defaults == nil {
		return New(".")
	}
	return defaults
}

// bridgeJSONPath returns the absolute path to the registry's
// bridge.json.
func (r *Registry) bridgeJSONPath() string {
	return filepath.Join(r.BridgeRoot, "bridge.json")
}

// Load reads bridge.json from disk. Cached across calls; returns the
// cached snapshot on hit. A missing file yields an empty manifest
// (no apps) — never an error.
func (r *Registry) Load() (*Manifest, error) {
	r.mu.RLock()
	if r.cache != nil {
		cp := cloneManifest(r.cache)
		r.mu.RUnlock()
		return cp, nil
	}
	r.mu.RUnlock()

	r.mu.Lock()
	defer r.mu.Unlock()
	// Re-check under the write lock — another goroutine may have populated.
	if r.cache != nil {
		return cloneManifest(r.cache), nil
	}
	body, err := os.ReadFile(r.bridgeJSONPath())
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			r.cache = &Manifest{Version: schemaVersion, Apps: []App{}}
			return cloneManifest(r.cache), nil
		}
		return nil, fmt.Errorf("apps: read %s: %w", r.bridgeJSONPath(), err)
	}
	var manifest Manifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return nil, fmt.Errorf("apps: parse %s: %w", r.bridgeJSONPath(), err)
	}
	if manifest.Apps == nil {
		manifest.Apps = []App{}
	}
	// Resolve each app's path against the bridge root so callers don't
	// have to repeat the dance.
	for i := range manifest.Apps {
		manifest.Apps[i].resolvedPath = resolveAppPath(r.BridgeRoot, manifest.Apps[i].Path)
	}
	r.cache = &manifest
	return cloneManifest(&manifest), nil
}

// LoadApps is a convenience wrapper that returns just the apps slice.
// Mirrors libs/apps.ts loadApps().
func (r *Registry) LoadApps() ([]App, error) {
	m, err := r.Load()
	if err != nil {
		return nil, err
	}
	return m.Apps, nil
}

// FindByName returns the app with the matching name, or nil + false.
func (r *Registry) FindByName(name string) (*App, bool) {
	apps, err := r.LoadApps()
	if err != nil {
		return nil, false
	}
	for i := range apps {
		if apps[i].Name == name {
			cp := apps[i]
			return &cp, true
		}
	}
	return nil, false
}

// Save writes the manifest back to disk via the atomic write helper
// (meta.WriteJSONAtomic). Drops the cache so the next Load picks up
// the new bytes. Mirrors libs/bridgeManifest.ts updateBridgeManifest.
func (r *Registry) Save(m *Manifest) error {
	if m == nil {
		return errors.New("apps: cannot save nil manifest")
	}
	if m.Version == 0 {
		m.Version = schemaVersion
	}
	if err := meta.WriteJSONAtomic(r.bridgeJSONPath(), m, nil); err != nil {
		return fmt.Errorf("apps: save %s: %w", r.bridgeJSONPath(), err)
	}
	r.mu.Lock()
	r.cache = nil
	r.mu.Unlock()
	return nil
}

// AddApp appends an app and Saves. Returns ErrDuplicateName if an
// app with the same name already exists.
func (r *Registry) AddApp(app App) error {
	if !IsValidAppName(app.Name) {
		return fmt.Errorf("apps: invalid name %q", app.Name)
	}
	m, err := r.Load()
	if err != nil {
		return err
	}
	for _, existing := range m.Apps {
		if existing.Name == app.Name {
			return ErrDuplicateName
		}
	}
	m.Apps = append(m.Apps, app)
	return r.Save(m)
}

// RemoveApp deletes the app by name. Returns false (no error) when the
// app didn't exist — caller surfaces 404 if that matters.
func (r *Registry) RemoveApp(name string) (bool, error) {
	m, err := r.Load()
	if err != nil {
		return false, err
	}
	idx := -1
	for i := range m.Apps {
		if m.Apps[i].Name == name {
			idx = i
			break
		}
	}
	if idx < 0 {
		return false, nil
	}
	m.Apps = append(m.Apps[:idx], m.Apps[idx+1:]...)
	if err := r.Save(m); err != nil {
		return false, err
	}
	return true, nil
}

// resolveAppPath turns the user-written Path into an absolute path.
// Absolute (POSIX or Windows drive-letter) paths stay as-is; everything
// else is resolved relative to bridgeRoot — matching the TS resolveAppPath.
func resolveAppPath(bridgeRoot, rawPath string) string {
	if rawPath == "" {
		return ""
	}
	if filepath.IsAbs(rawPath) {
		abs, _ := filepath.Abs(rawPath)
		return abs
	}
	abs, _ := filepath.Abs(filepath.Join(bridgeRoot, rawPath))
	return abs
}

// cloneManifest returns a defensive copy so callers can mutate
// without leaking back into the cached entry.
func cloneManifest(m *Manifest) *Manifest {
	if m == nil {
		return nil
	}
	out := &Manifest{
		Version: m.Version,
		Apps:    make([]App, len(m.Apps)),
	}
	for i, a := range m.Apps {
		out.Apps[i] = a
		// Extras is a map of RawMessage — RawMessage is a []byte alias,
		// safe to share across copies because nobody mutates the bytes.
	}
	if m.Extras != nil {
		out.Extras = make(map[string]json.RawMessage, len(m.Extras))
		for k, v := range m.Extras {
			out.Extras[k] = v
		}
	}
	return out
}

// Errors surfaced by the package.
var (
	ErrDuplicateName = errors.New("apps: app with that name already exists")
)

// trimSpace is a tiny helper kept private to the package.
func trimSpace(s string) string { return strings.TrimSpace(s) }
