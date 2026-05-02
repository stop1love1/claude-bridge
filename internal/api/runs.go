package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/git"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/repos"
	"github.com/stop1love1/claude-bridge/internal/sessions"
)

// Per-run subroutes — kill / prompt / diff under
// /api/tasks/{id}/runs/{sessionId}/. Mirrors the Next.js handlers in
// app/api/tasks/[id]/runs/[sessionId]/{kill,prompt,diff}/route.ts.
//
// The "per-run" prefix exists so the UI can target an individual run
// without depending on which task happens to own it — useful when the
// session id is the only stable handle the operator has (e.g. from a
// permission-prompt deep-link).

const (
	// diffCapBytes caps the git-diff body returned to the UI. The UI
	// renders inline; bigger payloads were trimmed at the source in the
	// TS handler too, so the contract stays the same.
	diffCapBytes = 256 * 1024
	// diffTimeout bounds how long a misbehaving git-diff call can
	// block a request goroutine (huge repos, FS lock contention).
	diffTimeout = 10 * time.Second
)

// findRun locates the run by sessionID inside meta.json for the given
// task dir. Returns the run + ok=true on hit, or status code + error
// string the caller should surface.
func findRun(dir, sessionID string) (*meta.Run, int, string) {
	m, err := meta.ReadMeta(dir)
	if err != nil {
		return nil, http.StatusInternalServerError, err.Error()
	}
	if m == nil {
		return nil, http.StatusNotFound, "task not found"
	}
	for i := range m.Runs {
		if m.Runs[i].SessionID == sessionID {
			cp := m.Runs[i]
			return &cp, http.StatusOK, ""
		}
	}
	return nil, http.StatusNotFound, "run not found"
}

// KillRun — POST /api/tasks/{id}/runs/{sessionId}/kill. SIGTERMs the
// named child (escalates to SIGKILL after the registry's grace window)
// and flips the run row to `failed` only if it's still in `running`.
//
// More specific than the global /api/sessions/{sid}/kill — this
// variant validates the (taskId, sessionId) pairing first so a stale
// UI click against the wrong task gets a 404 instead of silently
// killing the right session under the wrong task's name.
func KillRun(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	sid := chi.URLParam(r, "sessionId")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	c := currentConfig()
	dir := filepath.Join(c.SessionsDir, id)
	run, status, errStr := findRun(dir, sid)
	if run == nil {
		WriteJSON(w, status, map[string]string{"error": errStr})
		return
	}

	if spawnRegistry == nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "no live process for this session"})
		return
	}
	if !spawnRegistry.Kill(sid) {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "no live process for this session"})
		return
	}

	// Flip running→failed under the precondition gate so we never
	// clobber a transition the exit handler may have just written.
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = meta.UpdateRun(dir, sid, func(rr *meta.Run) {
		rr.Status = meta.RunStatusFailed
		rr.EndedAt = &now
	}, func(cur meta.Run) bool {
		return cur.Status == meta.RunStatusRunning
	})

	WriteJSON(w, http.StatusOK, map[string]any{
		"sessionId": sid,
		"action":    "killed",
	})
}

// GetRunPrompt — GET /api/tasks/{id}/runs/{sessionId}/prompt. The TS
// counterpart reads back the rendered prompt text the bridge persisted
// at spawn time (`<role>-<repo>.prompt.txt` inside the task dir). The
// Go side hasn't yet wired the spawn-side persistence step, so we
// return a 200 with a stub message + a `note` explaining what's
// missing. Updating the spawner to also write the prompt file is the
// cheap follow-up — once that lands, this handler swaps to a direct
// file read (path-validated, contained-under-task-dir).
//
// Returning 200-with-explanation rather than 501/503 keeps the UI's
// existing "show whatever the bridge gave us" flow working without
// special-casing this endpoint.
func GetRunPrompt(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	sid := chi.URLParam(r, "sessionId")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	c := currentConfig()
	dir := filepath.Join(c.SessionsDir, id)
	run, status, errStr := findRun(dir, sid)
	if run == nil {
		WriteJSON(w, status, map[string]string{"error": errStr})
		return
	}

	// Best-effort: if a future spawner version drops the file, try
	// reading it before falling back to the stub. Path is contained
	// to the task dir via filepath.Base + a final prefix check.
	if isValidRunRoleRepo(run.Role, run.Repo) {
		fileName := run.Role + "-" + run.Repo + ".prompt.txt"
		if filepath.Base(fileName) == fileName {
			full := filepath.Join(dir, fileName)
			absDir, derr := filepath.Abs(dir)
			absFile, ferr := filepath.Abs(full)
			if derr == nil && ferr == nil &&
				(absFile == absDir || strings.HasPrefix(absFile, absDir+string(filepath.Separator))) {
				if body, err := os.ReadFile(full); err == nil {
					WriteJSON(w, http.StatusOK, map[string]string{"prompt": string(body)})
					return
				}
			}
		}
	}

	WriteJSON(w, http.StatusOK, map[string]string{
		"prompt": "(prompt regeneration not implemented — re-spawn would be needed)",
		"note":   "Go bridge does not yet persist the rendered prompt at spawn time; full implementation requires teaching internal/spawn (or the agent route) to write <role>-<repo>.prompt.txt alongside meta.json so this endpoint can read it back like the TS version.",
	})
}

// runRoleRE / runRepoRE mirror the TS `isValidAgentRole` /
// `isValidRepoLabel` shape used to gate the prompt-file name. Closed
// charsets so the `<role>-<repo>.prompt.txt` template can't be coaxed
// into traversal.
var (
	runRoleRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)
	runRepoRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
)

