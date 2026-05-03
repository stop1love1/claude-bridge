package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/childprompt"
	"github.com/stop1love1/claude-bridge/internal/coordinator"
	"github.com/stop1love1/claude-bridge/internal/git"
	"github.com/stop1love1/claude-bridge/internal/memory"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/quality"
	"github.com/stop1love1/claude-bridge/internal/runlifecycle"
	"github.com/stop1love1/claude-bridge/internal/symbol"
)

// AgentBody is the POST /api/tasks/{id}/agents payload — the
// coordinator's spawn-child request.
type AgentBody struct {
	Role            string `json:"role"`
	Repo            string `json:"repo"`
	Prompt          string `json:"prompt"`
	ParentSessionID string `json:"parentSessionId,omitempty"`
	AllowDuplicate  bool   `json:"allowDuplicate,omitempty"`
	Mode            string `json:"mode,omitempty"` // "spawn" (default) | "resume"
}

var agentRoleRE = mustCompileRoleRE()

func mustCompileRoleRE() interface{ MatchString(string) bool } {
	// Match the validate.ts label charset: [A-Za-z0-9._-]{1,64}.
	return rolePattern{}
}

type rolePattern struct{}

func (rolePattern) MatchString(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '.' || r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}

// SpawnAgent — POST /api/tasks/{id}/agents. The coordinator calls
// this to dispatch a child agent into a target repo. Mirrors
// libs/coordinator + childPrompt + spawn integration with a
// minimum-viable feature set:
//   - mode=spawn: fresh child session via spawnFreeSession + child
//     prompt builder + git lifecycle hook
//   - mode=resume: continuation turn via spawnResumeClaude
//
// Out of scope for this port (defer to follow-up sessions):
//   - speculative dispatch fan-out
//   - worktree mode (children edit live tree only)
//   - permission user-approval mediation
//   - symbol-index / style-fingerprint / shared-plan / playbook /
//     pinned-files context (loaded if available, but no auto-refresh
//     gate; refs / recent-direction are still attached when the
//     symbol index exists)
//
// Acceptance: a coordinator that POSTs {role, repo, prompt} sees the
// child registered in meta.json, claude spawned in the resolved cwd,
// the run lifecycle armed.
func SpawnAgent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	defer func() { _ = r.Body.Close() }()
	var body AgentBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if !agentRoleRE.MatchString(body.Role) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid role"})
		return
	}
	if !apps.IsValidAppName(body.Repo) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid repo"})
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "prompt required"})
		return
	}
	if spawnerInstance == nil {
		WriteJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "spawner not configured",
		})
		return
	}

	c := currentConfig()
	dir := filepath.Join(c.SessionsDir, id)
	m, err := meta.ReadMeta(dir)
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if m == nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}

	cwd, ok := apps.ResolveCwd(getBridgeRoot(), body.Repo)
	if !ok {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown repo"})
		return
	}

	// Resume mode: short-circuit. Look up the prior run by
	// (parentSessionId, role, repo) and call ResumeClaude with the
	// operator's brief as the new user message.
	if body.Mode == "resume" {
		spawnAgentResume(w, r, dir, m, body, cwd, id)
		return
	}

	// Dedup check: an existing active (queued/running) child with the
	// same (parentSessionId, role, repo) means the coordinator
	// already dispatched this — return 409 unless allowDuplicate.
	if !body.AllowDuplicate {
		for _, run := range m.Runs {
			if run.Role != body.Role || run.Repo != body.Repo {
				continue
			}
			if body.ParentSessionID != "" {
				parentMatch := run.ParentSessionID != nil && *run.ParentSessionID == body.ParentSessionID
				if !parentMatch {
					continue
				}
			}
			if run.Status == meta.RunStatusQueued || run.Status == meta.RunStatusRunning {
				WriteJSON(w, http.StatusConflict, map[string]any{
					"error":             "duplicate active child for (parentSessionId, role, repo)",
					"existingSessionId": run.SessionID,
				})
				return
			}
		}
	}

	// Per-app git lifecycle hook — checkout the branch the app
	// settings dictate before spawning. Failures don't block the
	// spawn (operator can still recover) but log them.
	app, _ := apps.GetDefault().FindByName(body.Repo)
	branchSettings := git.Settings{}
	if app != nil {
		branchSettings = app.Git
	}
	branch, branchErr := git.PrepareForSpawn(cwd, id, branchSettings)
	if branchErr != nil {
		// Log but don't bail — operator can fix the branch issue.
		// The child runs on whatever branch HEAD already had.
		// Sanitize the error before stamping it as an HTTP header
		// value: git output may carry newlines or other control bytes
		// which would corrupt the response framing.
		w.Header().Set("X-Branch-Warning", sanitizeHeaderValue(branchErr.Error()))
	}

	// Worktree isolation — when the app opted in (worktreeMode is
	// sourced from extras since git.Settings doesn't carry it
	// today), allocate a private `<appRoot>/.worktrees/<sid>/` git
	// worktree. The child spawns there and the post-exit cascade
	// merges the worktree branch back via git.MergeWorktreeBack.
	// Failure → fall back to the live tree (non-fatal); the warning
	// surfaces via the X-Worktree-Warning response header.
	spawnCwd := cwd
	worktreeMode := decodeStringField(app, "git", "worktreeMode")
	var wt git.Worktree
	useWorktree := false
	if worktreeMode == "enabled" {
		newWT, werr := git.CreateWorktreeForRun(cwd, fmt.Sprintf("agent-%s", id), branch)
		if werr != nil {
			w.Header().Add("X-Worktree-Warning", sanitizeHeaderValue(werr.Error()))
		} else {
			wt = newWT
			useWorktree = true
			spawnCwd = wt.Path
		}
	}

	// Build the child prompt. Optional context (pinned files, symbol
	// index, style fingerprint, memory, house rules, playbook) is
	// loaded best-effort — missing pieces just skip their section.
	bridgeRoot := getBridgeRoot()
	houseRules := quality.ReadHouseRules(bridgeRoot)
	memEntries := memory.TopMemoryEntries(cwd, 10)
	playbookBody := loadPlaybookBody(cwd, body.Role)

	var pinnedSlice []string
	if app != nil {
		// App.Extras may carry pinnedFiles array. Best-effort decode.
		pinnedSlice = decodeStringList(app.Extras["pinnedFiles"])
	}
	pinnedFiles := memory.LoadPinnedFiles(cwd, pinnedSlice)

	var symIndex *symbol.SymbolIndex
	if app != nil {
		symbolDirs := decodeStringList(app.Extras["symbolDirs"])
		idx := symbol.Build(body.Repo, cwd, symbolDirs)
		symIndex = &idx
	}

	var styleFp *quality.StyleFingerprint
	if cwd != "" {
		fp := quality.BuildFingerprint(cwd, nil)
		styleFp = &fp
	}

	var refs []memory.ReferenceFile
	if symIndex != nil {
		refs = memory.AttachReferences(body.Prompt, *symIndex, memory.AttachOptions{
			AppPath: cwd,
		})
	}

	var recentSymbol symbol.SymbolIndex
	if symIndex != nil {
		recentSymbol = *symIndex
	}
	recent, _ := memory.LoadRecentDirection(cwd, "", memory.RecentOptions{
		TaskBody:    m.TaskBody,
		SymbolIndex: recentSymbol,
	})

	// Look up the resolved repo profile, if any.
	var profile *apps.RepoProfile
	for _, p := range apps.LoadProfiles(bridgeRoot) {
		if p.Name == body.Repo {
			cp := p
			profile = &cp
			break
		}
	}

	// Pre-allocate session id + render prompt.
	childSessionID := newAgentUUID()
	parentSession := body.ParentSessionID
	if parentSession == "" {
		// Fall back to the coordinator session (the most recent
		// running coordinator run on this task).
		for _, run := range m.Runs {
			if run.Role == "coordinator" && run.Status == meta.RunStatusRunning {
				parentSession = run.SessionID
				break
			}
		}
	}

	prompt := childprompt.Build(childprompt.Options{
		TaskID:             id,
		TaskTitle:          m.TaskTitle,
		TaskBody:           m.TaskBody,
		ParentSessionID:    parentSession,
		ChildSessionID:     childSessionID,
		Role:               body.Role,
		Repo:               body.Repo,
		RepoCwd:            cwd,
		BridgeURL:          coordinator.GetDefault().BridgeURL,
		BridgeFolder:       coordinator.GetDefault().BridgeFolder,
		CoordinatorBody:    body.Prompt,
		Profile:            profile,
		HouseRules:         houseRules,
		PlaybookBody:       playbookBody,
		PinnedFiles:        pinnedFiles,
		SymbolIndex:        symIndex,
		StyleFingerprint:   styleFp,
		AttachedReferences: refs,
		RecentDirection:    &recent,
		MemoryEntries:      memEntries,
	})

	// Append run as queued BEFORE spawn (orphan-window fix).
	parentSessionPtr := &parentSession
	if parentSession == "" {
		parentSessionPtr = nil
	}
	if err := meta.AppendRun(dir, meta.Run{
		SessionID:       childSessionID,
		Role:            body.Role,
		Repo:            body.Repo,
		Status:          meta.RunStatusQueued,
		ParentSessionID: parentSessionPtr,
	}); err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	sess, err := spawnerInstance.SpawnFreeSession(spawnCwd, prompt, nil, "", childSessionID)
	if err != nil {
		_, _ = meta.UpdateRun(dir, childSessionID, func(r *meta.Run) {
			r.Status = meta.RunStatusFailed
			now := time.Now().UTC().Format(time.RFC3339Nano)
			r.EndedAt = &now
		}, nil)
		if useWorktree {
			_ = git.RemoveWorktree(cwd, fmt.Sprintf("agent-%s", id))
		}
		WriteJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}

	startedAt := time.Now().UTC().Format(time.RFC3339Nano)
	if _, uerr := meta.UpdateRun(dir, childSessionID, func(r *meta.Run) {
		r.Status = meta.RunStatusRunning
		r.StartedAt = &startedAt
		if useWorktree {
			path := wt.Path
			b := wt.Branch
			base := wt.BaseBranch
			r.WorktreePath = &path
			r.WorktreeBranch = &b
			r.WorktreeBaseBranch = &base
		}
	}, nil); uerr != nil {
		// Meta write failed AFTER spawn succeeded — without this
		// surfacing, the child runs but the UI sees the row stuck in
		// queued forever. Kill the orphan and 500 with a clear error.
		if spawnRegistry != nil {
			spawnRegistry.Kill(childSessionID)
		}
		if useWorktree {
			_ = git.RemoveWorktree(cwd, fmt.Sprintf("agent-%s", id))
		}
		log.Printf("tasks_agents: post-spawn UpdateRun failed for %s; killed orphan child: %v", childSessionID, uerr)
		WriteJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "spawned child but failed to record running state: " + uerr.Error(),
		})
		return
	}

	// Verify chain hook — if the app declared a verify map in its
	// extras, run those commands after a clean exit and persist the
	// outcome to meta.runs[].verify. Failure of the chain doesn't
	// retry yet (LLM-driven retry cascade is out of scope); it just
	// logs the verdict to the run row.
	verifyHook := buildVerifyHook(app, spawnCwd)
	// exitCodeFn reads ProcessState. ProcessState is only safe to read
	// AFTER cmd.Wait() has returned, which is signaled here by sess.Done
	// closing. runlifecycle.Wire / WireWithVerify guarantee they call
	// exitCodeFn only after <-done has fired, so this access is race-free
	// at the call site. Don't move this read forward of sess.Done close.
	exitCodeFn := func() int {
		if sess.Cmd == nil || sess.Cmd.ProcessState == nil {
			return -1
		}
		return sess.Cmd.ProcessState.ExitCode()
	}
	wireOpts := runlifecycle.WireOpts{
		Ctx:           r.Context(),
		GitSettings:   &branchSettings,
		RepoPath:      spawnCwd,
		CommitMessage: fmt.Sprintf("bridge: %s/%s for %s", body.Role, body.Repo, id),
	}
	label := fmt.Sprintf("agent %s/%s/%s", id, body.Role, body.Repo)
	if verifyHook != nil {
		runlifecycle.WireWithVerifyOpts(dir, childSessionID, sess.Done, exitCodeFn, label, verifyHook, wireOpts)
	} else {
		runlifecycle.WireWithOpts(dir, childSessionID, sess.Done, exitCodeFn, label, wireOpts)
	}

	resp := map[string]any{
		"sessionId": childSessionID,
		"role":      body.Role,
		"repo":      body.Repo,
		"branch":    branch,
		"pid":       sess.Cmd.Process.Pid,
	}
	if useWorktree {
		resp["worktreePath"] = wt.Path
		resp["worktreeBranch"] = wt.Branch
	}
	WriteJSON(w, http.StatusCreated, resp)
}

