package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/sessions"
	"github.com/stop1love1/claude-bridge/internal/upload"
)

// uploadConfig holds the bridge's `.uploads/` root. Defaults to
// `<sessionsDir>/../.uploads` when unset; tests override via
// SetUploadDir for isolation.
var (
	uploadDirMu sync.RWMutex
	uploadDir   string
)

// SetUploadDir overrides the .uploads root. Production calls set
// this to BRIDGE_ROOT/.uploads from cmd/bridge serve; tests use a
// fixture-local dir.
func SetUploadDir(dir string) {
	uploadDirMu.Lock()
	defer uploadDirMu.Unlock()
	uploadDir = dir
}

func getUploadDir() string {
	uploadDirMu.RLock()
	defer uploadDirMu.RUnlock()
	if uploadDir != "" {
		return uploadDir
	}
	// Fall back to <sessionsDir>/../.uploads — keeps the storage
	// adjacent to per-task meta on the disk layout the operator already
	// expects.
	c := currentConfig()
	return filepath.Join(filepath.Dir(c.SessionsDir), ".uploads")
}

// SessionUpload — POST /api/sessions/{sessionId}/upload. Stages a
// multipart-uploaded file at <uploadDir>/<sessionId>/<safeName>. Refuses
// blocked extensions, reserved Windows device names, and oversized bodies.
//
// Mirrors app/api/sessions/[sessionId]/upload/route.ts: header-Content-
// Length pre-check + post-parse size cap + name validation +
// containment assertion.
func SessionUpload(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}

	// Pre-check: short-circuit oversized requests on the header alone
	// so we never allocate the buffer for the multi-GB body case. 64 KB
	// slack covers multipart boundary lines + per-part headers.
	if cl := r.Header.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(cl, 10, 64); err == nil && n > upload.MaxBytes+64*1024 {
			WriteJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
				"error": fmt.Sprintf("file too large (max %d bytes)", upload.MaxBytes),
			})
			return
		}
	}

	// Cap the parser too — ParseMultipartForm uses memBytes for in-
	// memory parts, spills to temp files for the rest. We pass MaxBytes
	// + slack so the temp-file spill kicks in at our hard cap.
	if err := r.ParseMultipartForm(upload.MaxBytes + 64*1024); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid multipart body"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "file required"})
		return
	}
	defer func() { _ = file.Close() }()
	if header.Size > upload.MaxBytes {
		WriteJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
			"error": fmt.Sprintf("file too large (max %d bytes)", upload.MaxBytes),
		})
		return
	}

	rawName := header.Filename
	if rawName == "" {
		rawName = "upload.bin"
	}
	guard := upload.ValidateName(rawName)
	if !guard.OK {
		switch guard.Reason {
		case upload.ReasonEmptyName:
			WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "file name required"})
		case upload.ReasonBlockedExt:
			WriteJSON(w, http.StatusUnsupportedMediaType, map[string]string{
				"error": "extension not allowed: " + guard.Detail,
			})
		case upload.ReasonReservedName:
			WriteJSON(w, http.StatusBadRequest, map[string]string{
				"error": "reserved device name: " + guard.Detail,
			})
		default:
			WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid file name"})
		}
		return
	}

	dir := filepath.Join(getUploadDir(), sid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	filePath := filepath.Join(dir, guard.Sanitized)
	if !upload.AssertInsideUploadDir(dir, filePath) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid file name"})
		return
	}

	dst, err := os.Create(filePath)
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer func() { _ = dst.Close() }()
	written, err := io.Copy(dst, io.LimitReader(file, upload.MaxBytes+1))
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if written > upload.MaxBytes {
		_ = os.Remove(filePath)
		WriteJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
			"error": fmt.Sprintf("file too large (max %d bytes)", upload.MaxBytes),
		})
		return
	}

	mime := header.Header.Get("Content-Type")
	WriteJSON(w, http.StatusOK, map[string]any{
		"path": filePath,
		"name": guard.Sanitized,
		"size": written,
		"url":  "/api/uploads/" + sid + "/" + url.PathEscape(guard.Sanitized),
		"mime": nullableString(mime),
	})
}

// nullableString helps the API echo Content-Type as JSON null when
// the multipart part didn't carry one — matches the Next handler's
// `file.type || null` pattern bytewise.
func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// GetUpload — GET /api/uploads/{sid}/{name}. Streams the staged file
// back to the browser so the chat log can render previews. Validates
// the name + containment again before opening the file (defense in
// depth — the URL came from the client).
func GetUpload(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sid")
	name := chi.URLParam(r, "name")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	guard := upload.ValidateName(name)
	if !guard.OK {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	dir := filepath.Join(getUploadDir(), sid)
	path := filepath.Join(dir, guard.Sanitized)
	if !upload.AssertInsideUploadDir(dir, path) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer func() { _ = f.Close() }()
	st, _ := f.Stat()
	if st != nil {
		w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	}
	// Let the browser sniff content-type — we don't store the original
	// MIME with the file. That's the same behavior Next has via
	// next/server's static serving fallback.
	_, _ = io.Copy(w, f)
}
