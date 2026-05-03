// Package server wires the chi router, middleware, and route handlers
// into an *http.Server ready to be served by cmd/bridge.
//
// Cookies: net/http already parses Cookie headers on demand via
// r.Cookie / r.Cookies, so no separate cookie-parser middleware is
// needed (unlike Express). Auth handlers will read cookies directly
// in later sessions.
package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/hlog"

	"github.com/stop1love1/claude-bridge/internal/api"
	bmw "github.com/stop1love1/claude-bridge/internal/middleware"
	webdist "github.com/stop1love1/claude-bridge/internal/web"
)

// Config controls how a server instance is constructed. Zero values are
// safe defaults — callers only need to set Addr.
type Config struct {
	Addr    string
	Version string
	// AllowedOrigins is the list of CORS origins permitted to call the
	// API. Defaults to the bridge UI dev origin (http://localhost:7777)
	// when nil so a fresh `bridge serve` works without extra flags.
	//
	// Wildcards ("*", "null", empty entries) are rejected at startup
	// because we set AllowCredentials=true — a wildcard origin paired
	// with credentialed CORS is a textbook CSRF foothold. Validate via
	// ValidateAllowedOrigins before constructing the server.
	AllowedOrigins []string
	Logger         zerolog.Logger

	// InternalToken gates every non-public route. cmd/bridge populates
	// this from BRIDGE_INTERNAL_TOKEN (auto-generated if missing). An
	// empty token causes every authenticated request to 401 — matches
	// the fail-closed posture we want.
	InternalToken string

	// LocalhostOnly bypasses auth for loopback callers. Off by default;
	// the operator opts in via cmd/bridge --localhost-only.
	LocalhostOnly bool

	// WebDir, when non-empty, serves the SPA from disk at that path
	// instead of from the embedded bundle. cmd/bridge wires it from
	// the --web-dir flag so a developer running `air` against
	// `pnpm dev` (writing to web/dist live) sees changes without
	// rebuilding the Go binary. Empty (the production default) means
	// serve from internal/web/dist via embed.FS.
	WebDir string
}

// ValidateAllowedOrigins refuses wildcards / null / empty entries. We
// pair AllowCredentials=true with the configured origins so a wildcard
// would let any third-party site read authenticated responses — call
// this before New / NewHandler.
func ValidateAllowedOrigins(origins []string) error {
	for i, o := range origins {
		trimmed := strings.TrimSpace(o)
		if trimmed == "" {
			return fmt.Errorf("AllowedOrigins[%d] is empty", i)
		}
		if trimmed == "*" {
			return fmt.Errorf("AllowedOrigins[%d] = %q: wildcard origins are incompatible with AllowCredentials=true", i, o)
		}
		if strings.EqualFold(trimmed, "null") {
			return fmt.Errorf("AllowedOrigins[%d] = %q: 'null' origin is not permitted", i, o)
		}
	}
	return nil
}

// New returns an *http.Server with all middleware and routes wired up.
// The caller owns ListenAndServe / Shutdown.
func New(cfg Config) *http.Server {
	return &http.Server{
		Addr:              cfg.Addr,
		Handler:           NewHandler(cfg),
		ReadHeaderTimeout: 10 * time.Second,
	}
}

