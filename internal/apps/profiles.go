package apps

// On-disk cache of per-repo heuristic profiles — Go port of
// libs/profileStore.ts. Single JSON file at
// `<bridgeRoot>/.bridge-state/repo-profiles.json` (gitignored via the
// `.bridge-state/` rule). The bridge writes whenever the operator
// triggers a refresh; reads happen on coordinator startup + repo-
// scoring lookups.
//
// Scope intentionally trimmed from the TS module: this Go port carries
// only LoadProfiles / SaveProfiles / RefreshProfiles. The auto-refresh-
// on-staleness scheduler and `getProfile(name)` lookup helpers belong
// next to the cmd/bridge serve wiring (a global timer doesn't belong
// in a leaf data package).

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// profileStoreVersion gates the on-disk schema. Bump only on a
// breaking shape change — the loader treats a future version as if the
// file were missing so an older binary doesn't half-decode + lose data.
const profileStoreVersion = 1

// profileStoreFile is the sub-path under `.bridge-state/`. Constant
// rather than configurable: the JS bridge and the Go bridge must agree
// on the same filename so an operator can flip between them mid-day.
const profileStoreFile = "repo-profiles.json"

// RepoLike lets callers pass any repo-shaped value into RefreshProfiles
// without forcing them onto the apps.App concrete type. The interface
// is the minimum the refresh path needs: name, on-disk location, and a
// cheap "is the folder there?" probe.
type RepoLike interface {
	Name() string
	Path() string
	Exists() bool
}

// profileFile is the wire shape on disk. Versioned + keyed by repo
// name so callers can look up a profile without scanning the slice;
// the keyed form also lets RefreshProfiles preserve cached entries for
// repos that vanished off disk this run (a USB drive unmounted, a
// sibling clone deleted).
type profileFile struct {
	Version     int                    `json:"version"`
	RefreshedAt string                 `json:"refreshedAt"`
	Profiles    map[string]RepoProfile `json:"profiles"`
}

// profilesPath returns the absolute path to the cache file under the
// bridge's `.bridge-state/` dir.
func profilesPath(bridgeRoot string) string {
	return filepath.Join(bridgeRoot, ".bridge-state", profileStoreFile)
}

// LoadProfiles reads the cache file and returns the profiles as a
// flat slice in undefined-but-stable order. A missing file yields an
// empty slice with no error — the cache is a soft cache, not a contract.
// A malformed file is treated the same as missing so a half-written
// legacy file doesn't strand the operator.
func LoadProfiles(bridgeRoot string) []RepoProfile {
	body, err := os.ReadFile(profilesPath(bridgeRoot))
	if err != nil {
		// Missing file is normal on first run / fresh checkout.
		return nil
	}
	var pf profileFile
	if err := json.Unmarshal(body, &pf); err != nil {
		return nil
	}
	if pf.Version != profileStoreVersion {
		// Future-version file from a newer bridge: pretend we have no
		// cache rather than partial-decode and overwrite on next save.
		return nil
	}
	out := make([]RepoProfile, 0, len(pf.Profiles))
	for _, p := range pf.Profiles {
		out = append(out, p)
	}
	return out
}

// SaveProfiles persists the slice via the shared atomic-write helper.
// Profiles are keyed by Name on the way to disk — the slice form is a
// caller-friendly API but the file shape uses the map so per-repo
// lookups by future versions stay O(1).
func SaveProfiles(bridgeRoot string, profiles []RepoProfile) error {
	pf := profileFile{
		Version:     profileStoreVersion,
		RefreshedAt: nowRFC3339Nano(),
		Profiles:    make(map[string]RepoProfile, len(profiles)),
	}
	for _, p := range profiles {
		pf.Profiles[p.Name] = p
	}
	if err := meta.WriteJSONAtomic(profilesPath(bridgeRoot), pf, nil); err != nil {
		return fmt.Errorf("apps: save profiles: %w", err)
	}
	return nil
}

// RefreshProfiles re-runs DetectRepoProfile for every repo whose folder
// exists on disk, persists the merged result, and returns the new flat
// slice. Repos absent from disk are LEFT in the cache as-is so a
// temporarily missing sibling doesn't blow away its last known profile.
//
// Errors from individual repos can't happen — DetectRepoProfile never
// returns an error — but a SaveProfiles failure is logged-via-return:
// the caller gets the in-memory slice plus the error so it can decide
// to keep going or surface the failure.
func RefreshProfiles(bridgeRoot string, repos []RepoLike) ([]RepoProfile, error) {
	// Seed from the existing cache so missing-on-disk repos survive.
	cached := LoadProfiles(bridgeRoot)
	merged := make(map[string]RepoProfile, len(cached)+len(repos))
	for _, p := range cached {
		merged[p.Name] = p
	}
	for _, r := range repos {
		if !r.Exists() {
			continue
		}
		merged[r.Name()] = DetectRepoProfile(r.Name(), r.Path())
	}
	out := make([]RepoProfile, 0, len(merged))
	for _, p := range merged {
		out = append(out, p)
	}
	if err := SaveProfiles(bridgeRoot, out); err != nil {
		return out, err
	}
	return out, nil
}

// ProfilesFileExists is a cheap probe for the cache file's presence.
// Callers (the lazy-refresh wiring in cmd/bridge serve) use this to
// decide whether the first request should trigger a build.
func ProfilesFileExists(bridgeRoot string) bool {
	_, err := os.Stat(profilesPath(bridgeRoot))
	return err == nil || !errors.Is(err, fs.ErrNotExist)
}

// nowRFC3339Nano returns the current time in the same shape JS's
// `new Date().toISOString()` writes — so a JS bridge and a Go bridge
// produce byte-identical `refreshedAt` fields that diff tools won't
// flag as drift. Kept as a var so a test that needs a deterministic
// clock can swap it.
var nowRFC3339Nano = func() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
