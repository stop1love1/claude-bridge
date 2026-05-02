package spawn_test

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stop1love1/claude-bridge/internal/sessions"
	"github.com/stop1love1/claude-bridge/internal/spawn"
)

// buildFakeClaude compiles test/fixtures/fake-claude into a temp
// directory once per test binary and caches the result. The fake binary
// stands in for the real claude CLI so tests can assert spawn-engine
// behavior (session id capture, stdout-to-log routing, kill cleanup)
// without depending on a real model API.
var (
	fakeOnce sync.Once
	fakePath string
	fakeErr  error
)

func fakeClaudeBinary(t *testing.T) string {
	t.Helper()
	fakeOnce.Do(func() {
		_, thisFile, _, ok := runtime.Caller(0)
		if !ok {
			fakeErr = errors.New("cannot resolve test source path")
			return
		}
		repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..")
		src := filepath.Join(repoRoot, "test", "fixtures", "fake-claude")
		out := filepath.Join(t.TempDir(), "fake-claude.exe")
		cmd := exec.Command("go", "build", "-o", out, ".")
		cmd.Dir = src
		if data, err := cmd.CombinedOutput(); err != nil {
			fakeErr = errors.New("build fake-claude: " + err.Error() + ": " + string(data))
			return
		}
		fakePath = out
	})
	if fakeErr != nil {
		t.Fatalf("fake-claude unavailable: %v", fakeErr)
	}
	return fakePath
}

// newSpawnerForTest constructs a Spawner pointing at the freshly built
// fake-claude with a private registry + a private events bus so tests
// don't pollute the package globals.
func newSpawnerForTest(t *testing.T) (*spawn.Spawner, *sessions.EventsRegistry) {
	t.Helper()
	bin := fakeClaudeBinary(t)
	events := sessions.NewEventsRegistry()
	return &spawn.Spawner{
		BinaryPath: bin,
		Registry:   spawn.NewRegistry(),
		Events:     events,
		LogDir:     t.TempDir(),
	}, events
}

func TestSpawnFreeSessionWritesStdoutToLogAndReportsExitCode(t *testing.T) {
	sp, events := newSpawnerForTest(t)
	// fake-claude doesn't honor real claude flags; --session is its own
	// switch so the test asserts the bridge captured the right id.
	sess, err := sp.SpawnFreeSession(t.TempDir(), "ignored prompt", nil, "", "11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if sess.SessionID != "11111111-1111-4111-8111-111111111111" {
		t.Errorf("SessionID: got %q, want pre-allocated uuid", sess.SessionID)
	}

	// fake-claude exits ~immediately. Wait for done; bound the wait to
	// keep a hung child from hanging the suite.
	select {
	case <-sess.Done:
	case <-time.After(5 * time.Second):
		t.Fatal("fake-claude did not exit within 5s")
	}

	if code := sess.Cmd.ProcessState.ExitCode(); code != 0 {
		t.Errorf("exit code: got %d, want 0", code)
	}
	// Log file should contain the fake's two stdout lines. fake-claude
	// uses its OWN --session default ("abc-123") regardless of what
	// the bridge passed via --session-id, since it doesn't parse that
	// flag — that's fine for the log-capture assertion.
	body, err := os.ReadFile(sess.LogPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if !strings.Contains(string(body), "session: ") || !strings.Contains(string(body), "hello") {
		t.Errorf("log missing fake-claude stdout: %q", string(body))
	}

	// Alive flag should have flipped true at start and false at exit.
	if events.IsAlive(sess.SessionID) {
		t.Error("expected alive=false after exit")
	}
}

func TestSpawnNonZeroExitSurfacesViaWaitEarlyFailure(t *testing.T) {
	sp, _ := newSpawnerForTest(t)
	// Use SpawnClaude with an opts that points at a fake-claude with
	// --exit-code 1. We can't pass extra flags through the bridge args
	// (the bridge only emits --session-id / --settings / etc. not
	// --exit-code), so this test directly invokes fake-claude via the
	// spawn engine's runWithStdin shim. Easier path: re-point
	// BinaryPath at a wrapper script — but for cross-platform we just
	// re-exec the fake binary with an env var the fake honors.
	//
	// Simpler still: invoke fake-claude with a CLI flag that survives
	// the bridge's arg list. The bridge passes `--session-id <uuid>
	// --settings? --output-format stream-json --verbose
	// --include-partial-messages -p`. fake-claude only parses
	// --session, --exit-code, --sleep — every other arg is silently
	// ignored. To inject --exit-code we'd need a wrapper.
	//
	// Instead we use Spawner.BinaryPath set to a tiny shell that
	// forwards the args to fake-claude with --exit-code=1 prepended.
	// That keeps the test cross-platform via Go's exec rather than a
	// .sh / .bat split.
	wrapper := writeWrapperBinary(t, sp.BinaryPath, "--exit-code", "1")
	sp.BinaryPath = wrapper

	sess, err := sp.SpawnFreeSession(t.TempDir(), "ignored", nil, "", "")
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}

	tail := stderrTailFromRegistry(t, sp, sess.SessionID)
	failure := spawn.WaitEarlyFailure(sess, tail, 3*time.Second)
	if failure == nil {
		t.Fatal("expected early failure, got nil")
	}
	if failure.Code != 1 {
		t.Errorf("Code: got %d, want 1", failure.Code)
	}
}

