// Package tunnels manages public-tunnel providers (currently ngrok):
// install, authtoken setup, start/stop of the tunnel process, and the
// /api/tunnels* endpoints.
package tunnels

import (
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Status discriminates the lifecycle state of a tunnel entry.
type Status string

const (
	StatusStarting Status = "starting"
	StatusRunning  Status = "running"
	StatusError    Status = "error"
	StatusStopped  Status = "stopped"
)

// Provider is the upstream service that exposes the tunnel.
type Provider string

const (
	ProviderLocaltunnel Provider = "localtunnel"
	ProviderNgrok       Provider = "ngrok"
)

// Entry is one tunnel row the bridge tracks. Mirrors libs/tunnels.ts
// TunnelEntry exactly so the existing UI fetcher unpacks the same shape.
type Entry struct {
	ID        string   `json:"id"`
	Port      int      `json:"port"`
	Provider  Provider `json:"provider"`
	Label     string   `json:"label,omitempty"`
	Subdomain string   `json:"subdomain,omitempty"`
	URL       string   `json:"url,omitempty"`
	Status    Status   `json:"status"`
	StartedAt string   `json:"startedAt"`
	UpdatedAt string   `json:"updatedAt"`
	Error     string   `json:"error,omitempty"`
	PID       int      `json:"pid,omitempty"`

	cmd *exec.Cmd
}

// StartOptions is the request payload for POST /api/tunnels.
type StartOptions struct {
	Port      int
	Provider  Provider
	Label     string
	Subdomain string
}

// validProviders is the set the registry accepts. Mirrors the
// VALID_PROVIDERS set in app/api/tunnels/route.ts.
var validProviders = map[Provider]struct{}{
	ProviderLocaltunnel: {},
	ProviderNgrok:       {},
}

// IsValidProvider reports whether p is one of the supported providers.
func IsValidProvider(p Provider) bool {
	_, ok := validProviders[p]
	return ok
}

var subdomainRE = regexp.MustCompile(`^[A-Za-z0-9-]{1,63}$`)

// IsValidSubdomain matches the TS regex — alphanumeric + dash, ≤63 chars.
func IsValidSubdomain(s string) bool {
	return subdomainRE.MatchString(s)
}

// Registry holds the live tunnel set in process. Persisted nowhere —
// a server restart drops every entry; the bridge tree-kills the
// children on shutdown so the upstream services release the URLs.
type Registry struct {
	mu      sync.Mutex
	entries map[string]*Entry
	counter int64
}

// NewRegistry returns an empty in-memory registry.
func NewRegistry() *Registry {
	return &Registry{entries: make(map[string]*Entry)}
}

// Default is the package-global registry. Cmd/bridge serve uses this;
// tests construct their own via NewRegistry for isolation.
var Default = NewRegistry()

// nextID generates a short stable id ("tn_<n>") so a UI poll can match
// rows across tunnel start/stop without persisted state.
func (r *Registry) nextID() string {
	n := atomic.AddInt64(&r.counter, 1)
	return fmt.Sprintf("tn_%d", n)
}

// List returns every entry in the registry, newest-first by StartedAt.
// Returns a copy so callers can safely iterate without holding the lock.
func (r *Registry) List() []Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Entry, 0, len(r.entries))
	for _, e := range r.entries {
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt > out[j].StartedAt })
	return out
}

// Get returns the tunnel by id, or nil + false if missing.
func (r *Registry) Get(id string) (*Entry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[id]
	if !ok {
		return nil, false
	}
	cp := *e
	return &cp, true
}

