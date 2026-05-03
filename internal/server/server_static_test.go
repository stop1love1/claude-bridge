package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/rs/zerolog"

	webdist "github.com/stop1love1/claude-bridge/internal/web"
)

// fakeBundle returns a tiny in-memory SPA bundle so the SPA fallback
// tests don't depend on `make embed-web` having run. The marker string
// in index.html lets tests assert "yes, this is the SPA shell" without
// pinning specific HTML.
func fakeBundle() fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{
			Data: []byte(`<!doctype html><html><body data-app="bridge-spa-shell"></body></html>`),
		},
		"assets/main-abc123.js": &fstest.MapFile{
			Data: []byte(`console.log("bridge-spa-bundle");`),
		},
	}
}

func TestSPAFallbackServesIndexHTML(t *testing.T) {
	h := webdist.SPAHandler(fakeBundle())
	req := httptest.NewRequest(http.MethodGet, "/tasks/abc", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	body, _ := io.ReadAll(rr.Body)
	if !strings.Contains(string(body), "bridge-spa-shell") {
		t.Fatalf("expected SPA shell marker, got %q", body)
	}
	if got := rr.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Fatalf("content-type: got %q want text/html…", got)
	}
}

// TestSPAHandler_APIPath404 — the SPA handler must NOT swallow /api/*
// paths. Mounted as the catch-all in NewHandler, anything reaching it
// with /api/ prefix means no real route matched and the right answer
// is 404, not the SPA shell.
func TestSPAHandler_APIPath404(t *testing.T) {
	h := webdist.SPAHandler(fakeBundle())
	req := httptest.NewRequest(http.MethodGet, "/api/does-not-exist", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status: got %d want 404", rr.Code)
	}
}

// TestSPAHandler_RealAssetServed — hashed JS bundles resolve to real
// files in the FS and should be served as-is (not replaced by
// index.html).
func TestSPAHandler_RealAssetServed(t *testing.T) {
	h := webdist.SPAHandler(fakeBundle())
	req := httptest.NewRequest(http.MethodGet, "/assets/main-abc123.js", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", rr.Code)
	}
	body, _ := io.ReadAll(rr.Body)
	if !strings.Contains(string(body), "bridge-spa-bundle") {
		t.Fatalf("expected JS bundle body, got %q", body)
	}
}

// TestSPADoesNotIntercept_API — at the full-router level, /api/health
// must still go through the real health handler (200) and /api/tasks
// without a token must still 401 from the auth middleware. Both prove
// the SPA catch-all is mounted last and doesn't swallow /api/*.
func TestSPADoesNotIntercept_API(t *testing.T) {
	cfg := Config{
		Version:       "test",
		Logger:        zerolog.Nop(),
		InternalToken: "token-of-some-length-12345",
	}
	h := NewHandler(cfg)

	t.Run("health public", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("/api/health: got %d want 200 (body=%s)", rr.Code, rr.Body.String())
		}
	})

	t.Run("tasks gated", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("/api/tasks no token: got %d want 401", rr.Code)
		}
	})
}

// TestStaticAssetServedWithoutToken — the SPA static path must serve
// without the X-Bridge-Internal-Token header. We hit a path that's
// definitely NOT /api/* so it reaches the chi catch-all → SPA handler.
// On a fresh checkout the bundle is just .gitkeep, so we accept either
// 200 (real asset returned) or "missing index.html" 404 — the
// load-bearing assertion is that auth did NOT 401.
func TestStaticAssetServedWithoutToken(t *testing.T) {
	cfg := Config{
		Version:       "test",
		Logger:        zerolog.Nop(),
		InternalToken: "token-of-some-length-12345",
	}
	h := NewHandler(cfg)

	req := httptest.NewRequest(http.MethodGet, "/assets/whatever.js", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code == http.StatusUnauthorized {
		t.Fatalf("static asset hit auth gate: status=%d body=%s", rr.Code, rr.Body.String())
	}
}

// TestSPARootServedWithoutToken — GET / must reach the SPA handler
// without auth. Fresh-clone tolerance: accept any non-401 status (the
// bundle may be empty). The point is that bmw.AllowNonAPIPaths lets
// the request through.
func TestSPARootServedWithoutToken(t *testing.T) {
	cfg := Config{
		Version:       "test",
		Logger:        zerolog.Nop(),
		InternalToken: "token-of-some-length-12345",
	}
	h := NewHandler(cfg)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code == http.StatusUnauthorized {
		t.Fatalf("/ hit auth gate: status=%d body=%s", rr.Code, rr.Body.String())
	}
}
