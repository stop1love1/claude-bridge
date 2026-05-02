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
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/hlog"

	"github.com/stop1love1/claude-bridge/internal/api"
)

// Config controls how a server instance is constructed. Zero values are
// safe defaults — callers only need to set Addr.
type Config struct {
	Addr    string
	Version string
	// AllowedOrigins is the list of CORS origins permitted to call the
	// API. Defaults to the bridge UI dev origin (http://localhost:7777)
	// when nil so a fresh `bridge serve` works without extra flags.
	AllowedOrigins []string
	Logger         zerolog.Logger
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

	startedAt := time.Now()
	r.Get("/api/health", healthHandler(cfg.Version, startedAt))
	r.Get("/api/tasks/meta", api.ListTasksMeta)
	r.Get("/api/sessions/all", api.ListAllSessions)

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
