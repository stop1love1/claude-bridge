package quality

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// houseRulesCapBytes mirrors HOUSE_RULES_CAP_BYTES in libs/houseRules.ts —
// a runaway markdown file (CI-generated changelog dumped into the wrong
// path, an operator's accidental binary paste) would otherwise blow out
// the child agent's context window. 32 KB comfortably fits any
// hand-authored house-rules doc while bounding the worst case.
const houseRulesCapBytes = 32 * 1024

// houseRulesFile is the on-disk basename. Lives at the bridge root
// (not under prompts/) per the operator-facing convention spelled out
// in CLAUDE.md.
const houseRulesFile = "HOUSE_RULES.md"

// ReadHouseRules loads the operator's house-rules markdown for prompt
// injection. Returns "" when the file is missing — callers treat the
// section as optional and skip rendering it rather than erroring.
//
// Read failures other than "not exist" (permission, EIO) also fall
// through to "" because the bridge must keep dispatching even if the
// rules file is temporarily unreadable; degrading the prompt is
// preferable to blocking every spawn on an operator-facing diagnostic.
//
// The byte cap is applied AFTER read so a 100 MB file still allocates
// 100 MB once — caller is expected to keep the file reasonable. We
// could stream-read the cap, but a one-shot read keeps the error
// surface trivial and the file is already operator-curated.
func ReadHouseRules(bridgeRoot string) string {
	if bridgeRoot == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(bridgeRoot, houseRulesFile))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			// Non-ENOENT errors are silently swallowed — see comment above.
			// We don't log here because the caller (prompt builder) runs
			// in a hot path and noisy logs would obscure real failures.
			_ = err
		}
		return ""
	}
	if len(b) > houseRulesCapBytes {
		b = b[:houseRulesCapBytes]
	}
	return strings.TrimSpace(string(b))
}
