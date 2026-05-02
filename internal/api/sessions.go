package api

import "net/http"

// SessionRow is one entry in the GET /api/sessions/all response. Mirrors
// the Next.js shape from app/api/sessions/all/route.ts so the bytewise
// contract test passes once the full implementation lands.
//
// All fields are JSON-tagged in lowerCamelCase to match Next.
type SessionRow struct {
	SessionID string       `json:"sessionId"`
	Repo      string       `json:"repo"`
	RepoPath  string       `json:"repoPath"`
	Branch    *string      `json:"branch"`
	IsBridge  bool         `json:"isBridge"`
	Mtime     int64        `json:"mtime"`
	Size      int64        `json:"size"`
	Preview   string       `json:"preview"`
	Link      *SessionLink `json:"link"`
}

// SessionLink is the (taskId, role) pair recorded in a task's meta.json
// when a session belongs to that task. Free / orphan chats have a nil
// Link.
type SessionLink struct {
	TaskID string `json:"taskId"`
	Role   string `json:"role"`
}

// ListAllSessions is the Go side of GET /api/sessions/all. The Next
// handler walks every known project folder, every sibling, and every
// orphan ~/.claude/projects/<slug>/ dir, joining sessions with
// task-meta links and per-repo git branches. That implementation
// depends on packages that don't exist yet (internal/meta, internal/git,
// internal/repos, internal/config); S05 ships this as a stub returning
// [] so the contract framework can prove byte-parity end to end against
// a freshly initialized fixture (no sessions on disk).
//
// Full implementation lands when the cross-package dependencies are
// available — the dependency graph in MIGRATION_SESSIONS.md threads
// this through S09 (meta), S15 (git), and S17 (repos).
func ListAllSessions(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, []SessionRow{})
}
