package apps

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// fakeRepo is the minimal RepoLike implementation the refresh tests
// need. The production type is apps.App, which carries far more state
// than the contract requires — the interface lets the test stay focused.
type fakeRepo struct {
	name   string
	path   string
	exists bool
}

func (r fakeRepo) Name() string { return r.name }
func (r fakeRepo) Path() string { return r.path }
func (r fakeRepo) Exists() bool { return r.exists }

// writeFile is a fatal-on-error helper that mkdir-p's the parent dir
// before writing. Mirrors the symbol package test helper to keep the
// test feel consistent across packages.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// findProfile returns the profile with the given Name, or nil. The
// LoadProfiles return order is map-iteration-undefined, so every test
// looks up by name rather than indexing.
func findProfile(profiles []RepoProfile, name string) *RepoProfile {
	for i := range profiles {
		if profiles[i].Name == name {
			return &profiles[i]
		}
	}
	return nil
}

func TestLoadProfiles_MissingFileReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	got := LoadProfiles(dir)
	if got != nil && len(got) != 0 {
		t.Fatalf("LoadProfiles on empty dir = %v, want empty", got)
	}
}

func TestLoadProfiles_MalformedFileReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	// Garbage at the cache path must NOT crash subsequent reads — a
	// half-written legacy file would otherwise strand the operator.
	writeFile(t, filepath.Join(dir, ".bridge-state", "repo-profiles.json"), "{not json")
	got := LoadProfiles(dir)
	if len(got) != 0 {
		t.Fatalf("LoadProfiles on garbage file = %v, want empty", got)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	in := []RepoProfile{
		{
			Name:        "alpha",
			Path:        "/tmp/alpha",
			Summary:     "alpha summary",
			Stack:       []string{"next", "typescript"},
			Features:    []string{"auth"},
			Entrypoints: []string{"app/**/*.tsx"},
			RefreshedAt: "2026-01-01T00:00:00.000000000Z",
		},
		{
			Name:        "beta",
			Path:        "/tmp/beta",
			Summary:     "beta summary",
			Stack:       []string{"go"},
			Features:    []string{},
			Entrypoints: []string{"**/*.go"},
			RefreshedAt: "2026-01-02T00:00:00.000000000Z",
		},
	}
	if err := SaveProfiles(dir, in); err != nil {
		t.Fatalf("SaveProfiles: %v", err)
	}
	out := LoadProfiles(dir)
	if len(out) != len(in) {
		t.Fatalf("got %d profiles, want %d", len(out), len(in))
	}

	for _, want := range in {
		got := findProfile(out, want.Name)
		if got == nil {
			t.Fatalf("missing profile %q after round-trip", want.Name)
		}
		if got.Summary != want.Summary {
			t.Errorf("%s.Summary = %q, want %q", want.Name, got.Summary, want.Summary)
		}
		if !equalStringSlice(got.Stack, want.Stack) {
			t.Errorf("%s.Stack = %v, want %v", want.Name, got.Stack, want.Stack)
		}
		if !equalStringSlice(got.Entrypoints, want.Entrypoints) {
			t.Errorf("%s.Entrypoints = %v, want %v", want.Name, got.Entrypoints, want.Entrypoints)
		}
	}
}

