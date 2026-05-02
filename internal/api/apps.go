package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/apps"
)

// ListApps — GET /api/apps. Returns the registry snapshot. Errors
// are surfaced as 500; an empty registry returns `{ "apps": [] }`.
func ListApps(w http.ResponseWriter, _ *http.Request) {
	r := apps.GetDefault()
	list, err := r.LoadApps()
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []apps.App{}
	}
	WriteJSON(w, http.StatusOK, map[string]any{"apps": list})
}

// AddAppBody is the POST /api/apps request shape. Mirrors the TS
// handler — name + path required; description optional.
type AddAppBody struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Description string `json:"description,omitempty"`
}

// AddApp — POST /api/apps. Validates name + path, appends to the
// registry. Returns 409 on duplicate name.
func AddApp(w http.ResponseWriter, r *http.Request) {
	defer func() { _ = r.Body.Close() }()
	var body AddAppBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if !apps.IsValidAppName(body.Name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	if body.Path == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "path required"})
		return
	}
	app := apps.App{Name: body.Name, Path: body.Path, Description: body.Description}
	if err := apps.GetDefault().AddApp(app); err != nil {
		if err == apps.ErrDuplicateName {
			WriteJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusCreated, app)
}

// GetApp — GET /api/apps/{name}. Returns the named app.
func GetApp(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	a, ok := apps.GetDefault().FindByName(name)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, a)
}

// DeleteApp — DELETE /api/apps/{name}. Removes the named app.
// Returns 404 when missing.
func DeleteApp(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !apps.IsValidAppName(name) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	removed, err := apps.GetDefault().RemoveApp(name)
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !removed {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// AutoDetectApps — POST /api/apps/auto-detect. Stub for S16: the full
// scanApp.ts heuristic (walks sibling dirs, identifies frameworks via
// package.json / Cargo.toml / go.mod) ports later. For now we return
// an empty list with a deferred note so the UI's auto-detect dialog
// renders without 404.
func AutoDetectApps(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"candidates": []any{},
		"deferred":   "scanApp.ts heuristic ports later",
	})
}