// buildVerifyHook returns a runlifecycle.VerifyHook that runs the
// app's configured verify commands (format/lint/typecheck/test/build)
// after a clean exit. Returns nil when the app declared no commands —
// callers fall back to plain Wire.
func buildVerifyHook(app *apps.App, cwd string) runlifecycle.VerifyHook {
	if app == nil || cwd == "" {
		return nil
	}
	steps := decodeVerifySteps(app.Extras["verify"])
	if len(steps) == 0 {
		return nil
	}
	return func(_, _ string) (meta.RunVerify, bool, error) {
		out, err := runlifecycle.Run(steps, cwd, runlifecycle.VerifyOptions{})
		if err != nil {
			return meta.RunVerify{}, false, err
		}
		return out, true, nil
	}
}

// decodeVerifySteps converts the per-app verify map (raw JSON
// {format, lint, typecheck, test, build} → command string) into the
// canonical-ordered runlifecycle.VerifyStep slice.
func decodeVerifySteps(raw []byte) []runlifecycle.VerifyStep {
	if len(raw) == 0 {
		return nil
	}
	var v map[string]string
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	out := make([]runlifecycle.VerifyStep, 0, 5)
	for _, name := range []string{"format", "lint", "typecheck", "test", "build"} {
		if cmd, ok := v[name]; ok && cmd != "" {
			out = append(out, runlifecycle.VerifyStep{Name: name, Cmd: cmd})
		}
	}
	return out
}