// Start spawns the provider's CLI and returns the new entry in
// `starting` state. The spawn machinery is stubbed in S26 — the
// actual ngrok / localtunnel binaries aren't shelled out yet because
// the URL-extraction regex per provider, the install flow, and the
// authtoken handling all live downstream. Once the operator points
// the bridge at real binaries, this is where the spawn happens.
//
// Returns ErrProviderNotImplemented for unsupported providers; the
// HTTP handler maps that to 400. Real callers will hit this once the
// ngrok install + binary path resolution lands alongside the spawn
// engine cross-package wiring.
func (r *Registry) Start(opts StartOptions) (*Entry, error) {
	if !IsValidProvider(opts.Provider) {
		return nil, fmt.Errorf("tunnels: unknown provider %q", opts.Provider)
	}
	if opts.Port < 1 || opts.Port > 65535 {
		return nil, fmt.Errorf("tunnels: port must be 1-65535, got %d", opts.Port)
	}
	if opts.Subdomain != "" && !IsValidSubdomain(opts.Subdomain) {
		return nil, fmt.Errorf("tunnels: invalid subdomain %q", opts.Subdomain)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	e := &Entry{
		ID:        r.nextID(),
		Port:      opts.Port,
		Provider:  opts.Provider,
		Label:     opts.Label,
		Subdomain: opts.Subdomain,
		Status:    StatusStarting,
		StartedAt: now,
		UpdatedAt: now,
		Error:     "spawn machinery deferred (S26+)",
	}
	r.mu.Lock()
	r.entries[e.ID] = e
	r.mu.Unlock()
	cp := *e
	return &cp, nil
}

// Stop terminates the tunnel's child process and flips status to
// `stopped`. Returns false when the id isn't tracked. The actual
// process kill is a no-op for the S26 stub since no children are
// spawned; once Start wires the spawn, this calls into spawn.killProcessTree.
func (r *Registry) Stop(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[id]
	if !ok {
		return false
	}
	e.Status = StatusStopped
	e.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	return true
}

// Remove evicts the entry entirely. Used by the DELETE endpoint after
// a Stop confirms the child is gone.
func (r *Registry) Remove(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.entries[id]; !ok {
		return false
	}
	delete(r.entries, id)
	return true
}

// KillAll stops every tracked tunnel — wired into the bridge's
// shutdown handler so a Ctrl-C doesn't leak ngrok / lt subprocesses.
// Returns the count of tunnels that were running.
func (r *Registry) KillAll() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := len(r.entries)
	for id, e := range r.entries {
		e.Status = StatusStopped
		e.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		_ = id
	}
	return n
}

// ProviderStatus is the row /api/tunnels/providers returns —
// availability of each backend so the UI can disable buttons for
// missing CLIs.
type ProviderStatus struct {
	Provider  Provider `json:"provider"`
	Installed bool     `json:"installed"`
	Path      string   `json:"path,omitempty"`
	Version   string   `json:"version,omitempty"`
	Note      string   `json:"note,omitempty"`
}

// DetectProviders inspects PATH for each supported provider's CLI.
// Stubbed S26: returns Installed=false for both with a note pointing
// to the deferred install flow. Real `which ngrok` / `which lt`
// inspection lands when the install endpoint ports.
func DetectProviders() []ProviderStatus {
	return []ProviderStatus{
		{Provider: ProviderLocaltunnel, Installed: false, Note: "PATH probe deferred (S26+)"},
		{Provider: ProviderNgrok, Installed: false, Note: "install flow deferred (S26+)"},
	}
}

// InstallResult is the response shape from POST
// /api/tunnels/providers/ngrok/install — the bridge downloads the
// ngrok binary into a known cache dir on the operator's behalf.
type InstallResult struct {
	OK      bool   `json:"ok"`
	Path    string `json:"path,omitempty"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
}

// InstallNgrok downloads and unpacks the ngrok binary. Stubbed S26:
// returns ErrInstallNotImplemented so the handler can surface a
// helpful error. The real flow detects the OS+arch, downloads from
// ngrok.com, unzips, chmods, verifies via `ngrok version`.
func InstallNgrok() (InstallResult, error) {
	return InstallResult{OK: false, Error: "install flow deferred (S26+)"}, ErrInstallNotImplemented
}

// AuthtokenStore is the bridge's persisted ngrok auth token storage
// (typically `~/.ngrok2/ngrok.yml` or via `ngrok config add-authtoken`).
// Stubbed S26 — Get returns the stored value, Set persists it.
type AuthtokenStore struct {
	mu    sync.Mutex
	token string
}

// DefaultAuthtokenStore is the package-global persisted token. Real
// persistence to ~/.ngrok2/ngrok.yml lands when the install flow
// ports; for now Get/Set just round-trip in memory so the UI can
// exercise the form.
var DefaultAuthtokenStore = &AuthtokenStore{}

// Get returns the stored token (empty string when none).
func (s *AuthtokenStore) Get() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.token
}

// Set replaces the stored token. Returns the trimmed value so the
// caller can echo it back to the UI for confirmation.
func (s *AuthtokenStore) Set(token string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.token = token
	return s.token
}

// Errors surfaced by the package.
var (
	ErrInstallNotImplemented = errors.New("tunnels: ngrok install not implemented yet")
	ErrTunnelNotFound        = errors.New("tunnels: not found")
)
