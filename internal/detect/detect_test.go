package detect_test

// Focused tests for the detect package — one file rather than a
// per-source split because every test reads multiple modules' state
// (tokenizer + heuristic + render share fixtures, cache round-trips
// both meta + detect).

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/detect"
	"github.com/stop1love1/claude-bridge/internal/meta"
)

// ---------- tokenize ----------

func TestStripDiacritics_Vietnamese(t *testing.T) {
	cases := map[string]string{
		"khóa học":         "khoa hoc",
		"đăng nhập":        "dang nhap",
		"ĐĂNG KÝ":          "DANG KY",
		"Học viên":         "Hoc vien",
		"Bài kiểm tra":     "Bai kiem tra",
		"không có gì":      "khong co gi",
		"naïve façade café": "naive facade cafe",
		"":                 "",
		"ascii only":       "ascii only", // fast path
	}
	for in, want := range cases {
		if got := detect.StripDiacritics(in); got != want {
			t.Errorf("StripDiacritics(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTokenize_FiltersStopwordsAndShorts(t *testing.T) {
	tokens := detect.Tokenize("Add the login page to the auth module 12 abc")
	// "add", "the", "page" are stopwords; "12" is pure-digit; "abc"
	// is short-but-≥3 (kept). Order is encounter-order.
	want := []string{"login", "auth", "module", "abc"}
	if !equalStringSlices(tokens, want) {
		t.Errorf("Tokenize = %v, want %v", tokens, want)
	}
}

func TestTokenize_VietnameseFolding(t *testing.T) {
	tokens := detect.Tokenize("Thêm trang đăng nhập cho khóa học")
	// "them" (action verb), "trang" (programming meta) are stopwords;
	// "cho" is a Vietnamese filler. So "dang", "nhap", "khoa", "hoc"
	// should all survive. Order matches the input.
	want := []string{"dang", "nhap", "khoa", "hoc"}
	if !equalStringSlices(tokens, want) {
		t.Errorf("Tokenize VI = %v, want %v", tokens, want)
	}
}

func TestTokenize_DedupesAndEmpty(t *testing.T) {
	if got := detect.Tokenize(""); got != nil {
		t.Errorf("Tokenize(\"\") = %v, want nil", got)
	}
	tokens := detect.Tokenize("login Login LOGIN api  api---api")
	want := []string{"login", "api"}
	if !equalStringSlices(tokens, want) {
		t.Errorf("Tokenize dedupe = %v, want %v", tokens, want)
	}
}

func TestCountMatches_DiacriticInsensitive(t *testing.T) {
	if got := detect.CountMatches("Thêm khóa học mới và khoa hoc nâng cao", "khoa hoc"); got != 2 {
		t.Errorf("CountMatches bilingual = %d, want 2", got)
	}
	if got := detect.CountMatches("anything", ""); got != 0 {
		t.Errorf("CountMatches empty needle = %d, want 0", got)
	}
}

func TestBigrams(t *testing.T) {
	got := detect.Bigrams([]string{"a", "b", "c"})
	want := []string{"a b", "b c"}
	if !equalStringSlices(got, want) {
		t.Errorf("Bigrams = %v, want %v", got, want)
	}
	if got := detect.Bigrams([]string{"x"}); got != nil {
		t.Errorf("Bigrams(short) = %v, want nil", got)
	}
}

// ---------- heuristic ----------

// fakeApps builds a minimal apps + profiles + capabilities set for
// the heuristic tests. Two repos: "edusoft-fe" (Next.js + LMS) and
// "edusoft-api" (NestJS + Prisma). Mirrors the real bridge layout
// closely enough that scoring matches a representative production
// task.
func fakeApps() ([]apps.App, map[string]apps.RepoProfile, map[string][]string) {
	appsList := []apps.App{
		{Name: "edusoft-fe", Path: "../edusoft-fe"},
		{Name: "edusoft-api", Path: "../edusoft-api"},
	}
	profiles := map[string]apps.RepoProfile{
		"edusoft-fe": {
			Name:        "edusoft-fe",
			Summary:     "Edusoft frontend — Next.js + Tailwind LMS portal",
			Stack:       []string{"next", "tailwindcss", "typescript"},
			Features:    []string{"lms", "auth"},
			Entrypoints: []string{"app/**/*.tsx"},
		},
		"edusoft-api": {
			Name:        "edusoft-api",
			Summary:     "Edusoft API — NestJS + Prisma backend for LMS",
			Stack:       []string{"nestjs", "prisma", "typescript"},
			Features:    []string{"lms", "auth"},
			Entrypoints: []string{"src/**/*.controller.ts"},
		},
	}
	caps := map[string][]string{
		"edusoft-fe":  {"lms.course", "auth.login"},
		"edusoft-api": {"lms.course", "auth.login", "lms.lesson"},
	}
	return appsList, profiles, caps
}

func TestDetect_FrontendWinsOnUITask(t *testing.T) {
	_, profiles, caps := fakeApps()
	scope := detect.Detect(detect.DetectInput{
		TaskBody:     "Add the login page to the LMS portal — new React component with Tailwind styling",
		TaskTitle:    "login page",
		Repos:        []string{"edusoft-fe", "edusoft-api"},
		Profiles:     profiles,
		Capabilities: caps,
	})

	if scope.Source != detect.SourceHeuristic {
		t.Errorf("Source = %q, want heuristic", scope.Source)
	}
	if len(scope.Repos) == 0 {
		t.Fatalf("expected ≥ 1 repo match, got none. scope=%+v", scope)
	}
	if scope.Repos[0].Name != "edusoft-fe" {
		t.Errorf("Repos[0] = %q, want edusoft-fe (full ranking: %+v)", scope.Repos[0].Name, scope.Repos)
	}
	// auth.login must surface as a feature — both the trigger word
	// "login" and the declared capability hit.
	if !containsString(scope.Features, "auth.login") {
		t.Errorf("Features missing auth.login: %v", scope.Features)
	}
}

func TestDetect_BackendWinsOnAPITask(t *testing.T) {
	_, profiles, caps := fakeApps()
	scope := detect.Detect(detect.DetectInput{
		TaskBody: "Add a new /api/courses endpoint — Prisma migration + NestJS controller, JWT auth required.",
		Repos:    []string{"edusoft-fe", "edusoft-api"},
		Profiles: profiles,
		Capabilities: caps,
	})

	if len(scope.Repos) == 0 {
		t.Fatalf("expected ≥ 1 repo match, got none")
	}
	if scope.Repos[0].Name != "edusoft-api" {
		t.Errorf("Repos[0] = %q, want edusoft-api (ranking: %+v)", scope.Repos[0].Name, scope.Repos)
	}
}

func TestDetect_BilingualVietnameseTask(t *testing.T) {
	_, profiles, caps := fakeApps()
	scope := detect.Detect(detect.DetectInput{
		TaskBody: "Thêm trang đăng nhập cho khóa học",
		Repos:    []string{"edusoft-fe", "edusoft-api"},
		Profiles: profiles,
		Capabilities: caps,
	})
	if !containsString(scope.Features, "auth.login") {
		t.Errorf("VI: Features missing auth.login: %v", scope.Features)
	}
	if !containsString(scope.Features, "lms.course") {
		t.Errorf("VI: Features missing lms.course: %v", scope.Features)
	}
	if !containsString(scope.Entities, "course") {
		t.Errorf("VI: Entities missing course: %v", scope.Entities)
	}
}

func TestDetect_PinnedRepoOverridesScoring(t *testing.T) {
	_, profiles, caps := fakeApps()
	// API-shaped task body, but operator pinned the FE repo.
	scope := detect.Detect(detect.DetectInput{
		TaskBody:     "Wire up a new NestJS controller for /api/courses",
		Repos:        []string{"edusoft-fe", "edusoft-api"},
		PinnedRepo:   "edusoft-fe",
		Profiles:     profiles,
		Capabilities: caps,
	})
	if scope.Source != detect.SourceUserPinned {
		t.Errorf("Source = %q, want user-pinned", scope.Source)
	}
	if scope.Confidence != detect.ConfidenceHigh {
		t.Errorf("Confidence = %q, want high (pinned repos always high)", scope.Confidence)
	}
	if len(scope.Repos) == 0 || scope.Repos[0].Name != "edusoft-fe" {
		t.Errorf("Repos[0] = %v, want edusoft-fe at top", scope.Repos)
	}
}

func TestDetect_EmptyInputReturnsLowConfidence(t *testing.T) {
	scope := detect.Detect(detect.DetectInput{TaskBody: "", Repos: []string{"foo"}})
	if scope.Confidence != detect.ConfidenceLow {
		t.Errorf("Confidence = %q, want low", scope.Confidence)
	}
	if len(scope.Repos) != 0 {
		t.Errorf("Repos = %v, want empty", scope.Repos)
	}
}

func TestDetect_FilesExtractedFromBody(t *testing.T) {
	scope := detect.Detect(detect.DetectInput{
		TaskBody: "Update libs/detect/heuristic.ts and src/auth/login.tsx — also bump to 2.0.1.",
		Repos:    []string{"edusoft-fe"},
	})
	// "2.0.1" must be filtered as version-like.
	for _, f := range scope.Files {
		if strings.HasPrefix(f, "2.") {
			t.Errorf("Files contains version-like %q: %v", f, scope.Files)
		}
	}
	if !containsString(scope.Files, "libs/detect/heuristic.ts") {
		t.Errorf("Files missing libs/detect/heuristic.ts: %v", scope.Files)
	}
	if !containsString(scope.Files, "src/auth/login.tsx") {
		t.Errorf("Files missing src/auth/login.tsx: %v", scope.Files)
	}
}

// ---------- render ----------

func TestRender_ShapeAndSections(t *testing.T) {
	scope := detect.DetectedScope{
		Repos: []detect.RepoMatch{
			{Name: "edusoft-fe", Score: 5, Reason: "stack:next×3"},
		},
		Features:   []string{"auth.login"},
		Entities:   []string{"user"},
		Files:      []string{"app/login/page.tsx"},
		Confidence: detect.ConfidenceMedium,
		Source:     detect.SourceHeuristic,
		DetectedAt: "2026-05-02T00:00:00Z",
		Reason:     "heuristic top: stack:next×3",
	}
	out := detect.Render(scope, detect.RenderOptions{})
	wantSubstrings := []string{
		"## Detected scope",
		"- Source: `heuristic`",
		"- Confidence: `medium`",
		"### Repos (in priority order)",
		"**`edusoft-fe`** (score 5)",
		"### Features",
		"`auth.login`",
		"### Entities",
		"`user`",
		"### Files mentioned",
		"`app/login/page.tsx`",
	}
	for _, s := range wantSubstrings {
		if !strings.Contains(out, s) {
			t.Errorf("Render output missing %q\n--- got ---\n%s", s, out)
		}
	}
	// Coordinator footer absent unless ForCoordinator is true.
	if strings.Contains(out, "Treat the top repo as a starting recommendation") {
		t.Errorf("unexpected coordinator footer in non-coordinator render:\n%s", out)
	}
}

func TestRender_EmptyReposShowsFallback(t *testing.T) {
	out := detect.Render(detect.DetectedScope{
		Confidence: detect.ConfidenceLow,
		Source:     detect.SourceHeuristic,
		Reason:     "no signal",
	}, detect.RenderOptions{})
	if !strings.Contains(out, "no candidate repo scored above zero") {
		t.Errorf("expected empty-repos fallback message\n--- got ---\n%s", out)
	}
}

func TestRender_CoordinatorFooterAndProfiles(t *testing.T) {
	_, profiles, _ := fakeApps()
	out := detect.Render(detect.DetectedScope{
		Source:     detect.SourceHeuristic,
		Confidence: detect.ConfidenceLow,
	}, detect.RenderOptions{
		ForCoordinator: true,
		Profiles:       profiles,
	})
	if !strings.Contains(out, "Treat the top repo as a starting recommendation") {
		t.Errorf("expected coordinator footer\n--- got ---\n%s", out)
	}
	if !strings.Contains(out, "### Repo profiles") {
		t.Errorf("expected ### Repo profiles section\n--- got ---\n%s", out)
	}
	if !strings.Contains(out, "**edusoft-api**") {
		t.Errorf("expected edusoft-api profile bullet\n--- got ---\n%s", out)
	}
}

// ---------- cache ----------

// newCacheTaskDir creates a fresh task dir + initial meta so the cache
// helpers have something to attach to. Returns the absolute dir path.
func newCacheTaskDir(t *testing.T) string {
	t.Helper()
	meta.ResetCacheForTests()
	dir := filepath.Join(t.TempDir(), "t_20260502_001")
	if err := meta.CreateMeta(dir, meta.Meta{
		TaskID:      "t_20260502_001",
		TaskTitle:   "test",
		TaskBody:    "Add a login page to the LMS portal.",
		TaskStatus:  meta.TaskStatusTodo,
		TaskSection: meta.SectionTodo,
		CreatedAt:   "2026-05-02T00:00:00.000Z",
	}); err != nil {
		t.Fatalf("CreateMeta: %v", err)
	}
	return dir
}

func TestCache_RoundTrip(t *testing.T) {
	dir := newCacheTaskDir(t)

	// Initial read — no cache attached, expect (nil, nil).
	got, err := detect.ReadScopeCache(dir)
	if err != nil {
		t.Fatalf("ReadScopeCache: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil cache on fresh task, got %+v", got)
	}

	scope := detect.DetectedScope{
		Repos: []detect.RepoMatch{
			{Name: "edusoft-fe", Score: 7, Reason: "stack:next×3"},
		},
		Features:   []string{"auth.login"},
		Entities:   []string{"user"},
		Files:      []string{"app/login/page.tsx"},
		Confidence: detect.ConfidenceMedium,
		Source:     detect.SourceHeuristic,
		DetectedAt: "2026-05-02T00:00:00Z",
		Reason:     "test",
	}
	if err := detect.WriteScope(dir, scope); err != nil {
		t.Fatalf("WriteScope: %v", err)
	}

	got, err = detect.ReadScopeCache(dir)
	if err != nil {
		t.Fatalf("ReadScopeCache after write: %v", err)
	}
	if got == nil {
		t.Fatal("expected cached scope, got nil")
	}
	if got.Repos[0].Name != "edusoft-fe" || got.Confidence != detect.ConfidenceMedium {
		t.Errorf("round-trip mismatch: %+v", got)
	}

	// Verify the on-disk shape is the {taskBodyHash, scope} envelope —
	// not the bare scope. A future LLM reader / Next.js reader depends
	// on this.
	m, err := meta.ReadMeta(dir)
	if err != nil || m == nil {
		t.Fatalf("ReadMeta: %v / %v", err, m)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(m.DetectedScope, &envelope); err != nil {
		t.Fatalf("envelope unmarshal: %v", err)
	}
	if _, ok := envelope["taskBodyHash"]; !ok {
		t.Errorf("envelope missing taskBodyHash: %s", string(m.DetectedScope))
	}
	if _, ok := envelope["scope"]; !ok {
		t.Errorf("envelope missing scope: %s", string(m.DetectedScope))
	}
}

func TestCache_StaleHashTreatedAsMiss(t *testing.T) {
	dir := newCacheTaskDir(t)
	if err := detect.WriteScope(dir, detect.DetectedScope{
		Confidence: detect.ConfidenceMedium,
		Source:     detect.SourceHeuristic,
		DetectedAt: "2026-05-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("WriteScope: %v", err)
	}

	// Edit the task body out from under the cache.
	meta.ResetCacheForTests()
	m, err := meta.ReadMeta(dir)
	if err != nil || m == nil {
		t.Fatalf("ReadMeta: %v / %v", err, m)
	}
	m.TaskBody = "completely different body"
	if err := meta.WriteMeta(dir, m); err != nil {
		t.Fatalf("WriteMeta: %v", err)
	}

	got, err := detect.ReadScopeCache(dir)
	if err != nil {
		t.Fatalf("ReadScopeCache after body edit: %v", err)
	}
	if got != nil {
		t.Errorf("expected stale cache treated as miss, got %+v", got)
	}
}

func TestCache_ClearScopeCache(t *testing.T) {
	dir := newCacheTaskDir(t)
	if err := detect.WriteScope(dir, detect.DetectedScope{Source: detect.SourceHeuristic}); err != nil {
		t.Fatalf("WriteScope: %v", err)
	}
	if err := detect.ClearScopeCache(dir); err != nil {
		t.Fatalf("ClearScopeCache: %v", err)
	}
	got, err := detect.ReadScopeCache(dir)
	if err != nil {
		t.Fatalf("ReadScopeCache after clear: %v", err)
	}
	if got != nil {
		t.Errorf("expected cache cleared, got %+v", got)
	}
}

// ---------- top-level orchestration ----------

func TestLoadInput_FromAppsRoster(t *testing.T) {
	appsList, profiles, _ := fakeApps()
	// Attach declared capabilities via the App's Extras (the production
	// shape — bridge.json's `capabilities` field round-trips through
	// Extras until the verify-chain port wires it as a typed field).
	appsList[0].Extras = map[string]json.RawMessage{
		"capabilities": json.RawMessage(`["lms.course","auth.login"]`),
	}

	in := detect.LoadInput(detect.InputOptions{
		TaskBody: "Add a login page",
		AppList:  appsList,
		Profiles: profiles,
	})
	if !containsString(in.Repos, "edusoft-fe") || !containsString(in.Repos, "edusoft-api") {
		t.Errorf("Repos missing apps: %v", in.Repos)
	}
	if got := in.Capabilities["edusoft-fe"]; !equalStringSlices(got, []string{"lms.course", "auth.login"}) {
		t.Errorf("Capabilities[edusoft-fe] = %v, want lms.course/auth.login from Extras", got)
	}
}

func TestDetector_GetOrComputeUsesCache(t *testing.T) {
	dir := newCacheTaskDir(t)
	_, profiles, caps := fakeApps()

	calls := 0
	build := func() detect.DetectInput {
		calls++
		return detect.DetectInput{
			TaskBody:     "Add a login page UI component to the LMS portal — Tailwind styling on the React form.",
			Repos:        []string{"edusoft-fe", "edusoft-api"},
			Profiles:     profiles,
			Capabilities: caps,
		}
	}

	d := detect.Default()
	first, err := d.GetOrCompute(dir, build)
	if err != nil {
		t.Fatalf("GetOrCompute miss: %v", err)
	}
	if first.Repos[0].Name != "edusoft-fe" {
		t.Errorf("first.Repos[0] = %q, want edusoft-fe", first.Repos[0].Name)
	}
	if calls != 1 {
		t.Errorf("expected inputBuilder called once on cache miss, got %d", calls)
	}

	// Second call should hit the cache and NOT invoke the builder
	// (the heuristic is cheap, but the inputBuilder may walk the apps
	// roster + load profiles — that's the cost the cache exists to
	// elide).
	second, err := d.GetOrCompute(dir, build)
	if err != nil {
		t.Fatalf("GetOrCompute hit: %v", err)
	}
	if second.Repos[0].Name != first.Repos[0].Name {
		t.Errorf("cache hit returned different repo: %v", second.Repos)
	}
	if calls != 1 {
		t.Errorf("expected inputBuilder NOT called on cache hit, got %d total calls", calls)
	}
}

func TestDetector_RefreshClearsAndRecomputes(t *testing.T) {
	dir := newCacheTaskDir(t)
	_, profiles, caps := fakeApps()
	build := func() detect.DetectInput {
		return detect.DetectInput{
			TaskBody:     "Add a login page UI component to the LMS portal — Tailwind styling on the React form.",
			Repos:        []string{"edusoft-fe", "edusoft-api"},
			Profiles:     profiles,
			Capabilities: caps,
		}
	}

	d := detect.Default()
	if _, err := d.GetOrCompute(dir, build); err != nil {
		t.Fatalf("seed: %v", err)
	}
	got, err := d.Refresh(dir, build)
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if got.Repos[0].Name != "edusoft-fe" {
		t.Errorf("Refresh result Repos[0] = %q, want edusoft-fe", got.Repos[0].Name)
	}
}

// ---------- helpers ----------

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsString(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