// NewHandler returns just the chi router with all middleware mounted.
// Exposed for in-process tests (httptest, contract framework) which
// don't want to bind a real port.
func NewHandler(cfg Config) http.Handler {
	if len(cfg.AllowedOrigins) == 0 {
		cfg.AllowedOrigins = []string{"http://localhost:7777"}
	}

	r := chi.NewRouter()

	r.Use(hlog.NewHandler(cfg.Logger))
	r.Use(hlog.RequestIDHandler("req_id", "X-Request-Id"))
	r.Use(requestLogger)
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.AllowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Content-Type", "Authorization", "X-Bridge-Internal-Token", "X-Request-Id"},
		ExposedHeaders:   []string{"X-Request-Id"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Auth gate — runs AFTER CORS so OPTIONS preflight gets the right
	// headers, but BEFORE every route below. Health is intentionally
	// public so liveness probes from a load balancer don't need the
	// shared secret. AllowNonAPIPaths lets the SPA static handler
	// (mounted as the chi catch-all at the bottom of NewHandler) serve
	// index.html / hashed assets without a token; /api/* stays gated.
	r.Use(bmw.NewAuth(bmw.AuthConfig{
		InternalToken:    cfg.InternalToken,
		LocalhostOnly:    cfg.LocalhostOnly,
		PublicPaths:      []string{"/api/health"},
		AllowNonAPIPaths: true,
	}))

	startedAt := time.Now()
	r.Get("/api/health", healthHandler(cfg.Version, startedAt))
	r.Get("/api/tasks", api.ListTasks)
	r.Post("/api/tasks", api.CreateTask)
	r.Get("/api/tasks/meta", api.ListTasksMeta)
	r.Get("/api/tasks/{id}", api.GetTask)
	r.Patch("/api/tasks/{id}", api.UpdateTask)
	r.Delete("/api/tasks/{id}", api.DeleteTask)
	r.Get("/api/tasks/{id}/meta", api.GetTaskMeta)
	r.Get("/api/tasks/{id}/summary", api.GetTaskSummary)
	r.Put("/api/tasks/{id}/summary", api.PutTaskSummary)
	r.Get("/api/tasks/{id}/usage", api.GetTaskUsage)
	r.Post("/api/tasks/{id}/link", api.LinkSession)
	r.Get("/api/tasks/{id}/events", api.TaskEvents)
	r.Post("/api/tasks/{id}/detect/refresh", api.DetectRefresh)
	r.Post("/api/tasks/{id}/agents", api.SpawnAgent)
	r.Post("/api/tasks/{id}/continue", api.ContinueTask)
	r.Post("/api/tasks/{id}/clear", api.ClearTask)

	// S26 — Tunnels
	r.Get("/api/tunnels", api.ListTunnels)
	r.Post("/api/tunnels", api.CreateTunnel)
	r.Delete("/api/tunnels/{id}", api.StopTunnel)
	r.Get("/api/tunnels/providers", api.ListTunnelProviders)
	r.Post("/api/tunnels/providers/ngrok/install", api.InstallNgrok)
	r.Get("/api/tunnels/providers/ngrok/authtoken", api.GetNgrokAuthtoken)
	r.Post("/api/tunnels/providers/ngrok/authtoken", api.SetNgrokAuthtoken)

	// S27 — Upload
	r.Post("/api/sessions/{sessionId}/upload", api.SessionUpload)
	r.Get("/api/uploads/{sid}/{name}", api.GetUpload)

	// S28 — Permission
	r.Get("/api/permission", api.ListAllPermissions)
	r.Post("/api/permission", api.AnnouncePermission)
	r.Post("/api/permission/{requestId}", api.AnswerPermission)
	r.Get("/api/permission/stream", api.PermissionStream)
	r.Get("/api/sessions/{sessionId}/permission", api.SessionPermissions)
	r.Get("/api/sessions/{sessionId}/permission/{requestId}", api.GetSessionPermission)
	r.Post("/api/sessions/{sessionId}/permission/{requestId}", api.DecideSessionPermission)

	// S29 — Misc routes
	r.Get("/api/sessions/{sessionId}/tail", api.SessionTail)
	r.Post("/api/sessions/{sessionId}/kill", api.SessionKill)
	r.Post("/api/sessions/{sessionId}/message", api.SessionMessage)
	r.Post("/api/sessions/{sessionId}/rewind", api.SessionRewind)

	// Per-run subroutes — kill / prompt / diff scoped to the (taskId,
	// sessionId) pair so the UI can target an individual run without
	// depending on which task happens to own it. More specific than
	// the global /api/sessions/{sid}/kill above.
	r.Post("/api/tasks/{id}/runs/{sessionId}/kill", api.KillRun)
	r.Get("/api/tasks/{id}/runs/{sessionId}/prompt", api.GetRunPrompt)
	r.Get("/api/tasks/{id}/runs/{sessionId}/diff", api.GetRunDiff)

	r.Get("/api/bridge/settings", api.GetBridgeSettings)
	r.Put("/api/bridge/settings", api.PutBridgeSettings)
	r.Get("/api/sessions/all", api.ListAllSessions)
	r.Get("/api/usage", api.GetUsage)

	// S16 — Apps registry
	r.Get("/api/apps", api.ListApps)
	r.Post("/api/apps", api.AddApp)
	r.Post("/api/apps/bulk", api.BulkReplaceApps)
	r.Get("/api/apps/{name}", api.GetApp)
	r.Delete("/api/apps/{name}", api.DeleteApp)
	r.Post("/api/apps/auto-detect", api.AutoDetectApps)
	r.Get("/api/apps/{name}/memory", api.GetAppMemory)
	r.Post("/api/apps/{name}/memory", api.AppendAppMemory)
	r.Post("/api/apps/{name}/scan", api.ScanApp)

	// S17 — Repos resolver + slash discovery
	r.Get("/api/repos", api.ListRepos)
	// Profiles routes mount BEFORE /api/repos/{name} so chi doesn't
	// route "profiles" as the {name} parameter — chi matches by
	// declaration order on overlapping patterns.
	r.Get("/api/repos/profiles", api.ListRepoProfiles)
	r.Post("/api/repos/profiles/refresh", api.RefreshRepoProfiles)
	r.Get("/api/repos/profiles/{name}", api.GetRepoProfile)
	r.Delete("/api/repos/profiles/{name}", api.DeleteRepoProfile)
	r.Get("/api/repos/{name}", api.GetRepo)
	r.Get("/api/repos/{name}/files", api.ListRepoFiles)
	r.Get("/api/repos/{name}/raw", api.GetRepoRawFile)
	r.Get("/api/repos/{name}/slash-commands", api.ListRepoSlashCommands)

	// SPA catch-all — must mount LAST so chi only falls through here
	// when no real /api/* route matched. The handler returns 404 for
	// /api/* (so a typo'd API URL doesn't get the SPA shell back),
	// serves real files from the bundle for asset paths, and falls
	// back to index.html for everything else so React Router can
	// render client-side routes.
	if h, err := webdist.StaticHandler(cfg.WebDir); err != nil {
		// Don't fail the whole server — the API still works without
		// the SPA. Log via the request logger upstream by mounting a
		// small explainer handler in its place.
		cfg.Logger.Warn().Err(err).Msg("spa static handler disabled")
		r.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "SPA bundle unavailable — run `make build-web && make embed-web` or pass --web-dir", http.StatusNotFound)
		}))
	} else {
		r.Handle("/*", h)
	}

	return r
}

type healthResponse struct {
	Status  string  `json:"status"`
	Version string  `json:"version,omitempty"`
	Uptime  float64 `json:"uptime"`
}

func healthHandler(version string, startedAt time.Time) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		api.WriteJSON(w, http.StatusOK, healthResponse{
			Status:  "ok",
			Version: version,
			Uptime:  time.Since(startedAt).Seconds(),
		})
	}
}

// requestLogger emits one structured log line per completed request. It
// reuses the zerolog.Logger installed by hlog and the request id set by
// hlog.RequestIDHandler so downstream handlers can correlate.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		hlog.FromRequest(r).Info().
			Str("method", r.Method).
			Str("path", r.URL.Path).
			Int("status", ww.Status()).
			Int("bytes", ww.BytesWritten()).
			Dur("dur", time.Since(start)).
			Msg("http")
	})
}

// Shutdown gracefully stops s, waiting up to timeout for in-flight
// requests to finish before forcing closure.
func Shutdown(s *http.Server, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
