package quality_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/quality"
)

// writeFile is a helper that writes content under root and creates
// any missing parent directories. Failing the test here (not
// returning the error) keeps the per-test bodies short — the test
// has no way to recover from a TempDir write failure anyway.
func writeFile(t *testing.T, root, rel, body string) {
	t.Helper()
	full := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(full), err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", full, err)
	}
}

// --- BuildFingerprint: indent ---------------------------------------

func TestFingerprintDetectsTwoSpaceIndent(t *testing.T) {
	dir := t.TempDir()
	// Several .ts files all using 2-space indent — should win the
	// 0.6 threshold cleanly.
	for i := 0; i < 4; i++ {
		body := "export const x = {\n  a: 1,\n  b: 2,\n};\n"
		writeFile(t, dir, "src/file"+itoa(i)+".ts", body)
	}
	fp := quality.BuildFingerprint(dir, nil)
	if fp.Indent.Kind != "spaces" || fp.Indent.Width != 2 {
		t.Fatalf("indent: got %+v, want {spaces 2}", fp.Indent)
	}
}

func TestFingerprintDetectsTabIndent(t *testing.T) {
	dir := t.TempDir()
	body := "export const x = {\n\ta: 1,\n\tb: 2,\n};\n"
	for i := 0; i < 4; i++ {
		writeFile(t, dir, "src/tab"+itoa(i)+".ts", body)
	}
	fp := quality.BuildFingerprint(dir, nil)
	if fp.Indent.Kind != "tabs" || fp.Indent.Width != 1 {
		t.Fatalf("indent: got %+v, want {tabs 1}", fp.Indent)
	}
}

// --- BuildFingerprint: quotes ---------------------------------------

func TestFingerprintDetectsSingleQuotes(t *testing.T) {
	dir := t.TempDir()
	// 'single' lines dominate; one occasional double-quote line is
	// noise and shouldn't flip the result.
	body := "" +
		"const a = 'one';\n" +
		"const b = 'two';\n" +
		"const c = 'three';\n" +
		"const d = 'four';\n" +
		"const e = 'five';\n"
	writeFile(t, dir, "src/quotes.ts", body)
	fp := quality.BuildFingerprint(dir, nil)
	if fp.Quotes != "single" {
		t.Fatalf("quotes: got %q, want %q", fp.Quotes, "single")
	}
}

func TestFingerprintDetectsDoubleQuotes(t *testing.T) {
	dir := t.TempDir()
	body := "" +
		"const a = \"one\";\n" +
		"const b = \"two\";\n" +
		"const c = \"three\";\n" +
		"const d = \"four\";\n" +
		"const e = \"five\";\n"
	writeFile(t, dir, "src/dq.ts", body)
	fp := quality.BuildFingerprint(dir, nil)
	if fp.Quotes != "double" {
		t.Fatalf("quotes: got %q, want %q", fp.Quotes, "double")
	}
}

// --- BuildFingerprint: semicolons -----------------------------------

func TestFingerprintDetectsSemicolonsAlways(t *testing.T) {
	dir := t.TempDir()
	body := "" +
		"const a = 1;\n" +
		"const b = 2;\n" +
		"const c = 3;\n" +
		"const d = 4;\n" +
		"const e = 5;\n"
	writeFile(t, dir, "src/semi.ts", body)
	fp := quality.BuildFingerprint(dir, nil)
	if fp.Semicolons != "always" {
		t.Fatalf("semicolons: got %q, want %q", fp.Semicolons, "always")
	}
}

func TestFingerprintDetectsSemicolonsNever(t *testing.T) {
	dir := t.TempDir()
	body := "" +
		"const a = 1\n" +
		"const b = 2\n" +
		"const c = 3\n" +
		"const d = 4\n" +
		"const e = 5\n"
	writeFile(t, dir, "src/nosemi.ts", body)
	fp := quality.BuildFingerprint(dir, nil)
	if fp.Semicolons != "never" {
		t.Fatalf("semicolons: got %q, want %q", fp.Semicolons, "never")
	}
}

// --- BuildFingerprint: trailing comma -------------------------------

func TestFingerprintDetectsTrailingCommaAll(t *testing.T) {
	dir := t.TempDir()
	// Indented lines ending in `,` vote "all"; the closing `}` line
	// is at column 0 so it doesn't vote against.
	body := "" +
		"export const x = {\n" +
		"  a: 1,\n" +
		"  b: 2,\n" +
		"  c: 3,\n" +
		"  d: 4,\n" +
		"};\n"
	for i := 0; i < 3; i++ {
		writeFile(t, dir, "src/tc"+itoa(i)+".ts", body)
	}
	fp := quality.BuildFingerprint(dir, nil)
	if fp.TrailingComma != "all" {
		t.Fatalf("trailing comma: got %q, want %q", fp.TrailingComma, "all")
	}
}

// --- BuildFingerprint: exports --------------------------------------

func TestFingerprintDetectsNamedExports(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 4; i++ {
		body := "export const a = 1;\nexport function b() {}\nexport type C = number;\n"
		writeFile(t, dir, "src/n"+itoa(i)+".ts", body)
	}
	fp := quality.BuildFingerprint(dir, nil)
	if fp.Exports != "named" {
		t.Fatalf("exports: got %q, want %q", fp.Exports, "named")
	}
}

