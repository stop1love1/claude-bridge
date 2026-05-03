// Package middleware holds cross-cutting HTTP middleware: cookie auth
// gate (with internal-token bypass for /api/tasks/<id>/link), token-
// bucket rate limiting, and the JSON error response shape that
// matches the existing Next handlers.
//
// Today only the auth gate (auth.go) is implemented. Rate limiting
// and the unified error shape will land in follow-up sessions.
package middleware

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"github.com/stop1love1/claude-bridge/internal/auth"
)

// AuthConfig controls how NewAuth gates incoming requests.
type AuthConfig struct {
	// InternalToken is the shared secret callers send via the
	// X-Bridge-Internal-Token header. Required — empty means auth is
	// effectively disabled (every non-bypass request will 401), which
	// matches the "fail closed" stance the bridge needs.
	InternalToken string

	// LocalhostOnly, when true, bypasses auth for requests whose
	// RemoteAddr is loopback (127.0.0.1 / ::1). Off by default; the
	// operator opts in via cmd/bridge --localhost-only when binding
	// the bridge to a trusted single-machine setup.
	LocalhostOnly bool

	// PublicPaths is the set of URL paths that bypass auth entirely
	// (health checks, static assets, login endpoints, etc.). Match is
	// "exact OR HasPrefix(path+'/')" so /api/health matches just that,
	// and "/static" matches /static/foo.js but not /staticky.
	PublicPaths []string

	// AllowNonAPIPaths, when true, bypasses auth for any request whose
	// path does NOT start with "/api/". This is the bypass used by the
	// SPA static handler: index.html, hashed JS bundles, fonts, the
	// favicon — none of those carry operator data, and the SPA itself
	// reads its bootstrap state from the (public) /api/health endpoint.
	// The data layer (/api/*) remains fully gated.
	//
	// Off by default. cmd/bridge flips it on after mounting the SPA
	// catch-all so chi's "/" route can serve without a token.
	AllowNonAPIPaths bool
}

// NewAuth returns a chi-compatible middleware that:
//   - lets OPTIONS preflight through unconditionally (CORS handler
//     above us already wrote the headers — we mustn't 401 it),
//   - lets any path in cfg.PublicPaths through,
//   - lets loopback requests through when cfg.LocalhostOnly is set,
//   - lets requests through when their X-Bridge-Internal-Token header
//     constant-time-equals cfg.InternalToken,
//   - 401s everything else as JSON `{"error":"unauthorized"}`.
//
// Cookie-session auth is NOT yet implemented in the Go port. Until it
// is, the web UI must send the internal token as the header (or the
// operator must run the bridge with --localhost-only). See the
// "S13/S14 auth" TODOs in internal/api/tasks_write.go for the
// remaining work.
func NewAuth(cfg AuthConfig) func(http.Handler) http.Handler {
	publics := normalizePaths(cfg.PublicPaths)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			if isPublicPath(publics, r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			// Static SPA bypass — anything outside /api/* is asset
			// traffic (index.html / hashed JS / fonts / favicon). The
			// data layer (/api/*) below stays fully gated. See
			// AllowNonAPIPaths in AuthConfig for the rationale.
			if cfg.AllowNonAPIPaths && !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}
			if cfg.LocalhostOnly && isLoopback(r) {
				next.ServeHTTP(w, r)
				return
			}
			tok := r.Header.Get(auth.InternalTokenHeader)
			// EventSource (SSE) cannot set custom request headers, so the
			// SPA passes the same token via ?token=… on /api/.../events
			// endpoints. Accept either form. The query string is not
			// logged by the request logger middleware (see hlog config),
			// so the token does not leak via access logs.
			if tok == "" {
				tok = r.URL.Query().Get("token")
			}
			if tok != "" && cfg.InternalToken != "" &&
				auth.ConstantTimeCompareString(tok, cfg.InternalToken) {
				next.ServeHTTP(w, r)
				return
			}
			writeUnauthorized(w)
		})
	}
}

func normalizePaths(in []string) []string {
	out := make([]string, 0, len(in))
	for _, p := range in {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		out = append(out, p)
	}
	return out
}

func isPublicPath(publics []string, path string) bool {
	for _, p := range publics {
		if path == p {
			return true
		}
		// Treat "/static" as a prefix when followed by "/" — protects
		// against "/static" matching "/staticky".
		if strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	return false
}

// isLoopback reports whether r's RemoteAddr is a loopback IP. We strip
// the port (which net.SplitHostPort tolerates a missing port for, but
// http.Server always includes one) before parsing.
func isLoopback(r *http.Request) bool {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	// Strip IPv6 brackets if any survived SplitHostPort (shouldn't, but
	// be defensive).
	host = strings.TrimPrefix(strings.TrimSuffix(host, "]"), "[")
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback()
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
}
