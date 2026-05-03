package detect

// Heuristic detector — pure-function, no LLM call. The fast/cheap
// baseline; also the always-available fallback when the LLM impl
// (deferred) is disabled or errors. Go port of libs/detect/heuristic.ts.
//
// Pipeline:
//  1. Tokenize task body + title via the bilingual Tokenize.
//  2. Score each repo with two layers (same as the legacy
//     `repoHeuristic.suggestRepo`, now bilingual + tokenized):
//       a. Role-bucket keywords (frontend / backend / orchestration)
//          weighted against repos whose RepoProfile classifies them
//          into that role.
//       b. Profile boost — direct hits on the repo's own keywords +
//          stack tokens + features + DECLARED CAPABILITIES.
//  3. Detect features by intersecting tokenized task body with the
//     union of declared `app.capabilities` (when supplied) AND the
//     built-in bilingual feature vocab.
//  4. Detect entities (course / lesson / khoa hoc / hoc vien …) from
//     a small bilingual entity vocab.
//  5. Detect file references via a path-shaped regex on the original
//     (un-stripped) task text — paths shouldn't be normalized.
//
// Scoring stays a small integer (counts, not floats) so the numbers
// in the rendered prompt are easy to read.

import (
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/stop1love1/claude-bridge/internal/apps"
)

// role is the coarse FE / BE / orchestration bucket a repo falls into.
// Internal — callers consume the resolved DetectedScope, not the
// per-role machinery.
type role string

const (
	roleFrontend      role = "frontend"
	roleBackend       role = "backend"
	roleOrchestration role = "orchestration"
)

// roleKeywords is the bilingual role-bucket vocabulary. All keywords
// are stored in their post-StripDiacritics form so they can be
// matched directly against Tokenize output.
var roleKeywords = map[role][]string{
	roleFrontend: {
		// English
		"ui", "component", "page", "view", "frontend", "react", "vue",
		"svelte", "tailwind", "style", "button", "form", "modal", "screen",
		"client", "layout", "design", "css",
		// Vietnamese (post-strip)
		"giao", "dien", "man", "hinh", "trang", "bieu", "mau", "nut", "popup",
		"danh", "sach", "hien", "thi",
	},
	roleBackend: {
		// English. We deliberately keep these BACKEND-only — auth-related
		// words ("login"/"register") show up in the feature vocab instead,
		// because "login screen" is FE while "/auth/login endpoint" is BE
		// and the sentence verb / noun disambiguates.
		"api", "endpoint", "controller", "route", "migration", "entity",
		"repository", "service", "dto", "swagger", "prisma", "db",
		"database", "sql", "nestjs", "express", "fastify", "jwt",
		"schema", "model", "seed",
		// Vietnamese (post-strip). Same reason as above: omit "dang"/
		// "nhap"/"hoc" which are cross-cutting feature signals.
		"dich", "vu", "may", "chu", "lieu", "xac", "thuc", "quyen", "token",
	},
	roleOrchestration: {
		// English
		"bridge", "coordinator", "agent", "orchestrat", "dispatcher",
		"permission",
		// Vietnamese (post-strip)
		"dieu", "phoi", "tac", "tu",
	},
}

// featureRule maps a canonical feature label to a list of trigger
// words (post-StripDiacritics). One hit -> the canonical label is
// added once.
type featureRule struct {
	feature  string
	triggers []string
}

// featureVocab is the built-in bilingual feature vocabulary. Apps may
// also declare their own `capabilities` in bridge.json — those take
// priority and surface as-is.
var featureVocab = []featureRule{
	{"auth.login", []string{"login", "signin", "jwt", "oauth", "session", "dang nhap", "xac thuc"}},
	{"auth.signup", []string{"signup", "register", "registration", "dang ky"}},
	{"payments", []string{"payment", "billing", "stripe", "invoice", "subscription", "thanh toan", "hoa don"}},
	{"i18n", []string{"i18n", "locale", "translation", "intl", "ngon ngu", "dich"}},
	{"notifications", []string{"notification", "email", "sms", "mail", "push", "thong bao"}},
	{"messaging", []string{"chat", "message", "conversation", "thread", "tin nhan", "hoi thoai"}},
	{"lms.course", []string{"course", "courses", "khoa hoc", "lop hoc"}},
	{"lms.lesson", []string{"lesson", "lessons", "bai hoc", "bai giang"}},
	{"lms.student", []string{"student", "students", "hoc vien", "hoc sinh"}},
	{"lms.teacher", []string{"teacher", "instructor", "giang vien", "giao vien"}},
	{"lms.quiz", []string{"quiz", "exam", "test", "bai kiem tra", "bai thi"}},
	{"search", []string{"search", "filter", "tim kiem", "loc"}},
	{"upload", []string{"upload", "import", "tai len", "nhap"}},
	{"export", []string{"export", "download", "tai xuong", "xuat"}},
}

