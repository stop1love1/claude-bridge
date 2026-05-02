package api

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/repos"
	"github.com/stop1love1/claude-bridge/internal/slash"
)

// ListRepos — GET /api/repos. Returns the resolved repo list (each
// app entry mapped to its absolute path). Mirrors libs/repos.ts
// resolveRepos.
func ListRepos(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{"repos": repos.ResolveRepos()})
}

// GetRepo — GET /api/repos/{name}. Returns the resolved entry by name.
// Uses the same name→cwd resolution rules as the spawn path so
// callers see the same resolution result.
func GetRepo(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if name == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "name required"})
		return
	}
	cwd, ok := repos.ResolveCwd(getBridgeRoot(), name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, repos.Resolved{Name: name, Path: cwd})
}

// slashItemDTO mirrors the Next handler's SlashCommandsItemDto shape.
// Description is *string so JSON-null surfaces for commands without a
// description (matching `description: string | null` in the TS type).
type slashItemDTO struct {
	Slug        string  `json:"slug"`
	Description *string `json:"description"`
	Source      string  `json:"source"`
}

// ListRepoSlashCommands — GET /api/repos/{name}/slash-commands.
// Returns the merged slash command set: project (per-app
// `.claude/commands/`) overrides user (`~/.claude/commands/`)
// overrides builtin. Same precedence as the claude CLI.
//
// S18 + S16/S17 unblock this — slash discovery + apps name validation
// + repos resolver are all available.
func ListRepoSlashCommands(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid app name"})
		return
	}
	cwd, ok := repos.ResolveCwd(getBridgeRoot(), name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "unknown repo"})
		return
	}

	// Per-source discovery: project (under cwd/.claude/commands), user
	// (under ~/.claude/commands), then builtins. Errors fall back to
	// empty so a missing dir doesn't 500 the response.
	project := slash.Discover([]string{filepath.Join(cwd, ".claude", "commands")})
	var user []slash.Command
	if home, err := os.UserHomeDir(); err == nil {
		user = slash.Discover([]string{filepath.Join(home, ".claude", "commands")})
	}
	builtins := slash.Builtins()

	// Merge: project > user > builtin per slug. Walk in
	// builtin → user → project order so the later layer overwrites.
	merged := make(map[string]slashItemDTO, len(builtins)+len(user)+len(project))
	mergeIn := func(cmds []slash.Command, source string) {
		for _, c := range cmds {
			prev := merged[c.Name]
			desc := prev.Description
			if c.Description != "" {
				d := c.Description
				desc = &d
			}
			merged[c.Name] = slashItemDTO{Slug: c.Name, Description: desc, Source: source}
		}
	}
	mergeIn(builtins, "builtin")
	mergeIn(user, "user")
	mergeIn(project, "project")

	items := make([]slashItemDTO, 0, len(merged))
	for _, v := range merged {
		items = append(items, v)
	}
	WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}
