// Package coordinator orchestrates the per-task coordinator-claude
// spawn: pre-allocates the session UUID, renders the coordinator
// prompt template with bridge / task / detected-scope substitutions,
// pre-registers the run as queued, spawns claude in the bridge root,
// promotes queued → running, and wires the run lifecycle so the run
// flips to done/failed on exit.
//
// Ported from libs/coordinator.ts in the post-S20 batch. The
// post-exit gate cascade (verify chain, inline verifier, style
// critic, semantic verifier, retry decisions, speculative dispatch
// winner selection, memory distill) is NOT in scope here — that's
// the runLifecycle module's territory and lands when those packages
// port.
package coordinator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/detect"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/runlifecycle"
	"github.com/stop1love1/claude-bridge/internal/spawn"
)

// Spawner is the spawn.Spawner the coordinator uses to launch claude.
// Wired by cmd/bridge serve so the coordinator's children share the
// same registry the kill endpoint queries.
type Spawner interface {
	SpawnClaude(cwd string, opts spawn.SpawnOpts) (*spawn.SpawnedSession, error)
}

// Config holds the bridge paths + the spawner the coordinator needs.
// Wired once at startup by cmd/bridge serve via SetDefault.
type Config struct {
	BridgeRoot    string
	BridgeURL     string
	SessionsDir   string
	BridgeFolder  string
	BridgeLogicDir string
	Spawner       Spawner
	// Detector runs the heuristic to populate the `## Detected scope`
	// block. Optional — when nil, the scope block is omitted with a
	// fallback message and the spawn proceeds.
	Detector *detect.Detector
}

var (
	defaults *Config
)

// SetDefault installs the package-global config. Idempotent.
func SetDefault(c *Config) { defaults = c }

// GetDefault returns the package-global config. Returns nil when not
// initialized — callers must check before invoking SpawnForTask.
func GetDefault() *Config { return defaults }