// entityRule maps a canonical entity name to its trigger forms
// (post-StripDiacritics). Multiple triggers can collapse to the same
// canonical entity (so "khoa hoc" and "course" both resolve to
// "course").
type entityRule struct {
	entity   string
	triggers []string
}

var entityVocab = []entityRule{
	{"course", []string{"course", "courses", "khoa hoc", "khoahoc"}},
	{"lesson", []string{"lesson", "lessons", "bai hoc", "baihoc", "bai giang"}},
	{"student", []string{"student", "students", "hoc vien", "hocvien", "hoc sinh"}},
	{"teacher", []string{"teacher", "teachers", "instructor", "giang vien", "giangvien", "giao vien"}},
	{"user", []string{"user", "users", "account", "nguoi dung", "tai khoan"}},
	{"order", []string{"order", "orders", "don hang", "donhang"}},
	{"payment", []string{"payment", "payments", "thanh toan"}},
	{"task", []string{"task", "tasks", "cong viec", "nhiem vu"}},
	{"session", []string{"session", "sessions", "phien"}},
	{"report", []string{"report", "reports", "bao cao"}},
}

// filePathRE matches `path/to/file.ext` or `dir/sub/` patterns in raw
// text. Compiled once at package load — re-compiling on every Detect
// call would dominate the heuristic's cost on a hot dispatch path.
var filePathRE = regexp.MustCompile(`\b(?:[a-zA-Z0-9_.-]+/)+[a-zA-Z0-9_.-]+\b`)

// versionLikeRE rejects bare semver-shaped strings ("2.0.1", "v1.2.3")
// from the file-of-interest list. The TS port used `/^\d+(\.\d+)+$/`;
// the explicit `v?` prefix tolerates a leading `v` because operators
// often paste version specifiers verbatim.
var versionLikeRE = regexp.MustCompile(`^v?\d+(\.\d+)+$`)

// Scoring weights — declared capabilities outweigh inferred features
// because the operator typed them by hand and meant them.
const (
	profileKeywordWeight    = 1
	profileStackWeight      = 2
	profileFeatureWeight    = 3
	profileCapabilityWeight = 4
	roleBucketWeight        = 1
)

// classifyRepoRoles derives the role(s) a repo plays from its
// profile. Pure function of profile signals — no repo names
// involved. If the repo lists `orchestration` as a feature, that role
// is returned exclusively so a bridge-shaped repo doesn't compete
// with real FE/BE on UI- or API-tinted prompts.
func classifyRepoRoles(profile apps.RepoProfile) []role {
	if profile.Name == "" && len(profile.Stack) == 0 && len(profile.Features) == 0 {
		return nil
	}
	stack := stringSet(profile.Stack)
	features := stringSet(profile.Features)

	if _, ok := features["orchestration"]; ok {
		return []role{roleOrchestration}
	}

	roles := []role{}
	_, hasNext := stack["next"]
	_, hasReact := stack["react"]
	_, hasVue := stack["vue"]
	_, hasSvelte := stack["svelte"]
	_, hasTailwind := stack["tailwindcss"]
	isFrontend := hasNext || hasReact || hasVue || hasSvelte || hasTailwind

	_, hasNest := stack["nestjs"]
	_, hasExpress := stack["express"]
	_, hasPrisma := stack["prisma"]
	_, hasTypeORM := stack["typeorm"]
	isBackend := hasNest || hasExpress || hasPrisma || hasTypeORM

	if isFrontend {
		roles = append(roles, roleFrontend)
	}
	if isBackend {
		roles = append(roles, roleBackend)
	}
	return roles
}

func stringSet(in []string) map[string]struct{} {
	out := make(map[string]struct{}, len(in))
	for _, s := range in {
		out[s] = struct{}{}
	}
	return out
}

// repoScore is the per-repo working state inside the heuristic.
// Internal — callers see the resolved RepoMatch slice instead.
type repoScore struct {
	repo      string
	score     int
	hits      []string
	topReason string
}

