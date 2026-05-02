package symbol

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFile is a fatal-on-error helper that creates parent dirs.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// findSymbol returns the first SymbolEntry matching name, or nil.
func findSymbol(syms []SymbolEntry, name string) *SymbolEntry {
	for i := range syms {
		if syms[i].Name == name {
			return &syms[i]
		}
	}
	return nil
}

func TestExtractExports_AllFourShapes(t *testing.T) {
	src := `// header comment
export function add(a: number, b: number): number {
  return a + b;
}

export const PI = 3.14;

export class Foo {
  bar() {}
}

export interface Opts {
  name: string;
}

export type Handler = (e: Event) => void;

export default function ignored() {}
`
	got := extractExports(src, "lib/x.ts")

	wantKinds := map[string]SymbolKind{
		"add":     KindFunction,
		"PI":      KindConst,
		"Foo":     KindClass,
		"Opts":    KindInterface,
		"Handler": KindType,
	}
	if len(got) != len(wantKinds) {
		t.Fatalf("got %d symbols (%v), want %d", len(got), got, len(wantKinds))
	}
	for name, kind := range wantKinds {
		s := findSymbol(got, name)
		if s == nil {
			t.Errorf("missing symbol %q", name)
			continue
		}
		if s.Kind != kind {
			t.Errorf("%s kind = %q, want %q", name, s.Kind, kind)
		}
	}
	// `default` export must be dropped — the captured "name" would be
	// the keyword `default` and isn't a useful identifier.
	if findSymbol(got, "default") != nil {
		t.Errorf("export default should be dropped")
	}
	if findSymbol(got, "ignored") != nil {
		t.Errorf("inner identifier from default export should not leak")
	}
}

func TestExtractExports_ComponentPromotion(t *testing.T) {
	src := `export const Button = (props: ButtonProps) => <button {...props} />;
export function Card() { return <div/>; }
export const cn = (a: string) => a;
`
	// .tsx file → PascalCase const/function should bucket as component
	got := extractExports(src, "components/ui/button.tsx")
	if s := findSymbol(got, "Button"); s == nil || s.Kind != KindComponent {
		t.Errorf("Button in .tsx → kind=%v, want component", s)
	}
	if s := findSymbol(got, "Card"); s == nil || s.Kind != KindComponent {
		t.Errorf("Card function in .tsx → kind=%v, want component", s)
	}
	// camelCase stays a const even in a .tsx file.
	if s := findSymbol(got, "cn"); s == nil || s.Kind != KindConst {
		t.Errorf("cn → kind=%v, want const", s)
	}

	// Same code in .ts file: NO component promotion (no JSX runtime).
	got = extractExports(src, "lib/util.ts")
	if s := findSymbol(got, "Button"); s == nil || s.Kind != KindConst {
		t.Errorf("Button in .ts → kind=%v, want const (component needs .tsx)", s)
	}
}

func TestExtractExports_SignatureTrimming(t *testing.T) {
	// 200-char "argument list" so signature definitely overflows.
	long := strings.Repeat("a", 200)
	src := fmt.Sprintf("export function huge(%s) {\n  return 1;\n}\n", long)

	got := extractExports(src, "lib/h.ts")
	if len(got) != 1 {
		t.Fatalf("got %d, want 1", len(got))
	}
	sig := got[0].Signature
	// Cap is 120 chars + ellipsis suffix.
	if !strings.HasSuffix(sig, signatureCont) {
		t.Errorf("signature should be ellipsis-truncated, got %q", sig)
	}
	// Length in bytes: 120 + len(ellipsis bytes). signatureCont is "…"
	// (3 bytes UTF-8) — the unit doesn't matter so long as it's > 120.
	if len([]rune(sig)) > signatureCap+5 {
		t.Errorf("signature length = %d runes, expected ~%d", len([]rune(sig)), signatureCap)
	}

	// Multi-line whitespace inside the captured tail should collapse.
	src2 := "export const x =   {\nfoo: 1};\n"
	got = extractExports(src2, "lib/x.ts")
	if got[0].Signature != "= {" {
		t.Errorf("signature = %q, want %q", got[0].Signature, "= {")
	}
}

