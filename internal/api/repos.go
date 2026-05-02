package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/repos"
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