// scoreRepos runs the legacy two-layer scoring model (role-bucket +
// profile-boost), driven by the bilingual tokenizer + the per-app
// `capabilities` declaration. Returns an empty slice when nothing
// scored above zero.
func scoreRepos(taskText string, repos []string, profiles map[string]apps.RepoProfile, capabilities map[string][]string) []repoScore {
	if strings.TrimSpace(taskText) == "" || len(repos) == 0 {
		return nil
	}

	out := make([]repoScore, 0, len(repos))
	for _, repo := range repos {
		profile := profiles[repo]
		repoCaps := capabilities[repo]
		slot := repoScore{repo: repo}

		bestContribLabel := ""
		bestContribValue := 0
		noteContrib := func(label string, value int) {
			if value > bestContribValue {
				bestContribValue = value
				bestContribLabel = label
			}
		}

		// 1. Role-bucket scoring — generic "this is a UI task" /
		//    "this is an API task" detection. Repos that don't classify
		//    into any role (e.g. a Python ETL sibling) skip this entirely.
		for _, r := range classifyRepoRoles(profile) {
			bestKw := ""
			bestKwCount := 0
			for _, kw := range roleKeywords[r] {
				count := CountMatches(taskText, kw)
				if count > 0 {
					slot.score += count * roleBucketWeight
					slot.hits = append(slot.hits, formatHit(string(r)+":"+kw, count))
					if count > bestKwCount {
						bestKwCount = count
						bestKw = kw
					}
				}
			}
			if bestKw != "" {
				noteContrib(formatHit(string(r)+":"+bestKw, bestKwCount), bestKwCount)
			}
		}

		// 2a. Profile boost — keywords / stack / features harvested
		//     from the repo itself. The Go RepoProfile drops the TS
		//     port's `keywords` field (the heuristic gets no signal
		//     from it on the Go side); stack + features are still
		//     load-bearing.
		if profile.Name != "" {
			// Stack — the cheap win, gives a strong "this repo speaks
			// X" signal whenever the task body mentions a framework
			// the repo declares.
			for _, tok := range profile.Stack {
				count := CountMatches(taskText, tok)
				if count > 0 {
					add := count * profileStackWeight
					slot.score += add
					slot.hits = append(slot.hits, formatHit("stack:"+tok, count))
					noteContrib(formatHit("stack:"+tok, count), add)
				}
			}
			// Features — same shape as stack, higher weight because
			// they're tag-shaped (auth / payments / lms) rather than
			// transport-shaped (next / express).
			for _, tok := range profile.Features {
				count := CountMatches(taskText, tok)
				if count > 0 {
					add := count * profileFeatureWeight
					slot.score += add
					slot.hits = append(slot.hits, formatHit("feature:"+tok, count))
					noteContrib(formatHit("feature:"+tok, count), add)
				}
			}
			// Profile keywords — the TS port harvested README + package
			// name + dep names into a `keywords` slice. The Go port
			// doesn't, so this loop falls through. Synthesize a few
			// from the profile name + summary so a repo with no
			// declared capabilities still gets some signal.
			for _, kw := range deriveProfileKeywords(profile) {
				if len(kw) < 3 {
					continue
				}
				count := CountMatches(taskText, kw)
				if count > 0 {
					add := count * profileKeywordWeight
					slot.score += add
					slot.hits = append(slot.hits, formatHit("profile:"+kw, count))
					noteContrib(formatHit("profile-keyword:"+kw, count), add)
				}
			}
		}

		// 2b. Declared capabilities — operator-curated, highest weight.
		//     Each capability tag (e.g. "lms.course") is split on dots so
		//     "lms" and "course" both score independently against the
		//     task body — the operator doesn't have to guess the exact
		//     phrasing the user will use.
		for _, cap := range repoCaps {
			fragments := splitCapability(cap)
			capHit := false
			for _, frag := range fragments {
				count := CountMatches(taskText, frag)
				if count > 0 {
					add := count * profileCapabilityWeight
					slot.score += add
					slot.hits = append(slot.hits, formatHit("capability:"+cap+"/"+frag, count))
					noteContrib(formatHit("capability:"+cap, count), add)
					capHit = true
				}
			}
			// Also try matching the literal tag in case the user used
			// the exact label ("touch lms.course module").
			if !capHit {
				count := CountMatches(taskText, cap)
				if count > 0 {
					add := count * profileCapabilityWeight
					slot.score += add
					slot.hits = append(slot.hits, formatHit("capability:"+cap, count))
					noteContrib(formatHit("capability:"+cap, count), add)
				}
			}
		}

		if bestContribLabel != "" {
			slot.topReason = bestContribLabel
		}
		out = append(out, slot)
	}

	return out
}