func isValidRunRoleRepo(role, repo string) bool {
	if len(role) == 0 || len(role) > 64 {
		return false
	}
	if len(repo) == 0 || len(repo) > 128 {
		return false
	}
	return runRoleRE.MatchString(role) && runRepoRE.MatchString(repo)
}

// GetRunDiff — GET /api/tasks/{id}/runs/{sessionId}/diff. Resolves
// the run's working tree (worktree if registered + still on disk, else
// the live app cwd, else the BRIDGE.md repos table) and shells out to
// `git diff HEAD --no-color`. Falls back to plain `git diff` when the
// HEAD diff is empty (auto-commit may have moved tracked changes into
// a commit, leaving HEAD-vs-HEAD empty).
//
// Output is capped at diffCapBytes; truncation marker appended on
// overflow. Returns {kind, cwd, diff, truncated, repo, branch}.
func GetRunDiff(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	sid := chi.URLParam(r, "sessionId")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	c := currentConfig()
	dir := filepath.Join(c.SessionsDir, id)
	run, status, errStr := findRun(dir, sid)
	if run == nil {
		WriteJSON(w, status, map[string]string{"error": errStr})
		return
	}

	cwd, kind := resolveRunCwd(run)
	if cwd == "" {
		WriteJSON(w, http.StatusNotFound, map[string]string{
			"error": "cannot resolve a working tree for this run",
			"hint":  "worktree may have been pruned and the live repo is unregistered",
		})
		return
	}
	// Working tree must actually be a git repo. .git can be a dir
	// (live repo) or a file (worktree pointer) — both count.
	if _, err := os.Stat(filepath.Join(cwd, ".git")); err != nil {
		WriteJSON(w, http.StatusConflict, map[string]any{
			"error": "working tree is not a git repo",
			"cwd":   cwd,
		})
		return
	}

	diff, truncated, derr := runGitDiff(r.Context(), cwd)
	if derr != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]any{
			"error":  "git diff failed",
			"detail": derr.Error(),
			"cwd":    cwd,
		})
		return
	}
	branch, _ := git.ReadBranch(cwd)

	WriteJSON(w, http.StatusOK, map[string]any{
		"kind":      kind,
		"cwd":       cwd,
		"diff":      diff,
		"truncated": truncated,
		"repo":      run.Repo,
		"branch":    branch,
	})
}

// resolveRunCwd picks the working tree to diff against. Order:
//   1. The run's worktree (if recorded, contained under the registered
//      app root, and still on disk).
//   2. The registered app's live path.
//   3. The repos resolver (handles the bridge folder + sibling repos).
//
// kind is "worktree" or "live" — surfaced to the UI so the diff panel
// can label the source.
func resolveRunCwd(run *meta.Run) (cwd, kind string) {
	app, _ := apps.GetDefault().FindByName(run.Repo)
	if run.WorktreePath != nil && *run.WorktreePath != "" && app != nil {
		appAbs, e1 := filepath.Abs(app.ResolvedPath())
		wtAbs, e2 := filepath.Abs(*run.WorktreePath)
		if e1 == nil && e2 == nil && isUnderRoot(appAbs, wtAbs) {
			if st, err := os.Stat(wtAbs); err == nil && st.IsDir() {
				return wtAbs, "worktree"
			}
		}
	}
	if app != nil {
		p := app.ResolvedPath()
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p, "live"
		}
	}
	if p, ok := repos.ResolveCwd(getBridgeRoot(), run.Repo); ok {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p, "live"
		}
	}
	return "", ""
}

// isUnderRoot reports whether candidate is the same path as root or
// a descendant of it. Both inputs are expected to be absolute and
// already cleaned by filepath.Abs.
func isUnderRoot(root, candidate string) bool {
	if root == candidate {
		return true
	}
	sep := string(filepath.Separator)
	return strings.HasPrefix(candidate, root+sep) || strings.HasPrefix(candidate, root+"/")
}

// runGitDiff shells out to `git -C cwd diff HEAD --no-color`, falling
// back to plain `git diff` when HEAD-vs-HEAD is empty (the run already
// auto-committed). Output is bounded by diffCapBytes; the timeout
// keeps a misbehaving git from holding the request goroutine open.
func runGitDiff(parent context.Context, cwd string) (body string, truncated bool, err error) {
	body, err = runOneDiff(parent, cwd, []string{"-C", cwd, "diff", "HEAD", "--no-color"})
	if err != nil {
		return "", false, err
	}
	if strings.TrimSpace(body) == "" {
		// HEAD-vs-HEAD empty — try the index diff for runs that already
		// committed inside the worktree. Errors here are surfaced; an
		// empty result is fine.
		alt, altErr := runOneDiff(parent, cwd, []string{"-C", cwd, "diff", "--no-color"})
		if altErr != nil {
			return "", false, altErr
		}
		body = alt
	}
	if len(body) > diffCapBytes {
		body = body[:diffCapBytes] + "\n\n…(bridge: diff truncated at 262144 bytes)"
		truncated = true
	}
	return body, truncated, nil
}

// runOneDiff is the inner shell-out, kept separate so runGitDiff can
// invoke twice (HEAD then index) without duplicating the timeout /
// cap-buffer plumbing.
func runOneDiff(parent context.Context, cwd string, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, diffTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		// Differentiate context-deadline from git-failure for the
		// caller's error string. CombinedOutput would mix stderr in;
		// here stderr ends up in *exec.ExitError.Stderr which we
		// surface verbatim.
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
			return "", errors.New(strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", err
	}
	return string(out), nil
}
