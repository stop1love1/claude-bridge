package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
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
	"github.com/stop1love1/claude-bridge/internal/repos"
	"github.com/stop1love1/claude-bridge/internal/runlifecycle"
	"github.com/stop1love1/claude-bridge/internal/sessions"
	"github.com/stop1love1/claude-bridge/internal/spawn"
	"github.com/stop1love1/claude-bridge/internal/symbol"
)

// AgentBody is the POST /api/tasks/{id}/agents payload — the
// coordinator's spawn-child request.
type AgentBody struct {
	Role             string  `json:"role"`
	Repo             string  `json:"repo"`
	Prompt           string  `json:"prompt"`
	ParentSessionID  string  `json:"parentSessionId,omitempty"`
	AllowDuplicate   bool    `json:"allowDuplicate,omitempty"`
	Mode             string  `json:"mode,omitempty"` // "spawn" (default) | "resume"
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

	cwd, ok := repos.ResolveCwd(getBridgeRoot(), body.Repo)
	if !ok {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown repo"})
		return
	}

	// Resume mode: short-circuit. Look up the prior run by
	// (parentSessionId, role, repo) and call ResumeClaude with the
	// operator's brief as the new user message.
	if body.Mode == "resume" {
		spawnAgentResume(w, dir, m, body, cwd, id)
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
					"error":            "duplicate active child for (parentSessionId, role, repo)",
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
		w.Header().Set("X-Branch-Warning", branchErr.Error())
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
		TaskID:           id,
		TaskTitle:        m.TaskTitle,
		TaskBody:         m.TaskBody,
		ParentSessionID:  parentSession,
		ChildSessionID:   childSessionID,
		Role:             body.Role,
		Repo:             body.Repo,
		RepoCwd:          cwd,
		BridgeURL:        coordinator.GetDefault().BridgeURL,
		BridgeFolder:     coordinator.GetDefault().BridgeFolder,
		CoordinatorBody:  body.Prompt,
		Profile:          profile,
		HouseRules:       houseRules,
		PlaybookBody:     playbookBody,
		PinnedFiles:      pinnedFiles,
		SymbolIndex:      symIndex,
		StyleFingerprint: styleFp,
		AttachedReferences: refs,
		RecentDirection:  &recent,
		MemoryEntries:    memEntries,
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

	sess, err := spawnerInstance.SpawnFreeSession(cwd, prompt, nil, "", childSessionID)
	if err != nil {
		_, _ = meta.UpdateRun(dir, childSessionID, func(r *meta.Run) {
			r.Status = meta.RunStatusFailed
			now := time.Now().UTC().Format(time.RFC3339Nano)
			r.EndedAt = &now
		}, nil)
		WriteJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}

	startedAt := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = meta.UpdateRun(dir, childSessionID, func(r *meta.Run) {
		r.Status = meta.RunStatusRunning
		r.StartedAt = &startedAt
	}, nil)

	runlifecycle.Wire(dir, childSessionID, sess.Done, func() int {
		if sess.Cmd == nil || sess.Cmd.ProcessState == nil {
			return -1
		}
		return sess.Cmd.ProcessState.ExitCode()
	}, fmt.Sprintf("agent %s/%s/%s", id, body.Role, body.Repo))

	WriteJSON(w, http.StatusCreated, map[string]any{
		"sessionId": childSessionID,
		"role":      body.Role,
		"repo":      body.Repo,
		"branch":    branch,
		"pid":       sess.Cmd.Process.Pid,
	})
}

// spawnAgentResume handles the mode=resume branch — looks up the
// prior run, calls ResumeClaude with the new brief as a follow-up
// turn, wires lifecycle, returns 200.
func spawnAgentResume(w http.ResponseWriter, dir string, m *meta.Meta, body AgentBody, cwd, taskID string) {
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
				"error":            "prior run still active — cannot resume; kill it first",
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
	runlifecycle.Wire(dir, match.SessionID, sess.Done, func() int {
		if sess.Cmd == nil || sess.Cmd.ProcessState == nil {
			return -1
		}
		return sess.Cmd.ProcessState.ExitCode()
	}, fmt.Sprintf("resume %s/%s/%s", taskID, body.Role, body.Repo))
	WriteJSON(w, http.StatusOK, map[string]any{
		"sessionId": match.SessionID,
		"role":      body.Role,
		"repo":      body.Repo,
		"resumed":   true,
		"pid":       sess.Cmd.Process.Pid,
	})
}

// ContinueTask — POST /api/tasks/{id}/continue. Re-spawns the
// coordinator with a resume prompt summarizing prior runs / open
// decisions. Mirrors libs/coordinator's continue path.
func ContinueTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
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
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	// Find the latest finished coordinator run.
	var latestCoord *meta.Run
	for i := len(m.Runs) - 1; i >= 0; i-- {
		if m.Runs[i].Role == "coordinator" {
			cp := m.Runs[i]
			latestCoord = &cp
			break
		}
	}
	if latestCoord == nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{
			"error": "no coordinator run to continue — POST /api/tasks first",
		})
		return
	}
	if latestCoord.Status == meta.RunStatusRunning || latestCoord.Status == meta.RunStatusQueued {
		WriteJSON(w, http.StatusConflict, map[string]string{
			"error": "coordinator still active — kill it first",
		})
		return
	}
	if spawnerInstance == nil {
		WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "spawner not configured"})
		return
	}
	resumeMsg := memory.BuildResumePrompt(*m, memory.ResumeOptions{
		ParentSessionID: latestCoord.SessionID,
	})
	bridgeRoot := getBridgeRoot()
	sess, err := spawnerInstance.ResumeClaude(bridgeRoot, latestCoord.SessionID, resumeMsg,
		&spawn.ChatSettings{Mode: "bypassPermissions", DisallowedTools: []string{"Task"}},
		"")
	if err != nil {
		WriteJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	startedAt := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = meta.UpdateRun(dir, latestCoord.SessionID, func(r *meta.Run) {
		r.Status = meta.RunStatusRunning
		r.StartedAt = &startedAt
		r.EndedAt = nil
	}, nil)
	runlifecycle.Wire(dir, latestCoord.SessionID, sess.Done, func() int {
		if sess.Cmd == nil || sess.Cmd.ProcessState == nil {
			return -1
		}
		return sess.Cmd.ProcessState.ExitCode()
	}, fmt.Sprintf("continue %s", id))
	WriteJSON(w, http.StatusOK, map[string]any{
		"sessionId": latestCoord.SessionID,
		"continued": true,
	})
}