// formatHit renders a single hit token as "<label>×N" — the same
// shape the TS port emitted so the rendered prompt looks identical
// across both implementations during the migration window.
func formatHit(label string, count int) string {
	return label + "×" + itoa(count)
}

// itoa is the trivial fast-path for small positive ints. Using
// strconv.Itoa would import strconv just for the one call — a wash.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	if n < 0 {
		return "-" + itoa(-n)
	}
	buf := [20]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// splitCapability replicates the TS regex /[.:/_-]+/ split. We do it
// by hand to stay off regexp on the hot scoring path.
func splitCapability(cap string) []string {
	if cap == "" {
		return nil
	}
	out := []string{}
	start := 0
	flush := func(end int) {
		if end <= start {
			start = end + 1
			return
		}
		frag := cap[start:end]
		start = end + 1
		if len(frag) >= 3 {
			out = append(out, frag)
		}
	}
	for i := 0; i < len(cap); i++ {
		switch cap[i] {
		case '.', ':', '/', '_', '-':
			flush(i)
		}
	}
	flush(len(cap))
	return out
}

// deriveProfileKeywords synthesizes a small keyword list from the
// profile fields the Go port carries. The TS port had a richer
// `keywords` slice harvested from package.json + README; here we lean
// on the summary + name so the heuristic still has a per-repo lexical
// signal beyond stack / features. Tokenize handles diacritic stripping
// and stopword filtering for us.
func deriveProfileKeywords(profile apps.RepoProfile) []string {
	parts := []string{profile.Name, profile.Summary}
	parts = append(parts, profile.Stack...)
	return Tokenize(strings.Join(parts, " "))
}

// detectFeatures picks features from the bilingual vocab + intersects
// with declared caps so the operator's hand-curated tags surface
// alongside the built-in canonical labels.
func detectFeatures(taskText string, capabilities map[string][]string) []string {
	found := map[string]struct{}{}
	order := []string{}
	add := func(f string) {
		if _, ok := found[f]; ok {
			return
		}
		found[f] = struct{}{}
		order = append(order, f)
	}
	for _, rule := range featureVocab {
		for _, t := range rule.triggers {
			if CountMatches(taskText, t) > 0 {
				add(rule.feature)
				break
			}
		}
	}
	if capabilities != nil {
		// Sort the repo names for deterministic order across runs —
		// Go map iteration is randomized and we want the rendered
		// prompt to be stable for cache reuse.
		repoNames := make([]string, 0, len(capabilities))
		for k := range capabilities {
			repoNames = append(repoNames, k)
		}
		sort.Strings(repoNames)
		for _, repo := range repoNames {
			for _, cap := range capabilities[repo] {
				if CountMatches(taskText, cap) > 0 {
					add(cap)
				}
			}
		}
	}
	return order
}

func detectEntities(taskText string) []string {
	found := map[string]struct{}{}
	order := []string{}
	for _, rule := range entityVocab {
		for _, t := range rule.triggers {
			if CountMatches(taskText, t) > 0 {
				if _, ok := found[rule.entity]; !ok {
					found[rule.entity] = struct{}{}
					order = append(order, rule.entity)
				}
				break
			}
		}
	}
	return order
}

func detectFiles(taskText string) []string {
	if taskText == "" {
		return nil
	}
	matches := filePathRE.FindAllString(taskText, -1)
	if len(matches) == 0 {
		return nil
	}
	out := []string{}
	seen := map[string]struct{}{}
	for _, m := range matches {
		if versionLikeRE.MatchString(m) {
			continue
		}
		if strings.HasPrefix(m, "node_modules/") {
			continue
		}
		if len(m) > 200 {
			continue
		}
		if _, ok := seen[m]; ok {
			continue
		}
		seen[m] = struct{}{}
		out = append(out, m)
	}
	return out
}

// buildSignalText collapses raw TaskBody + optional TaskTitle into a
// single normalized text blob the scorers operate on. Title is
// weighted by appearing twice (concise + signal-dense).
func buildSignalText(input DetectInput) string {
	title := strings.TrimSpace(input.TaskTitle)
	body := strings.TrimSpace(input.TaskBody)
	if title != "" && body != "" {
		return title + "\n" + title + "\n" + body
	}
	if title != "" {
		return title
	}
	return body
}

