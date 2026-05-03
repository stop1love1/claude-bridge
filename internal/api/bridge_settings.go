package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// bridgeSettings is the in-memory snapshot of <bridgeRoot>/bridge.json
// (or the equivalent fixture file). The Next handler reads/writes this
// file directly; we mirror that — there's no event bus to invalidate
// because the file is the only source of truth.
//
// Cmd/bridge serve points BridgeRoot at the operator's bridge dir on
// startup; tests inject a fixture path.
var (
	bridgeSettingsMu   sync.RWMutex
	bridgeSettingsRoot string
)

// SetBridgeRoot installs the bridge root path. Idempotent.
func SetBridgeRoot(root string) {
	bridgeSettingsMu.Lock()
	defer bridgeSettingsMu.Unlock()
	bridgeSettingsRoot = root
}

func getBridgeRoot() string {
	bridgeSettingsMu.RLock()
	defer bridgeSettingsMu.RUnlock()
	if bridgeSettingsRoot == "" {
		return "."
	}
	return bridgeSettingsRoot
}

func bridgeJSONPath() string {
	return filepath.Join(getBridgeRoot(), "bridge.json")
}

// GetBridgeSettings — GET /api/bridge/settings. Returns the contents
// of bridge.json verbatim, or {} when the file doesn't exist.
func GetBridgeSettings(w http.ResponseWriter, _ *http.Request) {
	body, err := os.ReadFile(bridgeJSONPath())
	if err != nil {
		if os.IsNotExist(err) {
			WriteJSON(w, http.StatusOK, map[string]any{})
			return
		}
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Preserve the byte shape on disk — re-marshaling through json
	// would lose key ordering. Set the right content type and copy
	// the bytes through directly.
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// PutBridgeSettings — PUT /api/bridge/settings. Replaces bridge.json
// with the request body. Validates that the body parses as JSON before
// writing to avoid leaving the file in an unparseable state.
//
// Atomic write isn't needed at this layer — the file is small and
// rewritten infrequently — but a future hardening pass could route
// through internal/meta.WriteStringAtomic.
func PutBridgeSettings(w http.ResponseWriter, r *http.Request) {
	defer func() { _ = r.Body.Close() }()
	body, err := readAllBody(w, r)
	if err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var probe any
	if err := json.Unmarshal(body, &probe); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	if err := os.MkdirAll(getBridgeRoot(), 0o755); err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := os.WriteFile(bridgeJSONPath(), body, 0o644); err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// readAllBody buffers the request body into a []byte. Capped at 1 MB
// to defend against an oversize PUT trying to OOM the bridge. Passing
// the ResponseWriter to MaxBytesReader lets net/http set the
// Connection: close header on the response when the limit is hit, so
// the client sees a clean 413 instead of a half-finished frame.
func readAllBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	const maxBody = 1 << 20
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for {
		n, err := r.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			// Use errors.Is + io.EOF rather than string-comparing the
			// error message: wrapped EOFs (some readers wrap with extra
			// context) would otherwise be misclassified as fatal.
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
	}
	return buf, nil
}