func TestBuild_DefaultDirs(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "lib", "a.ts"), "export const aaa = 1;\n")
	writeFile(t, filepath.Join(root, "utils", "b.ts"), "export function bbb() {}\n")
	writeFile(t, filepath.Join(root, "hooks", "useC.ts"), "export const useC = () => 1;\n")
	writeFile(t, filepath.Join(root, "components", "ui", "btn.tsx"),
		"export const Btn = () => <div/>;\n")
	// A dir we DON'T scan by default — must not appear.
	writeFile(t, filepath.Join(root, "scripts", "skip.ts"), "export const skipMe = 1;\n")

	idx := Build("myapp", root, nil)
	if idx.AppName != "myapp" {
		t.Errorf("AppName = %q", idx.AppName)
	}
	if idx.FileCount != 4 {
		t.Errorf("FileCount = %d, want 4", idx.FileCount)
	}
	if len(idx.ScannedDirs) != 4 {
		t.Errorf("ScannedDirs = %v", idx.ScannedDirs)
	}
	if findSymbol(idx.Symbols, "skipMe") != nil {
		t.Errorf("scripts/ should not be scanned by default")
	}
	if findSymbol(idx.Symbols, "aaa") == nil {
		t.Errorf("lib/a.ts symbol missing")
	}
	if s := findSymbol(idx.Symbols, "Btn"); s == nil || s.Kind != KindComponent {
		t.Errorf("Btn should be promoted to component in components/ui")
	}
	// File path must be posix-style even on Windows.
	if s := findSymbol(idx.Symbols, "Btn"); s != nil && strings.Contains(s.File, `\`) {
		t.Errorf("File path %q contains backslash", s.File)
	}
}

func TestBuild_SkipsKnownDirs(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "lib", "real.ts"), "export const real = 1;\n")
	// All of these live INSIDE lib/ but should be skipped by the walker.
	writeFile(t, filepath.Join(root, "lib", "node_modules", "pkg", "index.ts"),
		"export const fromNm = 1;\n")
	writeFile(t, filepath.Join(root, "lib", "dist", "out.ts"),
		"export const fromDist = 1;\n")
	writeFile(t, filepath.Join(root, "lib", "__tests__", "x.ts"),
		"export const fromTests = 1;\n")
	writeFile(t, filepath.Join(root, "lib", "x.test.ts"),
		"export const fromTestFile = 1;\n")
	writeFile(t, filepath.Join(root, "lib", "x.d.ts"),
		"export const fromDts = 1;\n")
	writeFile(t, filepath.Join(root, "lib", ".hidden.ts"),
		"export const fromHidden = 1;\n")

	idx := Build("a", root, nil)
	for _, blocked := range []string{"fromNm", "fromDist", "fromTests", "fromTestFile", "fromDts", "fromHidden"} {
		if findSymbol(idx.Symbols, blocked) != nil {
			t.Errorf("symbol %q should have been skipped", blocked)
		}
	}
	if findSymbol(idx.Symbols, "real") == nil {
		t.Errorf("real symbol missing — non-skip files should still be picked up")
	}
}

func TestBuild_RejectsEscapingPaths(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "lib", "ok.ts"), "export const ok = 1;\n")
	// The would-be sibling target — if the scanner accepted ../sibling
	// as a symbolDirs entry, this would leak into the index.
	parent := filepath.Dir(root)
	leakDir := filepath.Join(parent, "should-not-walk")
	if err := os.MkdirAll(leakDir, 0o755); err != nil {
		t.Fatalf("mkdir leak: %v", err)
	}
	defer os.RemoveAll(leakDir)
	writeFile(t, filepath.Join(leakDir, "leak.ts"), "export const leaked = 1;\n")

	idx := Build("a", root, []string{"../should-not-walk", "lib"})
	if findSymbol(idx.Symbols, "leaked") != nil {
		t.Errorf("../ escape should be rejected")
	}
	if findSymbol(idx.Symbols, "ok") == nil {
		t.Errorf("lib/ should still be scanned alongside the rejected entry")
	}
	// Absolute path in symbolDirs is also rejected.
	idx2 := Build("a", root, []string{leakDir})
	if findSymbol(idx2.Symbols, "leaked") != nil {
		t.Errorf("absolute path in symbolDirs should be rejected")
	}
}

func TestBuild_FileWalkCap(t *testing.T) {
	root := t.TempDir()
	libDir := filepath.Join(root, "lib")
	// Create more files than fileWalkCap so the walker MUST stop early.
	total := fileWalkCap + 50
	for i := 0; i < total; i++ {
		writeFile(t, filepath.Join(libDir, fmt.Sprintf("f%04d.ts", i)),
			"// no exports\n")
	}
	idx := Build("a", root, nil)
	if idx.FileCount > fileWalkCap {
		t.Errorf("FileCount = %d, want <= %d", idx.FileCount, fileWalkCap)
	}
	if idx.FileCount < fileWalkCap {
		t.Errorf("FileCount = %d, want close to cap %d", idx.FileCount, fileWalkCap)
	}
}

func TestBuild_SymbolCap(t *testing.T) {
	root := t.TempDir()
	libDir := filepath.Join(root, "lib")
	// Pack >symbolCap exports into a small set of files. 50 files * 10
	// symbols each = 500, comfortably above the 400 cap.
	for f := 0; f < 50; f++ {
		var b strings.Builder
		for s := 0; s < 10; s++ {
			fmt.Fprintf(&b, "export const sym_%d_%d = 1;\n", f, s)
		}
		writeFile(t, filepath.Join(libDir, fmt.Sprintf("f%02d.ts", f)), b.String())
	}
	idx := Build("a", root, nil)
	if len(idx.Symbols) != symbolCap {
		t.Errorf("Symbols = %d, want exactly cap %d", len(idx.Symbols), symbolCap)
	}
}

func TestBuild_ByteCap(t *testing.T) {
	root := t.TempDir()
	// File is bigger than readCapBytes (64 KB). Put a recognizable
	// export PAST the cap — it must be invisible to the scanner.
	var b strings.Builder
	b.WriteString("export const earlySym = 1;\n")
	// Padding that pushes the next export past 64 KB.
	pad := strings.Repeat("// pad pad pad pad pad pad pad pad pad pad pad\n", 1500)
	b.WriteString(pad)
	b.WriteString("export const lateSym = 99;\n")
	writeFile(t, filepath.Join(root, "lib", "huge.ts"), b.String())

	if b.Len() <= readCapBytes {
		t.Fatalf("test fixture only %d bytes; need > %d to validate cap", b.Len(), readCapBytes)
	}

	idx := Build("a", root, nil)
	if findSymbol(idx.Symbols, "earlySym") == nil {
		t.Errorf("earlySym (before byte cap) should be visible")
	}
	if findSymbol(idx.Symbols, "lateSym") != nil {
		t.Errorf("lateSym (past byte cap) leaked through — read cap not enforced")
	}
}

func TestBuild_DepthCap(t *testing.T) {
	root := t.TempDir()
	// Build a chain deeper than walkDepthCap. Place a sentinel at each
	// level so we can prove where the walker stopped.
	dir := filepath.Join(root, "lib")
	for i := 0; i <= walkDepthCap+3; i++ {
		writeFile(t, filepath.Join(dir, fmt.Sprintf("l%d.ts", i)),
			fmt.Sprintf("export const level%d = 1;\n", i))
		dir = filepath.Join(dir, "deeper")
	}
	idx := Build("a", root, nil)

	// Depth 0 is `lib/` itself (the start dir). Files at lib/l0.ts
	// (depth 0) through lib/deeper/.../l<walkDepthCap-1>.ts are
	// reachable; anything past walkDepthCap is gated out. Use the
	// sentinel level numbers to assert.
	for i := 0; i < walkDepthCap; i++ {
		if findSymbol(idx.Symbols, fmt.Sprintf("level%d", i)) == nil {
			t.Errorf("level%d should be visible (within depth cap)", i)
		}
	}
	// Past the cap MUST be invisible.
	for i := walkDepthCap + 1; i < walkDepthCap+3; i++ {
		if findSymbol(idx.Symbols, fmt.Sprintf("level%d", i)) != nil {
			t.Errorf("level%d should be hidden (past depth cap)", i)
		}
	}
}

func TestBuild_MissingDirsHandledGracefully(t *testing.T) {
	root := t.TempDir()
	// Empty app — none of the default dirs exist.
	idx := Build("ghost", root, nil)
	if idx.AppName != "ghost" {
		t.Errorf("AppName = %q", idx.AppName)
	}
	if idx.FileCount != 0 || len(idx.Symbols) != 0 {
		t.Errorf("expected empty index, got %+v", idx)
	}
	if len(idx.ScannedDirs) != 0 {
		t.Errorf("ScannedDirs should be empty when nothing exists, got %v", idx.ScannedDirs)
	}
	if idx.RefreshedAt == "" {
		t.Errorf("RefreshedAt should always be set")
	}
}

func TestBuild_AppNameFallsBackToBasename(t *testing.T) {
	root := t.TempDir()
	idx := Build("", root, nil)
	if idx.AppName != filepath.Base(root) {
		t.Errorf("AppName = %q, want basename %q", idx.AppName, filepath.Base(root))
	}
}
