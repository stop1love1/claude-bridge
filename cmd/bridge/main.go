// Command bridge is the single-binary entrypoint for the claude-bridge
// Go server. Subcommands are added incrementally as the migration
// progresses (see MIGRATION_SESSIONS.md). For now `serve` is the only
// implemented subcommand.
package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/spf13/cobra"

	"github.com/stop1love1/claude-bridge/internal/server"
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
		port int
		host string
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

			addr := host + ":" + strconv.Itoa(port)
			srv := server.New(server.Config{
				Addr:    addr,
				Version: Version,
				Logger:  logger,
			})

			errCh := make(chan error, 1)
			go func() {
				logger.Info().Str("addr", addr).Msg("listening")
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
				if err := server.Shutdown(srv, 10*time.Second); err != nil {
					return fmt.Errorf("shutdown: %w", err)
				}
				return nil
			}
		},
	}
	cmd.Flags().IntVar(&port, "port", 8080, "TCP port to bind")
	cmd.Flags().StringVar(&host, "host", "127.0.0.1", "Host/interface to bind")
	return cmd
}
