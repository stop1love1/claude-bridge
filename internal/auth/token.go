// Package auth handles cookie sessions, bcrypt password hashing,
// first-run setup tokens, and the login-approval flow used by the
// /api/auth/* endpoints.
//
// Today only the internal-token bypass is wired into the Go server —
// see ConstantTimeCompareString below + internal/middleware.NewAuth.
// Cookie sessions, password hashing, and the device-approval flow are
// still served by the legacy Next.js handlers; they will be ported in
// a follow-up session (search "S13/S14 auth" for the trail).
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"os"
	"strings"
)

// InternalTokenEnv is the environment variable spawned children read
// (via internal/spawn.Spawner) to authenticate to the bridge HTTP API
// without a session cookie. The header name uses the same kebab-case
// the TS port settled on so existing callers (permission hooks,
// coordinator self-register, etc.) keep working unchanged.
const (
	InternalTokenEnv    = "BRIDGE_INTERNAL_TOKEN"
	InternalTokenHeader = "X-Bridge-Internal-Token"
)

// ConstantTimeCompareString returns true iff a and b are byte-equal,
// using crypto/subtle.ConstantTimeCompare so a network-adjacent
// attacker can't recover the secret one byte at a time via response-
// latency measurements. Returns false on any empty input or length
// mismatch — both branches are O(1).
func ConstantTimeCompareString(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	// Length check before ConstantTimeCompare: subtle's docs note that
	// it returns 0 immediately on length mismatch (which leaks length),
	// but mismatched secrets here are an authentication failure either
	// way — we don't need to hide the length of the *expected* token,
	// just avoid a per-byte short-circuit.
	if len(a) != len(b) {
		// Still run a constant-time op against a same-length zero
		// buffer so the timing of the mismatched-length path is not
		// dramatically faster than the matched-length path.
		_ = subtle.ConstantTimeCompare([]byte(a), []byte(a))
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// LoadOrGenerateInternalToken returns the token from os.Getenv when
// set, or generates a fresh 32-byte hex token and exports it via
// os.Setenv so spawned children inherit it. Used by cmd/bridge at
// server boot.
//
// The returned (token, generated) pair lets the caller log the token
// once on first start without re-logging it across restarts.
func LoadOrGenerateInternalToken() (token string, generated bool, err error) {
	if existing := strings.TrimSpace(os.Getenv(InternalTokenEnv)); existing != "" {
		return existing, false, nil
	}
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", false, err
	}
	tok := hex.EncodeToString(buf[:])
	if err := os.Setenv(InternalTokenEnv, tok); err != nil {
		return "", false, err
	}
	return tok, true, nil
}

// ErrUnauthorized is the sentinel middleware uses internally so handlers
// can switch on it without importing net/http status constants.
var ErrUnauthorized = errors.New("unauthorized")