func TestSaveProfiles_AtomicWriteCreatesStateDir(t *testing.T) {
	// Bare temp dir — no `.bridge-state/` yet. SaveProfiles must mkdir
	// the parent before writing; if it doesn't, the rename fails on
	// every fresh-checkout operator.
	dir := t.TempDir()
	if err := SaveProfiles(dir, []RepoProfile{{Name: "x"}}); err != nil {
		t.Fatalf("SaveProfiles into bare dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".bridge-state", "repo-profiles.json")); err != nil {
		t.Fatalf("expected cache file to exist after Save: %v", err)
	}
}

func TestProfilesFileExists(t *testing.T) {
	dir := t.TempDir()
	if ProfilesFileExists(dir) {
		t.Fatalf("ProfilesFileExists on empty dir = true, want false")
	}
	if err := SaveProfiles(dir, nil); err != nil {
		t.Fatalf("SaveProfiles: %v", err)
	}
	if !ProfilesFileExists(dir) {
		t.Fatalf("ProfilesFileExists after Save = false, want true")
	}
}

func TestDetectRepoProfile_NodeNextProject(t *testing.T) {
	repo := t.TempDir()
	writeFile(t, filepath.Join(repo, "package.json"), `{
  "name": "my-next-app",
  "description": "demo Next app",
  "dependencies": {
    "next": "^14",
    "react": "^18",
    "tailwindcss": "^3",
    "@anthropic-ai/sdk": "^0.20"
  },
  "devDependencies": {
    "typescript": "^5"
  }
}`)
	writeFile(t, filepath.Join(repo, "tsconfig.json"), "{}")
	// app/ presence triggers routerApp -> app/* entrypoints.
	if err := os.MkdirAll(filepath.Join(repo, "app"), 0o755); err != nil {
		t.Fatalf("mkdir app: %v", err)
	}
	writeFile(t, filepath.Join(repo, "README.md"), "# my-next-app\n\nA Next.js demo for the bridge.\n")

	got := DetectRepoProfile("my-next-app", repo)

	if got.Name != "my-next-app" {
		t.Errorf("Name = %q, want my-next-app", got.Name)
	}
	if got.Path != repo {
		t.Errorf("Path = %q, want %q", got.Path, repo)
	}
	if !contains(got.Stack, "next") {
		t.Errorf("Stack missing 'next': %v", got.Stack)
	}
	// react should be omitted when next is present (TS port behavior).
	if contains(got.Stack, "react") {
		t.Errorf("Stack should omit 'react' when 'next' is present: %v", got.Stack)
	}
	if !contains(got.Stack, "tailwindcss") {
		t.Errorf("Stack missing 'tailwindcss': %v", got.Stack)
	}
	if !contains(got.Stack, "anthropic-sdk") {
		t.Errorf("Stack missing 'anthropic-sdk': %v", got.Stack)
	}
	if !contains(got.Stack, "typescript") {
		t.Errorf("Stack missing 'typescript': %v", got.Stack)
	}
	// Router app + next -> app/api/**/*.ts entrypoint.
	if !contains(got.Entrypoints, "app/api/**/*.ts") {
		t.Errorf("Entrypoints missing app/api/**/*.ts: %v", got.Entrypoints)
	}
	if got.Summary == "" {
		t.Errorf("Summary should not be empty")
	}
	if !strings.Contains(got.Summary, "my-next-app") {
		t.Errorf("Summary should reference repo heading: %q", got.Summary)
	}
	if got.RefreshedAt == "" {
		t.Errorf("RefreshedAt should not be empty")
	}
}

func TestDetectRepoProfile_GoProject(t *testing.T) {
	repo := t.TempDir()
	writeFile(t, filepath.Join(repo, "go.mod"), "module example.com/foo\n\ngo 1.22\n")
	// CLAUDE.md wins over README + synthesized summary.
	writeFile(t, filepath.Join(repo, "CLAUDE.md"), "# foo\n\nGo orchestration daemon for the bridge.\n")

	got := DetectRepoProfile("foo", repo)

	if !contains(got.Stack, "go") {
		t.Errorf("Stack missing 'go': %v", got.Stack)
	}
	if !contains(got.Entrypoints, "**/*.go") {
		t.Errorf("Entrypoints missing **/*.go: %v", got.Entrypoints)
	}
	// "orchestration" feature should fire on the bridge/orchestration keywords.
	if !contains(got.Features, "orchestration") {
		t.Errorf("Features missing 'orchestration' (matched on summary): %v", got.Features)
	}
	if !strings.Contains(got.Summary, "Go orchestration daemon") {
		t.Errorf("Summary did not pick CLAUDE.md intro: %q", got.Summary)
	}
}

func TestDetectRepoProfile_BareRepoFallsBackToSynthesizedSummary(t *testing.T) {
	repo := t.TempDir()
	got := DetectRepoProfile("ghost", repo)
	if got.Summary == "" {
		t.Errorf("Summary should always be populated, even for bare repos")
	}
	if !strings.Contains(got.Summary, "ghost") {
		t.Errorf("Synthesized summary should include repo name: %q", got.Summary)
	}
}

func TestDetectRepoProfile_NestProject(t *testing.T) {
	// NestJS gets its own entrypoint pattern set — verify we surface it
	// instead of the generic TypeScript fallback.
	repo := t.TempDir()
	writeFile(t, filepath.Join(repo, "package.json"), `{
  "name": "api",
  "dependencies": {"@nestjs/core": "^10"},
  "devDependencies": {"typescript": "^5"}
}`)
	got := DetectRepoProfile("api", repo)
	if !contains(got.Stack, "nestjs") {
		t.Errorf("Stack missing 'nestjs': %v", got.Stack)
	}
	if !contains(got.Entrypoints, "src/**/*.controller.ts") {
		t.Errorf("Entrypoints missing nest controller glob: %v", got.Entrypoints)
	}
}

func TestRefreshProfiles_NodeAndGoMix(t *testing.T) {
	bridgeRoot := t.TempDir()
	nodeRepo := t.TempDir()
	goRepo := t.TempDir()
	missingRepo := filepath.Join(t.TempDir(), "never-cloned")

	writeFile(t, filepath.Join(nodeRepo, "package.json"), `{
  "name": "n",
  "dependencies": {"next": "^14"}
}`)
	writeFile(t, filepath.Join(goRepo, "go.mod"), "module example.com/g\n\ngo 1.22\n")

	repos := []RepoLike{
		fakeRepo{name: "node-app", path: nodeRepo, exists: true},
		fakeRepo{name: "go-app", path: goRepo, exists: true},
		// Repo that has Exists()==false must be SKIPPED, not blow up.
		fakeRepo{name: "ghost", path: missingRepo, exists: false},
	}

	got, err := RefreshProfiles(bridgeRoot, repos)
	if err != nil {
		t.Fatalf("RefreshProfiles: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d profiles, want 2 (ghost should be skipped)", len(got))
	}
	if p := findProfile(got, "node-app"); p == nil || !contains(p.Stack, "next") {
		t.Errorf("node-app missing or no 'next' in stack: %+v", p)
	}
	if p := findProfile(got, "go-app"); p == nil || !contains(p.Stack, "go") {
		t.Errorf("go-app missing or no 'go' in stack: %+v", p)
	}

	// Persisted to disk + loadable on a subsequent call.
	loaded := LoadProfiles(bridgeRoot)
	if len(loaded) != 2 {
		t.Fatalf("LoadProfiles after refresh = %d, want 2", len(loaded))
	}
}

func TestRefreshProfiles_PreservesMissingReposFromCache(t *testing.T) {
	// Operator's USB drive mid-session: the missing repo's cached
	// profile must survive an explicit refresh that no longer sees it.
	bridgeRoot := t.TempDir()
	nodeRepo := t.TempDir()
	writeFile(t, filepath.Join(nodeRepo, "package.json"), `{"name":"n","dependencies":{"next":"^14"}}`)

	// Seed the cache with a profile for a repo that's NOT in the
	// refresh batch and whose Exists() returns false.
	seed := []RepoProfile{
		{Name: "old-cached", Summary: "stays put", Stack: []string{"react"}, RefreshedAt: "2025-01-01T00:00:00Z"},
	}
	if err := SaveProfiles(bridgeRoot, seed); err != nil {
		t.Fatalf("seed SaveProfiles: %v", err)
	}

	got, err := RefreshProfiles(bridgeRoot, []RepoLike{
		fakeRepo{name: "node-app", path: nodeRepo, exists: true},
	})
	if err != nil {
		t.Fatalf("RefreshProfiles: %v", err)
	}
	if findProfile(got, "old-cached") == nil {
		t.Errorf("old-cached profile evicted; should survive an unrelated refresh")
	}
	if findProfile(got, "node-app") == nil {
		t.Errorf("node-app missing from refreshed slice")
	}
}

func TestExtractMarkdownIntro(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "heading + paragraph",
			in:   "# Title\n\nFirst paragraph.\n",
			want: "Title — First paragraph.",
		},
		{
			name: "heading only",
			in:   "# Just a title\n",
			want: "Just a title",
		},
		{
			name: "skips fenced code",
			in:   "# T\n\n```go\nfunc x() {}\n```\nReal text.\n",
			want: "T — Real text.",
		},
		{
			name: "skips blockquote",
			in:   "# T\n\n> a quote\nReal.\n",
			want: "T — Real.",
		},
		{
			name: "empty input",
			in:   "",
			want: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := extractMarkdownIntro(c.in); got != c.want {
				t.Errorf("extractMarkdownIntro(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

// equalStringSlice compares two slices of strings ignoring order. The
// production map round-trip doesn't preserve insertion order, so tests
// that assert on a slice produced by Load have to be order-tolerant.
func equalStringSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	ac := append([]string{}, a...)
	bc := append([]string{}, b...)
	sort.Strings(ac)
	sort.Strings(bc)
	for i := range ac {
		if ac[i] != bc[i] {
			return false
		}
	}
	return true
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
