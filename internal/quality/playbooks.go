package quality

import (
	"os"
	"path/filepath"
	"strings"
)

// playbookCapBytes matches PLAYBOOK_CAP_BYTES in libs/playbooks.ts.
// Same rationale as houseRulesCapBytes — defensive bound on the bytes
// we'll splice into a child prompt.
const playbookCapBytes = 32 * 1024

// playbooksDir is the conventional sub-directory containing role-keyed
// markdown templates. Looked up under the per-app root the caller
// passes in (NOT the bridge root — playbooks are app-specific in this
// migration's model).
const playbooksDir = "playbooks"

// ListPlaybooks walks `<appRoot>/playbooks/*.md` and returns a map of
// playbook name (file basename without the .md suffix) to the trimmed
// markdown body. Returns an empty (non-nil) map when the directory is
// missing OR contains no .md files.
//
// Returning an always-non-nil map lets callers iterate without a nil
// guard. The TS version returned per-call lookups keyed by validated
// role; we eagerly enumerate because Go callers benefit from a single
// directory scan they can cache themselves rather than re-stat'ing per
// role lookup.
//
// File-level read failures are skipped silently rather than aborting
// the whole listing — one corrupt playbook shouldn't strand the rest.
func ListPlaybooks(appRoot string) map[string]string {
	out := map[string]string{}
	if appRoot == "" {
		return out
	}
	dir := filepath.Join(appRoot, playbooksDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		b, rerr := os.ReadFile(filepath.Join(dir, name))
		if rerr != nil {
			continue
		}
		if len(b) > playbookCapBytes {
			b = b[:playbookCapBytes]
		}
		body := strings.TrimSpace(string(b))
		if body == "" {
			continue
		}
		key := strings.TrimSuffix(name, ".md")
		out[key] = body
	}
	return out
}
