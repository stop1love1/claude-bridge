package contract

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/rs/zerolog"

	"github.com/stop1love1/claude-bridge/internal/server"
)

// Normalizer mutates a Capture in-place to strip values that legitimately
// vary across runs (timestamps, request IDs, cookie expiry epochs).
// Applied to BOTH golden and actual before diffing.
type Normalizer func(*Capture)

// DefaultNormalizers is the canonical ignore list applied during Verify.
// Documented in test/contract/README.md — keep the two in sync. The
// rule: drop anything whose value is bound to wall-clock time, a
// per-request random ID, or a server-side middleware artifact that
// neither implementation under contract is responsible for; never
// anything bound to handler logic.
var DefaultNormalizers = []Normalizer{
	stripHeader("Date"),
	stripHeader("X-Request-Id"),
	// Vary: Origin is added unconditionally by go-chi/cors even when
	// the request carries no Origin (i.e. server-to-server / curl).
	// Next.js routes don't emit it for the same calls, so stripping it
	// avoids false drift. Origin-bearing requests will still surface
	// real CORS divergence via Access-Control-* headers, which we do
	// NOT strip.
	stripHeader("Vary"),
	normalizeSetCookieExpires,
}

// Verify runs the named endpoint against an in-process Go handler,
// compares with its golden file, and returns the diff (empty string =
// pass). The fixture is set up via the endpoint's Setup hook (if any)
// so each Verify call gets a fresh disk state.
//
// goldenDir is the directory containing testdata/<name>/golden.json —
// callers pass an absolute or test-relative path so this works from
// both `go test` (cwd = test/contract) and `cmd/contract` (cwd = repo
// root).
func Verify(name, goldenDir string) (string, error) {
	e, ok := Endpoints[name]
	if !ok {
		return "", fmt.Errorf("unknown endpoint %q", name)
	}

	fix, err := NewFixture()
	if err != nil {
		return "", fmt.Errorf("fixture: %w", err)
	}
	defer func() { _ = fix.Cleanup() }()

	if e.Setup != nil {
		if err := e.Setup(fix); err != nil {
			return "", fmt.Errorf("setup %s: %w", name, err)
		}
	}

	handler := server.NewHandler(server.Config{
		Logger: zerolog.New(io.Discard),
	})

	rec := httptest.NewRecorder()
	var body io.Reader
	if len(e.Body) > 0 {
		body = bytes.NewReader(e.Body)
	}
	target := e.Path
	if e.RawQuery != "" {
		target = target + "?" + e.RawQuery
	}
	req := httptest.NewRequest(e.Method, target, body)
	for k, vv := range e.Headers {
		for _, v := range vv {
			req.Header.Add(k, v)
		}
	}

	handler.ServeHTTP(rec, req)
	actual := &Capture{
		Status:  rec.Code,
		Headers: cloneHeader(rec.Header()),
		Body:    rec.Body.Bytes(),
	}

	goldenPath := strings.ReplaceAll(GoldenPath(name), "\\", "/")
	if goldenDir != "" {
		goldenPath = strings.TrimRight(goldenDir, "/\\") + "/" + goldenPath
	}
	golden, err := ReadGolden(goldenPath)
	if err != nil {
		return "", fmt.Errorf("read golden %s: %w", goldenPath, err)
	}

	for _, n := range DefaultNormalizers {
		n(golden)
		n(actual)
	}

	return Diff(golden, actual), nil
}

// VerifyAll runs Verify for every registered endpoint and returns a
// composite report. err is non-nil only on operational failures (golden
// missing, fixture setup error); diff mismatches are reported in the
// returned string with a non-empty value.
func VerifyAll(goldenDir string) (string, error) {
	names := make([]string, 0, len(Endpoints))
	for n := range Endpoints {
		names = append(names, n)
	}
	sort.Strings(names)

	var report strings.Builder
	failed := 0
	for _, n := range names {
		diff, err := Verify(n, goldenDir)
		if err != nil {
			fmt.Fprintf(&report, "[ERROR] %s: %v\n", n, err)
			failed++
			continue
		}
		if diff == "" {
			fmt.Fprintf(&report, "[ OK  ] %s\n", n)
			continue
		}
		fmt.Fprintf(&report, "[FAIL ] %s\n%s\n", n, indent(diff, "  "))
		failed++
	}
	fmt.Fprintf(&report, "\n%d endpoints, %d failed\n", len(names), failed)
	if failed > 0 {
		return report.String(), fmt.Errorf("%d endpoints failed", failed)
	}
	return report.String(), nil
}

// Diff returns a human-readable diff between golden and actual. Empty
// string means they match. Order of checks: status, body, headers
// (status & body fail loudest because they break clients hardest).
func Diff(golden, actual *Capture) string {
	var b strings.Builder
	if golden.Status != actual.Status {
		fmt.Fprintf(&b, "status: golden=%d actual=%d\n", golden.Status, actual.Status)
	}
	if !bytes.Equal(golden.Body, actual.Body) {
		fmt.Fprintf(&b, "body mismatch:\n  golden: %s\n  actual: %s\n",
			truncatePreview(golden.Body), truncatePreview(actual.Body))
	}

	gKeys := sortedKeys(golden.Headers)
	aKeys := sortedKeys(actual.Headers)
	for _, k := range gKeys {
		gv := golden.Headers[k]
		av, ok := actual.Headers[k]
		if !ok {
			fmt.Fprintf(&b, "header %q: missing in actual (golden=%v)\n", k, gv)
			continue
		}
		if !slices.Equal(gv, av) {
			fmt.Fprintf(&b, "header %q: golden=%v actual=%v\n", k, gv, av)
		}
	}
	for _, k := range aKeys {
		if _, ok := golden.Headers[k]; !ok {
			fmt.Fprintf(&b, "header %q: extra in actual (%v)\n", k, actual.Headers[k])
		}
	}
	return b.String()
}

func stripHeader(name string) Normalizer {
	canonical := http.CanonicalHeaderKey(name)
	return func(c *Capture) {
		c.Headers.Del(canonical)
	}
}

// Set-Cookie expiry epoch normalizer — Next sets `Expires=Tue, 01 Jan 2030 ...`
// or similar, and the wall clock changes between record and replay. We
// rewrite the date portion to a fixed sentinel so the rest of the
// cookie attributes (path, samesite, httponly, secure) still diff.
var setCookieExpiresRe = regexp.MustCompile(`(?i)Expires=[^;]+`)

func normalizeSetCookieExpires(c *Capture) {
	v := c.Headers.Values("Set-Cookie")
	if len(v) == 0 {
		return
	}
	out := make([]string, len(v))
	for i, s := range v {
		out[i] = setCookieExpiresRe.ReplaceAllString(s, "Expires=<NORMALIZED>")
	}
	c.Headers.Del("Set-Cookie")
	for _, s := range out {
		c.Headers.Add("Set-Cookie", s)
	}
}

func sortedKeys(h http.Header) []string {
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func truncatePreview(b []byte) string {
	const max = 200
	if len(b) <= max {
		return fmt.Sprintf("%q", b)
	}
	return fmt.Sprintf("%q… (%d bytes total)", b[:max], len(b))
}

func indent(s, prefix string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	for i, l := range lines {
		lines[i] = prefix + l
	}
	return strings.Join(lines, "\n")
}
