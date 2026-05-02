// Package repos resolves repo-name → absolute-cwd by consulting the
// apps registry (bridge.json). The TS module also accepted any sibling
// folder of the bridge as a repo target, but that was a path-traversal
// hazard — only registered apps and the bridge folder itself are
// reachable now.
//
// Thin wrapper around internal/apps so existing callers (coordinator,
// task usage, sessions list) don't scatter Registry.LoadApps() calls
// everywhere.
package repos

import (
	"path/filepath"
	"strings"

	"github.com/stop1love1/claude-bridge/internal/apps"
)

// Resolved is one row in the resolved-repos list — name + absolute path.
type Resolved struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// ResolveRepos returns every app from the registry mapped to absolute
// paths. Mirrors libs/repos.ts resolveRepos.
func ResolveRepos() []Resolved {
	r := apps.GetDefault()
	apps, err := r.LoadApps()
	if err != nil {
		return nil
	}
	out := make([]Resolved, 0, len(apps))
	for _, a := range apps {
		out = append(out, Resolved{Name: a.Name, Path: a.ResolvedPath()})
	}
	return out
}

// ResolveCwd resolves a repo name to its absolute working dir. Tries,
// in order:
//
//  1. The bridge folder itself — so `repo: "<bridge-folder>"` keeps
//     working without an explicit registry entry.
//  2. Any app declared in bridge.json.
//
// Returns "" + false on no match (caller responds 400). Mirrors
// libs/repos.ts resolveRepoCwd, including the security tightening
// that removed the implicit-sibling-fallback path-traversal hazard.
func ResolveCwd(bridgeRoot, name string) (string, bool) {
	if name == "" {
		return "", false
	}
	if strings.ContainsAny(name, `/\`) {
		return "", false
	}
	root, err := filepath.Abs(bridgeRoot)
	if err != nil {
		return "", false
	}
	if name == filepath.Base(root) {
		return root, true
	}
	for _, r := range ResolveRepos() {
		if r.Name == name {
			return r.Path, true
		}
	}
	return "", false
}
