// Repo-name → absolute-cwd resolution by consulting the apps registry
// (bridge.json). The TS module also accepted any sibling folder of the
// bridge as a repo target, but that was a path-traversal hazard — only
// registered apps and the bridge folder itself are reachable now.
//
// (from internal/repos: this file used to live in a thin wrapper
// package; folded into apps so callers don't scatter
// Registry.LoadApps() calls everywhere.)
package apps

import (
	"path/filepath"
	"strings"
)

// Resolved is one row in the resolved-repos list — name + absolute path.
type Resolved struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// ResolveRepos returns every app from the registry mapped to absolute
// paths. Mirrors libs/repos.ts resolveRepos.
func ResolveRepos() []Resolved {
	r := GetDefault()
	list, err := r.LoadApps()
	if err != nil {
		return nil
	}
	out := make([]Resolved, 0, len(list))
	for _, a := range list {
		out = append(out, Resolved{Name: a.Name, Path: a.ResolvedPath()})
	}
	return out
}

// ResolveCwd resolves a repo name to its absolute working dir by
// looking it up in the registered apps. The bridge folder itself is
// never reachable here: an attacker who could claim `repo:
// "<bridge-folder>"` would otherwise gain read/write to bridge.json,
// .uploads, and the sessions store via routes like /api/repos/{name}/raw.
//
// To reference the bridge root explicitly, register it as a normal app
// in bridge.json (typical setup keeps the bridge out of the registry —
// it's not a target for cross-repo work).
//
// Returns "" + false on no match (caller responds 400). Mirrors
// libs/repos.ts resolveRepoCwd, including the security tightening
// that removed the implicit-sibling-fallback path-traversal hazard,
// and the bridge-folder-self-resolve hazard that was patched here.
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
	for _, r := range ResolveRepos() {
		if r.Name != name {
			continue
		}
		// Reject any app whose resolved path IS the bridge root —
		// even if it was registered, exposing the bridge folder via
		// /api/repos/{name}/raw etc. would leak bridge.json + .uploads.
		// Operators who need to browse the bridge folder should do so
		// through dedicated endpoints, not the apps registry.
		if pathsEqual(r.Path, root) {
			return "", false
		}
		return r.Path, true
	}
	return "", false
}

// pathsEqual compares two absolute paths after Clean+normalizing slash
// direction. Case-insensitive on Windows where the filesystem itself is
// case-insensitive; case-sensitive elsewhere.
func pathsEqual(a, b string) bool {
	ca := filepath.Clean(a)
	cb := filepath.Clean(b)
	if filepath.Separator == '\\' {
		return strings.EqualFold(ca, cb)
	}
	return ca == cb
}