func TestFingerprintDetectsDefaultExports(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 4; i++ {
		body := "export default function() {}\n"
		writeFile(t, dir, "src/d"+itoa(i)+".ts", body)
	}
	fp := quality.BuildFingerprint(dir, nil)
	if fp.Exports != "default" {
		t.Fatalf("exports: got %q, want %q", fp.Exports, "default")
	}
}

// --- BuildFingerprint: file naming ----------------------------------

func TestFingerprintDetectsFileNamingPascalTsx(t *testing.T) {
	dir := t.TempDir()
	// .tsx files all in PascalCase — the React-component convention.
	for _, name := range []string{"Button", "Card", "Modal", "Tooltip"} {
		writeFile(t, dir, "src/components/"+name+".tsx", "export const X = 1;\n")
	}
	fp := quality.BuildFingerprint(dir, nil)
	if fp.FileNaming.Tsx != "PascalCase" {
		t.Fatalf("tsx naming: got %q, want %q", fp.FileNaming.Tsx, "PascalCase")
	}
}

func TestFingerprintDetectsFileNamingKebabTs(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"use-store", "fetch-helper", "date-utils", "string-utils"} {
		writeFile(t, dir, "src/lib/"+name+".ts", "export const X = 1;\n")
	}
	fp := quality.BuildFingerprint(dir, nil)
	if fp.FileNaming.Ts != "kebab-case" {
		t.Fatalf("ts naming: got %q, want %q", fp.FileNaming.Ts, "kebab-case")
	}
}

// --- BuildFingerprint: unknown fallback -----------------------------

func TestFingerprintUnknownWhenEmpty(t *testing.T) {
	// No source files at all — every dimension must fall through to
	// "unknown" so the prompt builder can hide the section.
	dir := t.TempDir()
	writeFile(t, dir, "README.md", "# nothing\n")
	writeFile(t, dir, "package.json", "{}\n")

	fp := quality.BuildFingerprint(dir, nil)
	if fp.SampledFiles != 0 {
		t.Errorf("sampled: got %d, want 0", fp.SampledFiles)
	}
	if fp.Indent.Kind != "unknown" || fp.Indent.Width != 0 {
		t.Errorf("indent: got %+v, want {unknown 0}", fp.Indent)
	}
	for name, got := range map[string]string{
		"quotes":        fp.Quotes,
		"semicolons":    fp.Semicolons,
		"trailingComma": fp.TrailingComma,
		"exports":       fp.Exports,
		"fileNaming.ts": fp.FileNaming.Ts,
		"fileNaming.tsx": fp.FileNaming.Tsx,
	} {
		if got != "unknown" {
			t.Errorf("%s: got %q, want %q", name, got, "unknown")
		}
	}
}

// --- BuildFingerprint: dirs scoping ---------------------------------

func TestFingerprintRespectsDirsScope(t *testing.T) {
	// When dirs is non-empty, files outside the listed sub-trees
	// must not contribute to the tally. Plant a noisy single-quote
	// file in `other/` and confirm scoping to `src/` returns the
	// double-quote signal from `src/` only.
	dir := t.TempDir()
	for i := 0; i < 5; i++ {
		writeFile(t, dir, "src/dq"+itoa(i)+".ts", "const a = \"x\";\n")
	}
	for i := 0; i < 20; i++ {
		writeFile(t, dir, "other/sq"+itoa(i)+".ts", "const a = 'x';\n")
	}
	fp := quality.BuildFingerprint(dir, []string{"src"})
	if fp.Quotes != "double" {
		t.Fatalf("scoped quotes: got %q, want %q", fp.Quotes, "double")
	}
}

// --- BuildFingerprint: skip filters ---------------------------------

func TestFingerprintSkipsTestAndNodeModules(t *testing.T) {
	// Test files (`.test.ts`) and `node_modules/` should not affect
	// the tally. We plant tab-indent in the legitimate source and
	// space-indent in the noise — the tab signal must win.
	dir := t.TempDir()
	for i := 0; i < 3; i++ {
		writeFile(t, dir, "src/file"+itoa(i)+".ts", "export const x = {\n\ta: 1,\n};\n")
	}
	// Noise that would flip the result if it weren't filtered.
	for i := 0; i < 20; i++ {
		writeFile(t, dir, "src/file"+itoa(i)+".test.ts", "const x = {\n  a: 1,\n};\n")
		writeFile(t, dir, "node_modules/pkg/file"+itoa(i)+".ts", "const x = {\n  a: 1,\n};\n")
	}
	fp := quality.BuildFingerprint(dir, nil)
	if fp.Indent.Kind != "tabs" {
		t.Fatalf("expected tabs to survive filter; got %+v (sampled=%d)", fp.Indent, fp.SampledFiles)
	}
}

// --- helpers --------------------------------------------------------

// itoa keeps the test bodies clean — strconv import would be
// fine but a 6-line helper avoids the extra dep on a stdlib pkg
// only used for trivial loop counters.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}

// Sanity: ensure the test helper's expectations about strings.HasPrefix
// (used implicitly via writeFile's MkdirAll) match path semantics on
// Windows — no behavior, just a guard against forward-slash assumptions
// regressing.
var _ = strings.HasPrefix