func TestSpawnKillRemovesFromRegistryAndDropsAlive(t *testing.T) {
	sp, events := newSpawnerForTest(t)
	// Make the fake sleep so it's still running when we kill.
	wrapper := writeWrapperBinary(t, sp.BinaryPath, "--sleep", "10000")
	sp.BinaryPath = wrapper

	sess, err := sp.SpawnFreeSession(t.TempDir(), "", nil, "", "")
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if !events.IsAlive(sess.SessionID) {
		t.Fatal("expected alive=true immediately after spawn")
	}
	if sp.Registry.Len() != 1 {
		t.Fatalf("registry length: got %d, want 1", sp.Registry.Len())
	}

	// Kill should send SIGTERM (taskkill /T on Windows, killpg on POSIX).
	if !sp.Registry.Kill(sess.SessionID) {
		t.Fatal("Kill returned false for live session")
	}
	select {
	case <-sess.Done:
	case <-time.After(5 * time.Second):
		t.Fatal("child did not exit after kill within 5s")
	}
	// Wait goroutine drops the entry + flips alive=false.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if sp.Registry.Len() == 0 && !events.IsAlive(sess.SessionID) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Errorf("registry/alive not cleaned up: registry=%d alive=%v", sp.Registry.Len(), events.IsAlive(sess.SessionID))
}

func TestSpawnKillReturnsFalseForUnknownSession(t *testing.T) {
	sp, _ := newSpawnerForTest(t)
	if sp.Registry.Kill("not-a-real-session") {
		t.Error("expected false for unknown session")
	}
}

func TestAutoApproveEnvOnlyForBypassMode(t *testing.T) {
	cases := []struct {
		mode string
		want []string
	}{
		{"", nil},
		{"default", nil},
		{"acceptEdits", nil},
		{"plan", nil},
		{"auto", nil},
		{"dontAsk", nil},
		{"bypassPermissions", []string{"BRIDGE_AUTO_APPROVE=1"}},
	}
	for _, tc := range cases {
		got := spawn.AutoApproveEnv(&spawn.ChatSettings{Mode: tc.mode})
		if (len(got) == 0 && len(tc.want) > 0) || (len(got) > 0 && len(tc.want) == 0) {
			t.Errorf("mode=%q: got %v, want %v", tc.mode, got, tc.want)
			continue
		}
		if len(got) > 0 && got[0] != tc.want[0] {
			t.Errorf("mode=%q: got %q, want %q", tc.mode, got[0], tc.want[0])
		}
	}
	// nil settings → no env entry.
	if got := spawn.AutoApproveEnv(nil); len(got) != 0 {
		t.Errorf("nil settings: got %v, want []", got)
	}
}

// stderrTailFromRegistry pokes inside the registry to grab the
// StderrTail for a session — needed because WaitEarlyFailure takes the
// tail handle separately (in production, the spawn route holds it).
// The test reaches in via a small accessor we add below.
func stderrTailFromRegistry(t *testing.T, sp *spawn.Spawner, sid string) *spawn.StderrTail {
	t.Helper()
	tail, ok := sp.Registry.StderrTail(sid)
	if !ok {
		t.Fatalf("no stderr tail for session %s", sid)
	}
	return tail
}

// writeWrapperBinary builds a tiny Go shim that exec's into target
// with extraArgs prepended. Used so tests can inject --exit-code /
// --sleep into fake-claude even though the spawn engine doesn't pass
// those flags directly. Cross-platform — no need for .sh / .bat.
func writeWrapperBinary(t *testing.T, target string, extraArgs ...string) string {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "main.go")
	body := `package main

import (
	"os"
	"os/exec"
	"strings"
)

func main() {
	target := ` + strconv.Quote(target) + `
	extra := strings.Split(` + strconv.Quote(strings.Join(extraArgs, "\x00")) + `, "\x00")
	args := append(extra, os.Args[1:]...)
	cmd := exec.Command(target, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		os.Exit(1)
	}
}
`
	if err := os.WriteFile(src, []byte(body), 0o644); err != nil {
		t.Fatalf("write wrapper src: %v", err)
	}
	out := filepath.Join(dir, "wrapper.exe")
	cmd := exec.Command("go", "build", "-o", out, src)
	if data, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build wrapper: %v: %s", err, string(data))
	}
	return out
}
