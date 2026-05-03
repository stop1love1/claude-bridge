package middleware

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/auth"
)

const testToken = "secret-token-of-some-length-1234"

func newPingHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
}

func TestAuthMiddleware(t *testing.T) {
	cases := []struct {
		name          string
		cfg           AuthConfig
		method        string
		path          string
		header        string
		remoteAddr    string
		wantStatus    int
		wantHandlerOK bool
	}{
		{
			name:       "missing token returns 401",
			cfg:        AuthConfig{InternalToken: testToken},
			method:     http.MethodGet,
			path:       "/api/tasks",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "wrong token returns 401",
			cfg:        AuthConfig{InternalToken: testToken},
			method:     http.MethodGet,
			path:       "/api/tasks",
			header:     "not-the-right-token-of-this-length",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:          "correct token runs handler",
			cfg:           AuthConfig{InternalToken: testToken},
			method:        http.MethodGet,
			path:          "/api/tasks",
			header:        testToken,
			wantStatus:    http.StatusOK,
			wantHandlerOK: true,
		},
		{
			name:          "OPTIONS bypasses without token",
			cfg:           AuthConfig{InternalToken: testToken},
			method:        http.MethodOptions,
			path:          "/api/tasks",
			wantStatus:    http.StatusOK,
			wantHandlerOK: true,
		},
		{
			name:          "loopback bypass when configured",
			cfg:           AuthConfig{InternalToken: testToken, LocalhostOnly: true},
			method:        http.MethodGet,
			path:          "/api/tasks",
			remoteAddr:    "127.0.0.1:54321",
			wantStatus:    http.StatusOK,
			wantHandlerOK: true,
		},
		{
			name:       "loopback NOT configured returns 401",
			cfg:        AuthConfig{InternalToken: testToken, LocalhostOnly: false},
			method:     http.MethodGet,
			path:       "/api/tasks",
			remoteAddr: "127.0.0.1:54321",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:          "loopback ipv6 bypass when configured",
			cfg:           AuthConfig{InternalToken: testToken, LocalhostOnly: true},
			method:        http.MethodGet,
			path:          "/api/tasks",
			remoteAddr:    "[::1]:54321",
			wantStatus:    http.StatusOK,
			wantHandlerOK: true,
		},
		{
			name:       "non-loopback ip with localhostOnly still 401",
			cfg:        AuthConfig{InternalToken: testToken, LocalhostOnly: true},
			method:     http.MethodGet,
			path:       "/api/tasks",
			remoteAddr: "10.0.0.5:54321",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:          "public path bypasses",
			cfg:           AuthConfig{InternalToken: testToken, PublicPaths: []string{"/api/health"}},
			method:        http.MethodGet,
			path:          "/api/health",
			wantStatus:    http.StatusOK,
			wantHandlerOK: true,
		},
		{
			name:       "public-prefix does not match unrelated path",
			cfg:        AuthConfig{InternalToken: testToken, PublicPaths: []string{"/static"}},
			method:     http.MethodGet,
			path:       "/staticky",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:          "public-prefix matches subpath",
			cfg:           AuthConfig{InternalToken: testToken, PublicPaths: []string{"/static"}},
			method:        http.MethodGet,
			path:          "/static/app.js",
			wantStatus:    http.StatusOK,
			wantHandlerOK: true,
		},
		{
			name:       "empty server token + token header still 401 (fail-closed)",
			cfg:        AuthConfig{InternalToken: ""},
			method:     http.MethodGet,
			path:       "/api/tasks",
			header:     "anything",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:          "AllowNonAPIPaths lets / through without token",
			cfg:           AuthConfig{InternalToken: testToken, AllowNonAPIPaths: true},
			method:        http.MethodGet,
			path:          "/",
			wantStatus:    http.StatusOK,
			wantHandlerOK: true,
		},
		{
			name:          "AllowNonAPIPaths lets static asset through",
			cfg:           AuthConfig{InternalToken: testToken, AllowNonAPIPaths: true},
			method:        http.MethodGet,
			path:          "/assets/main-abc.js",
			wantStatus:    http.StatusOK,
			wantHandlerOK: true,
		},
		{
			name:       "AllowNonAPIPaths still gates /api/*",
			cfg:        AuthConfig{InternalToken: testToken, AllowNonAPIPaths: true},
			method:     http.MethodGet,
			path:       "/api/tasks",
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewAuth(tc.cfg)(newPingHandler())
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if tc.header != "" {
				req.Header.Set(auth.InternalTokenHeader, tc.header)
			}
			if tc.remoteAddr != "" {
				req.RemoteAddr = tc.remoteAddr
			}
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != tc.wantStatus {
				t.Fatalf("status: got %d want %d (body=%s)", rr.Code, tc.wantStatus, rr.Body.String())
			}
			body, _ := io.ReadAll(rr.Body)
			if tc.wantHandlerOK {
				if !strings.Contains(string(body), `"ok":true`) {
					t.Fatalf("expected handler body, got %q", body)
				}
			} else if rr.Code == http.StatusUnauthorized {
				var got map[string]string
				if err := json.Unmarshal(body, &got); err != nil {
					t.Fatalf("401 body not JSON: %v (%q)", err, body)
				}
				if got["error"] != "unauthorized" {
					t.Fatalf("401 body: got %v want {error:unauthorized}", got)
				}
			}
		})
	}
}
