// Command bridge is the single-binary entrypoint for the claude-bridge
// Go server. Subcommands are added incrementally as the migration
// progresses (see MIGRATION_SESSIONS.md). For now `serve` is the only
// implemented subcommand.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/spf13/cobra"

	"github.com/stop1love1/claude-bridge/internal/api"
	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/auth"
	"github.com/stop1love1/claude-bridge/internal/coordinator"
	"github.com/stop1love1/claude-bridge/internal/detect"
	"github.com/stop1love1/claude-bridge/internal/server"
	"github.com/stop1love1/claude-bridge/internal/sessions"
	"github.com/stop1love1/claude-bridge/internal/spawn"
	"github.com/stop1love1/claude-bridge/internal/tunnels"
)

// Version is overridden at build time via `-ldflags "-X main.Version=..."`.
var Version = "dev"

func main() {
	if err := newRootCmd().Execute(); err != nil {
		os.Exit(1)
	}
}

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "bridge",
		Short:         "claude-bridge — coordinator for cross-repo Claude Code sessions",
		SilenceUsage:  true,
		SilenceErrors: false,
		Version:       Version,
	}
	root.AddCommand(newServeCmd())
	return root
}

func newServeCmd() *cobra.Command {
	var (
		port           int
		host           string
		bridgeRoot     string
		allowedOrigins []string
		localhostOnly  bool
		webDir         string
	)
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Start the bridge HTTP API",
		RunE: func(cmd *cobra.Command, args []string) error {
			logger := zerolog.New(os.Stderr).
				With().
				Timestamp().
				Str("svc", "bridge").
				Str("version", Version).
				Logger()

			// Resolve bridge root. Default = cwd, override via --root.
			root := bridgeRoot
			if root == "" {
				cwd, err := os.Getwd()
				if err != nil {
					return fmt.Errorf("getwd: %w", err)
				}
				root = cwd
			}
			absRoot, err := filepath.Abs(root)
			if err != nil {
				return fmt.Errorf("abs root: %w", err)
			}

			// Validate operator-supplied CORS origins BEFORE building
			// the server — pairing AllowCredentials=true with "*" or
			// "null" would let any third-party site issue authenticated
			// requests against the bridge. Default (nil) is fine; the
			// server fills in http://localhost:7777.
			if err := server.ValidateAllowedOrigins(allowedOrigins); err != nil {
				return fmt.Errorf("invalid --allowed-origin: %w", err)
			}

			// Resolve / generate the internal-bypass token. Spawned
			// children inherit BRIDGE_INTERNAL_TOKEN via os.Setenv inside
			// LoadOrGenerateInternalToken, so internal/spawn keeps
			// working without changes.
			internalToken, generated, err := auth.LoadOrGenerateInternalToken()
			if err != nil {
				return fmt.Errorf("internal token: %w", err)
			}
			if generated {
				logger.Info().
					Str("token", internalToken).
					Msg("generated BRIDGE_INTERNAL_TOKEN — set this in your shell to keep it stable across restarts")
			}

			// Wire every package's process-global handle to the
			// resolved bridge root + its derived paths. Order matters
			// only insofar as later wires may reference earlier ones
			// (none do today).
			sessionsDir := filepath.Join(absRoot, "sessions")
			uploadsDir := filepath.Join(absRoot, ".uploads")

			api.SetConfig(&api.Config{
				SessionsDir:  sessionsDir,
				ProjectsRoot: sessions.DefaultClaudeProjectsRoot(),
			})
			api.SetBridgeRoot(absRoot)
			api.SetUploadDir(uploadsDir)

			apps.SetDefault(apps.New(absRoot))

			// Spawn registry + spawner — the kill route + message
			// route share the same instances so a child started via
			// /agents can be killed via /sessions/:id/kill.
			spawnRegistry := spawn.NewRegistry()
			spawner := spawn.New()
			spawner.Registry = spawnRegistry
			spawner.BridgePort = port
			spawner.BridgeURL = fmt.Sprintf("http://%s:%d", host, port)
			api.SetSpawnRegistry(spawnRegistry)
			api.SetSpawner(spawner)

			// Coordinator config — POST /api/tasks now spawns a real
			// claude coordinator in the bridge root after creating
			// the task. The coordinator template lives at
			// <bridgeRoot>/prompts/coordinator.md (falls back to a
			// bundled minimal template when missing).
			coordinator.SetDefault(&coordinator.Config{
				BridgeRoot:     absRoot,
				BridgeURL:      fmt.Sprintf("http://%s:%d", host, port),
				SessionsDir:    sessionsDir,
				BridgeFolder:   filepath.Base(absRoot),
				BridgeLogicDir: filepath.Join(absRoot, "prompts"),
				Spawner:        spawner,
				Detector:       detect.Default(),
			})

			// Reaper — belt-and-suspenders sweep that drops registry
			// entries whose process is gone. Runs until shutdown.
			reaperCtx, reaperCancel := context.WithCancel(context.Background())
			defer reaperCancel()
			reaper := &spawn.Reaper{Registry: spawnRegistry}
			go reaper.Run(reaperCtx)

			addr := host + ":" + strconv.Itoa(port)
			srv := server.New(server.Config{
				Addr:           addr,
				Version:        Version,
				Logger:         logger,
				AllowedOrigins: allowedOrigins,
				InternalToken:  internalToken,
				LocalhostOnly:  localhostOnly,
				WebDir:         webDir,
			})

			// SPA source: disk (--web-dir) for hot reload during dev,
			// otherwise the embedded internal/web/dist/ bundle.
			spaSource := "embed"
			if webDir != "" {
				spaSource = webDir
			}
			logger.Info().
				Str("spa_source", spaSource).
				Str("ui_url", fmt.Sprintf("http://%s:%d/", host, port)).
				Msg("serving SPA")

			errCh := make(chan error, 1)
			go func() {
				logger.Info().
					Str("addr", addr).
					Str("root", absRoot).
					Msg("listening")
				if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
					errCh <- err
				}
				close(errCh)
			}()

			sigCh := make(chan os.Signal, 1)
			signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

			select {
			case err := <-errCh:
				if err != nil {
					return fmt.Errorf("listen: %w", err)
				}
				return nil
			case sig := <-sigCh:
				logger.Info().Str("signal", sig.String()).Msg("shutting down")

				// Stop accepting new connections + drain in-flight
				// requests up to 10 s.
				if err := server.Shutdown(srv, 10*time.Second); err != nil {
					logger.Warn().Err(err).Msg("http shutdown")
				}
				// Tear down child claude processes — SIGTERM, then
				// SIGKILL on stragglers after 5 s.
				clean, err := spawner.Shutdown(5 * time.Second)
				logger.Info().
					Int("children_clean", clean).
					Err(err).
					Msg("spawner shutdown")
				// Tear down tunnels (ngrok / lt) so they release URLs.
				killed := tunnels.Default.KillAll()
				if killed > 0 {
					logger.Info().Int("killed", killed).Msg("tunnels shutdown")
				}
				return nil
			}
		},
	}
	cmd.Flags().IntVar(&port, "port", 8080, "TCP port to bind")
	cmd.Flags().StringVar(&host, "host", "127.0.0.1", "Host/interface to bind")
	cmd.Flags().StringVar(&bridgeRoot, "root", "",
		"Bridge root directory (defaults to current working directory)")
	cmd.Flags().StringSliceVar(&allowedOrigins, "allowed-origin", nil,
		"CORS origin permitted to call the API (repeatable). Default http://localhost:7777. Wildcards rejected.")
	cmd.Flags().BoolVar(&localhostOnly, "localhost-only", false,
		"Bypass auth for loopback (127.0.0.1 / ::1) callers. Off by default — only enable on a trusted single-machine setup.")
	cmd.Flags().StringVar(&webDir, "web-dir", "",
		"Serve the SPA from this directory on disk (e.g. web/dist) instead of the embedded bundle. Useful with `pnpm dev` for hot reload.")
	return cmd
}
