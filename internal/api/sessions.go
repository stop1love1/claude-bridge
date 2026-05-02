package api

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/stop1love1/claude-bridge/internal/git"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/repos"
	"github.com/stop1love1/claude-bridge/internal/sessions"
)

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

// ListAllSessions walks every registered repo's project dir under
// ~/.claude/projects/<slug>/ + every orphan project folder not
// covered by an explicit registration, joins each session with the
// task-meta link table (sessionId → taskId/role) and the per-repo
// git branch.
//
// Upgraded in S17 from the empty-array stub. Full deps available now:
// meta (task lookup), git (branch read), repos (name → cwd), sessions
// (listSessions / discoverOrphanProjects).
func ListAllSessions(w http.ResponseWriter, _ *http.Request) {
	c := currentConfig()
	bridgeRoot := getBridgeRoot()
	reader := sessionsReaderFor(c)

	links, taskTitles := buildLinkIndex(c.SessionsDir)

	// Build the candidate repo list: bridge folder + every registered app.
	type repoCandidate struct {
		Name     string
		Path     string
		IsBridge bool
	}
	seen := make(map[string]struct{})
	seenProjectDirs := make(map[string]struct{})
	candidates := make([]repoCandidate, 0, 8)
	add := func(name, path string, isBridge bool) {
		if _, ok := seen[path]; ok {
			return
		}
		seen[path] = struct{}{}
		seenProjectDirs[reader.ProjectDirFor(path)] = struct{}{}
		candidates = append(candidates, repoCandidate{Name: name, Path: path, IsBridge: isBridge})
	}
	add(filepath.Base(bridgeRoot), bridgeRoot, true)
	for _, r := range repos.ResolveRepos() {
		add(r.Name, r.Path, false)
	}

	// Orphan projects — folders under ~/.claude/projects/ that aren't
	// covered by the registry. Recovered cwd surfaces them in the UI.
	for _, orphan := range reader.DiscoverOrphanProjects(seenProjectDirs) {
		if _, ok := seen[orphan.Path]; ok {
			continue
		}
		seen[orphan.Path] = struct{}{}
		candidates = append(candidates, repoCandidate{Name: orphan.Name, Path: orphan.Path, IsBridge: false})
	}

	// Cache git branch reads — multiple sessions in the same repo only
	// need one .git/HEAD parse.
	branchCache := make(map[string]*string)
	branchOf := func(path string) *string {
		if b, ok := branchCache[path]; ok {
			return b
		}
		var out *string
		if br, ok := git.ReadBranch(path); ok {
			b := br
			out = &b
		}
		branchCache[path] = out
		return out
	}

	out := make([]SessionRow, 0, 32)
	for _, cand := range candidates {
		projectDir := reader.ProjectDirFor(cand.Path)
		for _, s := range sessions.ListSessions(projectDir) {
			var link *SessionLink
			if l, ok := links[s.SessionID]; ok {
				link = &SessionLink{TaskID: l.TaskID, Role: l.Role}
			}
			// For sessions linked to a task, prefer the task title (in
			// the operator's language) over the .jsonl preview (which
			// is the system prompt's first line — always English).
			preview := s.Preview
			if link != nil {
				if title := taskTitles[link.TaskID]; title != "" {
					preview = title
				}
			}
			out = append(out, SessionRow{
				SessionID: s.SessionID,
				Repo:      cand.Name,
				RepoPath:  cand.Path,
				Branch:    branchOf(cand.Path),
				IsBridge:  cand.IsBridge,
				Mtime:     s.Mtime,
				Size:      s.Size,
				Preview:   preview,
				Link:      link,
			})
		}
	}

	// Newest-first by mtime.
	sortSessionRowsByMtimeDesc(out)
	WriteJSON(w, http.StatusOK, out)
}

// buildLinkIndex returns sessionId → {taskId, role} for the first map
// and taskId → taskTitle for the second. Used by ListAllSessions to
// override session previews with the task title for linked sessions.
func buildLinkIndex(sessionsDir string) (map[string]linkInfo, map[string]string) {
	links := make(map[string]linkInfo)
	titles := make(map[string]string)
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return links, titles
	}
	for _, ent := range entries {
		if !ent.IsDir() {
			continue
		}
		dir := filepath.Join(sessionsDir, ent.Name())
		m, err := meta.ReadMeta(dir)
		if err != nil || m == nil {
			continue
		}
		if m.TaskTitle != "" {
			titles[m.TaskID] = m.TaskTitle
		}
		for _, run := range m.Runs {
			links[run.SessionID] = linkInfo{TaskID: m.TaskID, Role: run.Role}
		}
	}
	return links, titles
}

type linkInfo struct {
	TaskID string
	Role   string
}

// sessionsReaderFor builds a sessions.Reader honoring c.ProjectsRoot
// (so contract-test fixtures see only the dirs they seeded). Empty
// ProjectsRoot falls back to the production default.
func sessionsReaderFor(c *Config) *sessions.Reader {
	if c != nil && c.ProjectsRoot != "" {
		return &sessions.Reader{Root: c.ProjectsRoot}
	}
	return sessions.New()
}

func sortSessionRowsByMtimeDesc(rows []SessionRow) {
	for i := 1; i < len(rows); i++ {
		j := i
		for j > 0 && rows[j].Mtime > rows[j-1].Mtime {
			rows[j], rows[j-1] = rows[j-1], rows[j]
			j--
		}
	}
}
