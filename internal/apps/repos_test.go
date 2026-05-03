package apps

import (
	"os"
	"path/filepath"
	"testing"
)

// writeBridgeJSONForReposTest drops a minimal bridge.json into root so
// the in-package Registry loads our test apps instead of inheriting
// whatever is in cwd.
func writeBridgeJSONForReposTest(t *testing.T, root, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "bridge.json"), []byte(body), 0o600); err != nil {
		t.Fatalf("write bridge.json: %v", err)
	}
}

func TestResolveCwd_RejectsBridgeFolderName(t *testing.T) {
	root := t.TempDir()
	bridgeName := filepath.Base(root)

	// Empty registry — no apps. Historically ResolveCwd matched
	// bridgeFolder name and returned root; that leaked bridge.json
	// + .uploads via /api/repos/{name}/raw.
	writeBridgeJSONForReposTest(t, root, `{"apps":[]}`)
	SetDefault(New(root))
	t.Cleanup(func() { SetDefault(nil) })

	if got, ok := ResolveCwd(root, bridgeName); ok {
		t.Fatalf("ResolveCwd(bridgeName=%q) = (%q,true), want (\"\",false) — bridge folder must not resolve", bridgeName, got)
	}
}

func TestResolveCwd_RejectsAppPointingAtBridgeRoot(t *testing.T) {
	root := t.TempDir()
	// Register an app whose path resolves to the bridge root itself.
	// The bug-fix path-equal check should reject this even if the
	// operator explicitly registers it — the apps registry must not
	// be a backdoor to the bridge folder.
	writeBridgeJSONForReposTest(t, root, `{"apps":[{"name":"trojan","path":"."}]}`)
	SetDefault(New(root))
	t.Cleanup(func() { SetDefault(nil) })

	if got, ok := ResolveCwd(root, "trojan"); ok {
		t.Fatalf("ResolveCwd registered-app-pointing-at-bridge-root = (%q,true), want (\"\",false)", got)
	}
}

func TestResolveCwd_LegitimateAppsResolve(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "bridge")
	sibling := filepath.Join(parent, "myapp")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir root: %v", err)
	}
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatalf("mkdir sibling: %v", err)
	}

	writeBridgeJSONForReposTest(t, root, `{"apps":[{"name":"myapp","path":"../myapp"}]}`)
	SetDefault(New(root))
	t.Cleanup(func() { SetDefault(nil) })

	got, ok := ResolveCwd(root, "myapp")
	if !ok {
		t.Fatalf("ResolveCwd(myapp) = (%q,false), want (sibling,true)", got)
	}
	want := filepath.Clean(sibling)
	if filepath.Clean(got) != want {
		// Allow case-insensitive match on Windows (TempDir may
		// return D:\… vs d:\…).
		if !pathsEqual(got, want) {
			t.Fatalf("ResolveCwd(myapp) = %q, want %q", got, want)
		}
	}
}

func TestResolveCwd_RejectsTraversal(t *testing.T) {
	root := t.TempDir()
	writeBridgeJSONForReposTest(t, root, `{"apps":[]}`)
	SetDefault(New(root))
	t.Cleanup(func() { SetDefault(nil) })

	for _, name := range []string{"../etc", "..\\windows", "/abs/path", `\\server\share`} {
		if got, ok := ResolveCwd(root, name); ok {
			t.Fatalf("ResolveCwd(%q) = (%q,true), want (\"\",false)", name, got)
		}
	}
}

func TestResolveCwd_EmptyName(t *testing.T) {
	root := t.TempDir()
	if got, ok := ResolveCwd(root, ""); ok {
		t.Fatalf("ResolveCwd(\"\") = (%q,true), want (\"\",false)", got)
	}
}