// SpawnForTask spawns the coordinator session for a freshly-created
// task. Returns the new session ID on success, "" + error on failure.
//
// Mirrors libs/coordinator.ts spawnCoordinatorForTask exactly:
//   1. meta.json must exist (CreateTask should have done that).
//   2. Pre-allocate session UUID so the prompt can render it.
//   3. Read the coordinator template + substitute structural placeholders.
//   4. Build + splice the `## Detected scope` block.
//   5. Substitute USER content (defanged via SanitizeUserPromptContent)
//      LAST so a hostile body can't relocate the splice marker or
//      leak {{SESSION_ID}} into the rendered template.
//   6. AppendRun as queued BEFORE the spawn (so a spawn failure leaves
//      a tracked failed row, not a silent gap).
//   7. SpawnClaude in BridgeRoot with mode=bypassPermissions +
//      disallowedTools=["Task"] (Claude Code's in-process subagent
//      tool — blocking it at the CLI level is the cwd-isolation
//      contract).
//   8. Promote queued → running. Wire the lifecycle hook so the run
//      flips to done/failed on exit.
func SpawnForTask(ctx context.Context, cfg *Config, task TaskInput) (string, error) {
	if cfg == nil {
		return "", errors.New("coordinator: no config installed (cmd/bridge serve must call SetDefault)")
	}
	if cfg.Spawner == nil {
		return "", errors.New("coordinator: no spawner installed")
	}
	sessionsDir := filepath.Join(cfg.SessionsDir, task.ID)

	// Sanity: meta.json must exist before we spawn. CreateTask is the
	// only legitimate caller path so this should never trip — but if
	// upstream ever forgets, we'd otherwise spawn an orphan
	// coordinator that can't self-register.
	m, err := meta.ReadMeta(sessionsDir)
	if err != nil {
		return "", fmt.Errorf("coordinator: read meta: %w", err)
	}
	if m == nil {
		return "", fmt.Errorf("coordinator: meta.json missing at %s", sessionsDir)
	}

	sessionID := newUUID()

	// Read the coordinator template. Falls back to a minimal hard-
	// coded prompt when the template file is absent — keeps fresh
	// checkouts working until the operator copies the prompts dir.
	template := readCoordinatorTemplate(cfg.BridgeLogicDir)

	// Pick the example-repo name for curl snippets. Defaults to the
	// bridge folder; first registered app wins if any.
	exampleRepo := cfg.BridgeFolder
	if list, _ := apps.GetDefault().LoadApps(); len(list) > 0 {
		for _, a := range list {
			if a.ResolvedPath() != "" {
				if _, err := os.Stat(a.ResolvedPath()); err == nil {
					exampleRepo = a.Name
					break
				}
			}
		}
	}

	// Sanitize user content BEFORE substituting structural placeholders.
	safeTitle := sanitizeUserContent(task.Title)
	safeBody := sanitizeUserContent(task.Body)

	// Order matters: structural placeholders → splice scope → user
	// content. See the TS source for the rationale (a body containing
	// `{{SESSION_ID}}` must not leak the real uuid; a body containing
	// `## Your job` must not relocate the splice).
	rendered := template
	rendered = strings.ReplaceAll(rendered, "{{SESSION_ID}}", sessionID)
	rendered = strings.ReplaceAll(rendered, "{{BRIDGE_URL}}", cfg.BridgeURL)
	rendered = strings.ReplaceAll(rendered, "{{BRIDGE_FOLDER}}", cfg.BridgeFolder)
	rendered = strings.ReplaceAll(rendered, "{{EXAMPLE_REPO}}", exampleRepo)
	rendered = strings.ReplaceAll(rendered, "{{TASK_ID}}", task.ID)

	scopeBlock := buildDetectedScopeBlock(cfg, sessionsDir, task)
	rendered = spliceScopeBlock(rendered, scopeBlock)

	rendered = strings.ReplaceAll(rendered, "{{TASK_TITLE}}", safeTitle)
	rendered = strings.ReplaceAll(rendered, "{{TASK_BODY}}", safeBody)

	// AppendRun BEFORE spawn — H4 orphan-window fix. If SpawnClaude
	// throws (claude binary missing, fork EAGAIN, etc.) we still
	// have a tracked queued row that the reaper / next read flips to
	// failed.
	repoName := filepath.Base(cfg.BridgeRoot)
	startedAt := time.Now().UTC().Format(time.RFC3339Nano)
	if err := meta.AppendRun(sessionsDir, meta.Run{
		SessionID: sessionID,
		Role:      "coordinator",
		Repo:      repoName,
		Status:    meta.RunStatusQueued,
		StartedAt: nil,
		EndedAt:   nil,
	}); err != nil {
		return "", fmt.Errorf("coordinator: appendRun queued: %w", err)
	}

	sess, err := cfg.Spawner.SpawnClaude(cfg.BridgeRoot, spawn.SpawnOpts{
		Role:      "coordinator",
		TaskID:    task.ID,
		Prompt:    rendered,
		SessionID: sessionID,
		// Coordinator runs unattended — there's no TTY for permission
		// prompts. disallowedTools blocks Claude Code's in-process
		// Task tool (cwd-isolation contract: subagents must be
		// dispatched via /api/tasks/<id>/agents which spawns a real
		// child claude with cwd = the app's path, not the bridge's).
		Settings: &spawn.ChatSettings{
			Mode:            "bypassPermissions",
			DisallowedTools: []string{"Task"},
		},
	})
	if err != nil {
		// Mark the run failed so the operator sees the error rather
		// than a stuck queued row.
		_, _ = meta.UpdateRun(sessionsDir, sessionID, func(r *meta.Run) {
			r.Status = meta.RunStatusFailed
			now := time.Now().UTC().Format(time.RFC3339Nano)
			r.EndedAt = &now
		}, nil)
		return "", fmt.Errorf("coordinator: spawn: %w", err)
	}

	// Promote queued → running with a real startedAt. Belt-and-
	// suspenders: if the coordinator finishes cleanly but forgets to
	// PATCH itself to "done" via /link, the lifecycle hook flips it.
	startedAtCopy := startedAt
	_, _ = meta.UpdateRun(sessionsDir, sessionID, func(r *meta.Run) {
		r.Status = meta.RunStatusRunning
		r.StartedAt = &startedAtCopy
	}, nil)

	// Wire the lifecycle hook — exit triggers the meta status flip.
	runlifecycle.Wire(sessionsDir, sessionID, sess.Done, func() int {
		if sess.Cmd == nil || sess.Cmd.ProcessState == nil {
			return -1
		}
		return sess.Cmd.ProcessState.ExitCode()
	}, fmt.Sprintf("coordinator %s", task.ID))

	_ = ctx // reserved for future cancellation plumbing
	return sessionID, nil
}

// TaskInput is the per-task payload SpawnForTask consumes. Mirrors
// the subset of the Task struct the TS coordinator reads.
type TaskInput struct {
	ID    string
	Title string
	Body  string
	App   string
}