func pickConfidence(top, second *repoScore) Confidence {
	if top == nil || top.score == 0 {
		return ConfidenceLow
	}
	if second == nil || second.score == 0 {
		return ConfidenceMedium
	}
	// Top wins by ≥ 2× → medium; closer than that → low (coordinator
	// should weigh the body itself before trusting the top pick).
	if top.score >= second.score*2 {
		return ConfidenceMedium
	}
	return ConfidenceLow
}

// Detect runs the heuristic and returns a populated DetectedScope.
// Pure function — no I/O, no goroutines. The Go API doesn't need the
// async wrapper the TS port carried for parity with the LLM impl.
func Detect(input DetectInput) DetectedScope {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	text := buildSignalText(input)
	if text == "" || len(input.Repos) == 0 {
		empty := EmptyScope("empty input or no candidate repos")
		empty.DetectedAt = now
		return empty
	}

	scored := scoreRepos(text, input.Repos, input.Profiles, input.Capabilities)
	// Stable sort: ties keep the input-roster order so a downstream
	// "first repo with score > 0" selection is reproducible across runs.
	sort.SliceStable(scored, func(i, j int) bool {
		return scored[i].score > scored[j].score
	})

	repoMatches := []RepoMatch{}
	for _, s := range scored {
		if s.score <= 0 {
			continue
		}
		reason := s.topReason
		if reason == "" {
			reason = "hits: " + joinFirst(s.hits, 4)
		}
		repoMatches = append(repoMatches, RepoMatch{
			Name:   s.repo,
			Score:  s.score,
			Reason: reason,
		})
	}

	// User-pinned override: surface that as the top match regardless
	// of score. Keep the rest of the scored list (and detected
	// features/entities/files) so the coordinator sees what the
	// heuristic would have picked.
	source := SourceHeuristic
	if input.PinnedRepo != "" && containsString(input.Repos, input.PinnedRepo) {
		source = SourceUserPinned
		var pinned RepoMatch
		existingIdx := -1
		for i, r := range repoMatches {
			if r.Name == input.PinnedRepo {
				existingIdx = i
				pinned = r
				break
			}
		}
		if existingIdx == -1 {
			pinned = RepoMatch{
				Name:   input.PinnedRepo,
				Score:  0,
				Reason: "user-pinned via NewSessionDialog",
			}
		} else {
			repoMatches = append(repoMatches[:existingIdx], repoMatches[existingIdx+1:]...)
		}
		pinned.Reason = "user-pinned (" + pinned.Reason + ")"
		repoMatches = append([]RepoMatch{pinned}, repoMatches...)
	}

	var top, second *repoScore
	if len(scored) > 0 {
		top = &scored[0]
	}
	if len(scored) > 1 {
		second = &scored[1]
	}

	confidence := pickConfidence(top, second)
	if source == SourceUserPinned {
		confidence = ConfidenceHigh
	}

	features := detectFeatures(text, input.Capabilities)
	entities := detectEntities(text)
	// Files use the raw body — paths shouldn't be diacritic-stripped.
	files := detectFiles(input.TaskBody)

	reason := ""
	switch {
	case source == SourceUserPinned:
		if top != nil {
			reason = "user pinned `" + input.PinnedRepo + "`; heuristic top would be `" + top.repo + "` (score " + itoa(top.score) + ")"
		} else {
			reason = "user pinned `" + input.PinnedRepo + "`; heuristic top would be (no signal)"
		}
	case top == nil || top.score == 0:
		reason = "heuristic: no clear match"
	case second != nil && second.score == top.score:
		reason = "heuristic: tie between " + top.repo + " and " + second.repo
	default:
		if top.topReason != "" {
			reason = "heuristic top: " + top.topReason
		} else {
			reason = "heuristic top: " + joinFirst(top.hits, 4)
		}
	}

	// Normalize empty slices to non-nil so JSON round-trips emit `[]`
	// (matching the TS shape) rather than `null`.
	if features == nil {
		features = []string{}
	}
	if entities == nil {
		entities = []string{}
	}
	if files == nil {
		files = []string{}
	}

	return DetectedScope{
		Repos:      repoMatches,
		Features:   features,
		Entities:   entities,
		Files:      files,
		Confidence: confidence,
		Source:     source,
		DetectedAt: now,
		Reason:     reason,
	}
}

func containsString(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func joinFirst(in []string, n int) string {
	if len(in) <= n {
		return strings.Join(in, ", ")
	}
	return strings.Join(in[:n], ", ")
}
