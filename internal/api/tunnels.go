package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/tunnels"
)

// ListTunnels — GET /api/tunnels. Returns the registry snapshot.
func ListTunnels(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"tunnels": tunnels.Default.List(),
	})
}

// CreateTunnelBody is the POST /api/tunnels request shape.
type CreateTunnelBody struct {
	Port      int              `json:"port"`
	Provider  tunnels.Provider `json:"provider"`
	Label     string           `json:"label,omitempty"`
	Subdomain string           `json:"subdomain,omitempty"`
}

// CreateTunnel — POST /api/tunnels. Spawns the provider CLI; entry
// starts in `starting` state and flips to `running` once URL extraction
// succeeds (deferred — see tunnels.Start).
func CreateTunnel(w http.ResponseWriter, r *http.Request) {
	defer func() { _ = r.Body.Close() }()
	var body CreateTunnelBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if body.Provider == "" {
		body.Provider = tunnels.ProviderLocaltunnel
	}
	entry, err := tunnels.Default.Start(tunnels.StartOptions{
		Port:      body.Port,
		Provider:  body.Provider,
		Label:     body.Label,
		Subdomain: body.Subdomain,
	})
	if err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusCreated, map[string]any{"tunnel": entry})
}

// StopTunnel — DELETE /api/tunnels/{id}. Terminates the child + drops
// the registry entry.
func StopTunnel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !tunnels.Default.Stop(id) {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	tunnels.Default.Remove(id)
	WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ListTunnelProviders — GET /api/tunnels/providers. Reports per-
// provider install state so the UI can disable buttons for missing
// CLIs.
func ListTunnelProviders(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"providers": tunnels.DetectProviders(),
	})
}

// InstallNgrok — POST /api/tunnels/providers/ngrok/install. Downloads
// the ngrok binary into the bridge's cache dir.
func InstallNgrok(w http.ResponseWriter, _ *http.Request) {
	res, err := tunnels.InstallNgrok()
	status := http.StatusOK
	if err != nil || !res.OK {
		status = http.StatusServiceUnavailable
	}
	WriteJSON(w, status, res)
}

// SetNgrokAuthtokenBody is the POST /api/tunnels/providers/ngrok/
// authtoken request shape.
type SetNgrokAuthtokenBody struct {
	Token string `json:"token"`
}

// SetNgrokAuthtoken — POST /api/tunnels/providers/ngrok/authtoken.
// Persists the token; returns the stored value (echoed for UI confirm).
func SetNgrokAuthtoken(w http.ResponseWriter, r *http.Request) {
	defer func() { _ = r.Body.Close() }()
	var body SetNgrokAuthtokenBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	stored := tunnels.DefaultAuthtokenStore.Set(body.Token)
	WriteJSON(w, http.StatusOK, map[string]string{"token": stored})
}

// GetNgrokAuthtoken — GET /api/tunnels/providers/ngrok/authtoken.
// Echoes the stored token (UI uses this to render the existing value
// when the form opens).
func GetNgrokAuthtoken(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]string{
		"token": tunnels.DefaultAuthtokenStore.Get(),
	})
}