// buildDetectedScopeBlock renders the `## Detected scope` block via
// the detect package. On any failure (detect crashed, no detector
// configured) returns the canonical fallback block so the coordinator
// is never starved of context.
func buildDetectedScopeBlock(cfg *Config, sessionsDir string, task TaskInput) string {
	if cfg.Detector == nil {
		return scopeFallback("detect package not initialized — coordinator falls back to BRIDGE.md + task body")
	}
	scope, err := cfg.Detector.GetOrCompute(sessionsDir, func() detect.DetectInput {
		return detect.LoadInput(detect.InputOptions{
			TaskBody:   task.Body,
			TaskTitle:  task.Title,
			PinnedRepo: task.App,
		})
	})
	if err != nil {
		log.Printf("coordinator: detect failed: %v", err)
		return scopeFallback("detect crashed — see bridge logs")
	}
	profileSlice := apps.LoadProfiles(cfg.BridgeRoot)
	profiles := make(map[string]apps.RepoProfile, len(profileSlice))
	for _, p := range profileSlice {
		profiles[p.Name] = p
	}
	return detect.Render(scope, detect.RenderOptions{
		ForCoordinator: true,
		Profiles:       profiles,
	})
}

func scopeFallback(reason string) string {
	return strings.Join([]string{
		"## Detected scope",
		"",
		"_(" + reason + ")_",
		"",
	}, "\n")
}

// spliceScopeBlock injects block before the coordinator template's
// `## Your job` heading. Falls back to prepending when the marker is
// missing (template shape changed).
func spliceScopeBlock(rendered, block string) string {
	const marker = "## Your job"
	idx := strings.Index(rendered, marker)
	if idx == -1 {
		return block + "\n" + rendered
	}
	return rendered[:idx] + block + "\n" + rendered[idx:]
}

// sanitizeUserContent defangs structural markers in user-supplied
// task content. Mirrors libs/childPrompt.ts sanitizeUserPromptContent
// exactly — fullwidth braces for `{{` `}}` template placeholders, ZWSP
// after the heading hashes for `## Your job` so the splice's
// strings.Index can't be redirected by user content.
func sanitizeUserContent(s string) string {
	if s == "" {
		return ""
	}
	out := s
	out = strings.ReplaceAll(out, "{{", "｛｛")
	out = strings.ReplaceAll(out, "}}", "｝｝")
	out = yourJobRE.ReplaceAllString(out, "$1​$2")
	return out
}

// readCoordinatorTemplate reads <BridgeLogicDir>/coordinator.md, or
// returns the bundled fallback when the file is missing. The fallback
// is intentionally terse — operators are expected to copy the prompts
// dir from the bridge repo into their bridge root for production use.
func readCoordinatorTemplate(bridgeLogicDir string) string {
	if bridgeLogicDir == "" {
		return defaultCoordinatorTemplate
	}
	body, err := os.ReadFile(filepath.Join(bridgeLogicDir, "coordinator.md"))
	if err != nil {
		return defaultCoordinatorTemplate
	}
	return string(body)
}

// defaultCoordinatorTemplate is the fallback prompt when the operator
// hasn't placed coordinator.md in the bridge logic dir. Intentionally
// minimal — dispatches to the user's task body and points at the
// canonical /api/tasks/<id>/link endpoint for self-registration.
const defaultCoordinatorTemplate = `You are the bridge coordinator for task {{TASK_ID}}. Your session id is {{SESSION_ID}}.

Self-register your run via:

` + "```bash\n" +
	`curl -s -X POST {{BRIDGE_URL}}/api/tasks/{{TASK_ID}}/link \
  -H "content-type: application/json" \
  -H "x-bridge-internal-token: $BRIDGE_INTERNAL_TOKEN" \
  -d '{"sessionId":"{{SESSION_ID}}","role":"coordinator","repo":"{{BRIDGE_FOLDER}}","status":"running"}'
` + "```\n" + `

## Your job

Task title: {{TASK_TITLE}}

Task body:

` + "```\n{{TASK_BODY}}\n```" + `

Coordinate the work across the registered apps (see /api/repos for the live list). For each unit of work, dispatch via POST {{BRIDGE_URL}}/api/tasks/{{TASK_ID}}/agents with {role, repo, prompt}. Example repo: {{EXAMPLE_REPO}}.

When all child agents have reported, write sessions/{{TASK_ID}}/summary.md with the top-line "READY FOR REVIEW" status, then exit. The user ticks the task done in the UI.
`

// newUUID returns a v4 UUID. Local copy of the spawn package's helper
// so this package doesn't have to import spawn just for the helper.
func newUUID() string {
	var b [16]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
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
