package quality

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// originalPromptFile is the basename for the cached coordinator-rendered
// prompt under each task's session dir. Retry surfaces (crash, verify
// fail, claim-vs-diff) re-render against this so they don't have to
// rerun the coordinator. Single basename here keeps the convention in
// one place — TS used three suffixed variants per call site, but the
// store itself has always read one canonical file.
const originalPromptFile = "original-prompt.txt"

// ReadOriginalPrompt returns the original child prompt cached for a
// task. Fail-soft to "" on missing dir, missing file, or read error —
// every retry caller treats empty as "use only the failure context to
// make forward progress" rather than aborting the retry.
func ReadOriginalPrompt(taskDir string) string {
	if taskDir == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(taskDir, originalPromptFile))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			// Same swallow rationale as ReadHouseRules — retry path
			// must not break on transient read errors.
			_ = err
		}
		return ""
	}
	return string(b)
}

// WriteOriginalPrompt persists the rendered prompt via the same
// tempfile-rename helper meta.json uses. Crash mid-write therefore
// leaves either the previous prompt or the new one — never a
// half-written copy a retry would replay incorrectly.
//
// Empty taskDir returns an explicit error rather than silently
// no-op'ing because the writer side is the coordinator: a missing
// taskDir there is a programmer mistake worth surfacing, unlike the
// reader side where missing-dir is a normal "first attempt" state.
func WriteOriginalPrompt(taskDir, prompt string) error {
	if taskDir == "" {
		return errors.New("quality: WriteOriginalPrompt: empty taskDir")
	}
	return meta.WriteStringAtomic(filepath.Join(taskDir, originalPromptFile), prompt, nil)
}