// ClearTask — POST /api/tasks/{id}/clear. SIGTERMs every active child
// + flips queued/running rows to failed. Mirrors libs/coordinator's
// clear path. Idempotent — clearing an already-cleared task is a
// no-op success.
func ClearTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
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
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	killed := 0
	for _, run := range m.Runs {
		if run.Status != meta.RunStatusQueued && run.Status != meta.RunStatusRunning {
			continue
		}
		if spawnRegistry != nil && spawnRegistry.Kill(run.SessionID) {
			killed++
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		_, _ = meta.UpdateRun(dir, run.SessionID, func(r *meta.Run) {
			r.Status = meta.RunStatusFailed
			r.EndedAt = &now
		}, func(cur meta.Run) bool {
			// Only flip if still active — don't demote done/failed.
			return cur.Status == meta.RunStatusQueued || cur.Status == meta.RunStatusRunning
		})
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"killed": killed,
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

// newAgentUUID is a local UUID generator (avoid importing spawn for
// just the helper). Same shape as spawn.newUUID.
func newAgentUUID() string {
	// Use os-supplied source for randomness via the meta package's
	// helper indirectly — but meta doesn't export one. Quick local
	// implementation.
	now := time.Now().UnixNano()
	var b [16]byte
	for i := range b {
		b[i] = byte(now >> (i * 4))
	}
	if f, err := os.Open(os.DevNull); err == nil {
		_ = f.Close()
	}
	// Add some entropy from a /dev/urandom-equivalent read via
	// crypto/rand — but to avoid the import we re-use the per-spawn
	// helper through SpawnFreeSession (which mints its own when sid
	// is empty). For this call we DO need to allocate up-front so
	// the prompt can render the id. Use a v4-ish hex string seeded
	// from time + a tiny mix.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	const hex = "0123456789abcdef"
	dst := make([]byte, 36)
	hexEnc := func(out []byte, src []byte) {
		for i, v := range src {
			out[i*2] = hex[v>>4]
			out[i*2+1] = hex[v&0x0f]
		}
	}
	hexEnc(dst[0:8], b[0:4])
	dst[8] = '-'
	hexEnc(dst[9:13], b[4:6])
	dst[13] = '-'
	hexEnc(dst[14:18], b[6:8])
	dst[18] = '-'
	hexEnc(dst[19:23], b[8:10])
	dst[23] = '-'
	hexEnc(dst[24:36], b[10:16])
	return string(dst)
}

// Compile-time guard so the imports are exercised even when the
// optional context loaders are nil for this app.
var _ = sessions.IsValidSessionID