// decodeStringField pulls one nested string field out of an App's
// Extras map (e.g. extras["git"]["worktreeMode"]). Returns "" on any
// shape mismatch — callers treat as "feature off".
func decodeStringField(app *apps.App, parent, key string) string {
	if app == nil {
		return ""
	}
	raw, ok := app.Extras[parent]
	if !ok {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// spawnAgentResume handles the mode=resume branch — looks up the
// prior run, calls ResumeClaude with the new brief as a follow-up
// turn, wires lifecycle, returns 200.
func spawnAgentResume(w http.ResponseWriter, r *http.Request, dir string, m *meta.Meta, body AgentBody, cwd, taskID string) {
	// Find the prior child run with matching (parent, role, repo).
	var match *meta.Run
	for i := range m.Runs {
		run := m.Runs[i]
		if run.Role != body.Role || run.Repo != body.Repo {
			continue
		}
		if body.ParentSessionID != "" {
			parentMatch := run.ParentSessionID != nil && *run.ParentSessionID == body.ParentSessionID
			if !parentMatch {
				continue
			}
		}
		// Reject if the prior run is still active; resume requires a
		// finished session to extend.
		if run.Status == meta.RunStatusRunning || run.Status == meta.RunStatusQueued {
			WriteJSON(w, http.StatusConflict, map[string]any{
				"error":             "prior run still active — cannot resume; kill it first",
				"existingSessionId": run.SessionID,
			})
			return
		}
		match = &run
		break
	}
	if match == nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{
			"error": "no prior run to resume; spawn a fresh agent first",
		})
		return
	}

	sess, err := spawnerInstance.ResumeClaude(cwd, match.SessionID, body.Prompt, nil, "")
	if err != nil {
		WriteJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	// Update the prior run row back to running.
	startedAt := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = meta.UpdateRun(dir, match.SessionID, func(r *meta.Run) {
		r.Status = meta.RunStatusRunning
		r.StartedAt = &startedAt
		r.EndedAt = nil
	}, nil)
	app, _ := apps.GetDefault().FindByName(body.Repo)
	resumeGit := git.Settings{}
	if app != nil {
		resumeGit = app.Git
	}
	runlifecycle.WireWithOpts(dir, match.SessionID, sess.Done, func() int {
		if sess.Cmd == nil || sess.Cmd.ProcessState == nil {
			return -1
		}
		return sess.Cmd.ProcessState.ExitCode()
	}, fmt.Sprintf("resume %s/%s/%s", taskID, body.Role, body.Repo), runlifecycle.WireOpts{
		Ctx:           r.Context(),
		GitSettings:   &resumeGit,
		RepoPath:      cwd,
		CommitMessage: fmt.Sprintf("bridge: %s/%s for %s", body.Role, body.Repo, taskID),
	})
	WriteJSON(w, http.StatusOK, map[string]any{
		"sessionId": match.SessionID,
		"role":      body.Role,
		"repo":      body.Repo,
		"resumed":   true,
		"pid":       sess.Cmd.Process.Pid,
	})
}

// loadPlaybookBody reads <cwd>/playbooks/<role>.md if it exists.
// Returns "" on missing file.
func loadPlaybookBody(cwd, role string) string {
	all := quality.ListPlaybooks(cwd)
	return all[role]
}

// decodeStringList decodes a json.RawMessage into []string. Returns
// nil for missing / malformed inputs (callers treat as empty list).
func decodeStringList(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

// newAgentUUID returns a fresh v4 UUID using crypto/rand. The earlier
// implementation derived bytes from time.UnixNano() with bit shifts —
// two parallel SpawnAgent calls in the same nanosecond would collide,
// silently overwriting one child's session row. crypto/rand makes the
// odds vanishingly small (≈ birthday-bound at 2^61 generations).
//
// Format mirrors spawn.newUUID so the on-disk session id shape is
// indistinguishable from spawner-minted ids.
func newAgentUUID() string {
	var b [16]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		// crypto/rand should never fail on supported platforms. Falling
		// back to a deterministic time-prefixed id rather than panicking
		// keeps the request loop alive; the operator can retry.
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // v4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	dst := make([]byte, 36)
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst)
}

// sanitizeHeaderValue strips control characters (\r, \n, NUL, tab) from
// a string before stamping it as an HTTP header value. Net/http does
// not validate these in older Go releases, and a stray newline in a
// header corrupts the response framing by injecting a fake header /
// body separator. We replace runs of control bytes with a single
// space and trim.
func sanitizeHeaderValue(s string) string {
	if s == "" {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	return strings.TrimSpace(b.String())
}

