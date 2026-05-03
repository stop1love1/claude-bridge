package slash

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuiltins(t *testing.T) {
	t.Run("returns the hard-coded list with Source=builtin and empty Path", func(t *testing.T) {
		got := Builtins()
		if len(got) == 0 {
			t.Fatalf("Builtins() returned empty list")
		}
		for _, c := range got {
			if c.Source != "builtin" {
				t.Errorf("command %q Source = %q, want builtin", c.Name, c.Source)
			}
			if c.Path != "" {
				t.Errorf("command %q Path = %q, want empty", c.Name, c.Path)
			}
			if c.Name == "" {
				t.Errorf("found command with empty Name")
			}
		}
	})

	t.Run("returns a fresh slice each call (caller mutation does not leak)", func(t *testing.T) {
		first := Builtins()
		if len(first) == 0 {
			t.Fatal("Builtins() returned empty list")
		}
		first[0].Name = "MUTATED"
		second := Builtins()
		if second[0].Name == "MUTATED" {
			t.Errorf("mutation of first slice leaked into second call")
		}
	})

	t.Run("includes a few well-known slugs", func(t *testing.T) {
		want := map[string]bool{"help": false, "clear": false, "init": false}
		for _, c := range Builtins() {
			if _, ok := want[c.Name]; ok {
				want[c.Name] = true
			}
		}
		for k, found := range want {
			if !found {
				t.Errorf("expected builtin slug %q not present", k)
			}
		}
	})
}

func TestParseDescription(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "front-matter description wins over body heading",
			in:   "---\ndescription: From front matter\n---\n\n# Body Heading\n\nstuff",
			want: "From front matter",
		},
		{
			name: "front-matter without description falls through to first heading in body",
			in:   "---\nname: foo\nother: bar\n---\n\n# Body Heading Wins\n",
			want: "Body Heading Wins",
		},
		{
			name: "first heading is used when no front-matter is present",
			in:   "# Heading One\n\nintro paragraph\n\n# Heading Two\n",
			want: "Heading One",
		},
		{
			name: "supports CRLF line endings",
			in:   "---\r\ndescription: crlf desc\r\n---\r\n\r\n# Body\r\n",
			want: "crlf desc",
		},
		{
			name: "strips matching surrounding double quotes from front-matter value",
			in:   "---\ndescription: \"quoted desc\"\n---\n",
			want: "quoted desc",
		},
		{
			name: "strips matching surrounding single quotes from front-matter value",
			in:   "---\ndescription: 'quoted desc'\n---\n",
			want: "quoted desc",
		},
		{
			name: "leaves mismatched quotes in place rather than mangling input",
			in:   "---\ndescription: \"weird'\n---\n",
			want: "\"weird'",
		},
		{
			name: "tolerates leading whitespace before the heading hashes (CommonMark up to 3 spaces)",
			in:   "   ## Indented heading\n",
			want: "Indented heading",
		},
		{
			name: "skips body paragraphs that are not headings",
			in:   "Just a paragraph, no heading.\n\nAnother paragraph.\n",
			want: "",
		},
		{
			name: "returns empty for empty input",
			in:   "",
			want: "",
		},
		{
			name: "returns empty when front-matter has neither description nor a body heading",
			in:   "---\nname: foo\n---\n\nplain body\n",
			want: "",
		},
		{
			name: "trims trailing closing hashes (ATX-style)",
			in:   "# Title ##\n",
			want: "Title",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseDescription(tc.in)
			if got != tc.want {
				t.Errorf("parseDescription(%q)\n  got  %q\n  want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestNormSlug(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"lower-cases mixed-case input", "MyCmd", "mycmd"},
		{"strips leading slashes", "//foo", "foo"},
		{"collapses internal whitespace into dashes", "my  cool  cmd", "my-cool-cmd"},
		{"trims surrounding whitespace before lowering", "  spaced  ", "spaced"},
		{"empty input returns empty", "", ""},
		{"whitespace-only returns empty", "   ", ""},
		{"rejects bare leading dash (slug must start with alnum)", "-foo", ""},
		{"rejects illegal characters like `?`", "foo?bar", ""},
		{"accepts colon and underscore separators", "ns:foo_bar", "ns:foo_bar"},
		{"accepts a single nested-segment slash", "ns/sub-name", "ns/sub-name"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normSlug(tc.in); got != tc.want {
				t.Errorf("normSlug(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestDiscover(t *testing.T) {
	t.Run("walks each root, skips non-md and dotted dirs, returns sorted Commands", func(t *testing.T) {
		root := t.TempDir()

		writeFile(t, filepath.Join(root, "alpha.md"),
			"---\ndescription: alpha description\n---\n\n# Alpha Heading\n")
		writeFile(t, filepath.Join(root, "beta.md"),
			"# Beta heading wins when there is no front-matter\n")
		// Non-md file should be ignored.
		writeFile(t, filepath.Join(root, "ignore.txt"), "irrelevant")
		// Subdirs should be ignored (Discover is not recursive).
		if err := os.MkdirAll(filepath.Join(root, "nested"), 0o755); err != nil {
			t.Fatalf("mkdir nested: %v", err)
		}
		writeFile(t, filepath.Join(root, "nested", "skipped.md"), "# Should not show\n")

		got := Discover([]string{root})
		if len(got) != 2 {
			t.Fatalf("got %d commands, want 2: %#v", len(got), got)
		}
		if got[0].Name != "alpha" || got[1].Name != "beta" {
			t.Errorf("ordering = [%s, %s], want [alpha, beta]", got[0].Name, got[1].Name)
		}
		if got[0].Description != "alpha description" {
			t.Errorf("alpha description = %q, want %q", got[0].Description, "alpha description")
		}
		if got[1].Description != "Beta heading wins when there is no front-matter" {
			t.Errorf("beta description = %q, want heading text", got[1].Description)
		}
		// Path must be absolute and point at the actual file.
		if !filepath.IsAbs(got[0].Path) {
			t.Errorf("alpha path %q is not absolute", got[0].Path)
		}
		if _, err := os.Stat(got[0].Path); err != nil {
			t.Errorf("alpha path %q does not exist on disk: %v", got[0].Path, err)
		}
	})

	t.Run("missing roots are skipped silently", func(t *testing.T) {
		ghost := filepath.Join(t.TempDir(), "definitely-not-here")
		got := Discover([]string{ghost})
		if len(got) != 0 {
			t.Errorf("discover on missing root returned %d entries, want 0", len(got))
		}
	})

	t.Run("filenames whose slug fails normalization are skipped", func(t *testing.T) {
		root := t.TempDir()
		// A filename starting with `?` is filesystem-illegal on Windows
		// — use a leading dash instead, which normSlug rejects (slug
		// must start with alnum).
		writeFile(t, filepath.Join(root, "-bad.md"), "# Won't be surfaced\n")
		writeFile(t, filepath.Join(root, "good.md"), "# Surfaced\n")
		got := Discover([]string{root})
		if len(got) != 1 || got[0].Name != "good" {
			t.Fatalf("got %#v, want exactly one command named 'good'", got)
		}
	})

	t.Run("source label: roots under HOME get 'user', everything else 'app'", func(t *testing.T) {
		// Spoof HOME for this test so we can place a "user" root under
		// it without touching the real home. Both Unix HOME and Windows
		// USERPROFILE are honored by os.UserHomeDir().
		fakeHome := t.TempDir()
		t.Setenv("HOME", fakeHome)
		t.Setenv("USERPROFILE", fakeHome)

		userRoot := filepath.Join(fakeHome, ".claude", "commands")
		if err := os.MkdirAll(userRoot, 0o755); err != nil {
			t.Fatalf("mkdir userRoot: %v", err)
		}
		writeFile(t, filepath.Join(userRoot, "personal.md"), "# personal\n")

		appRoot := t.TempDir() // a separate tmpdir, NOT under fakeHome
		writeFile(t, filepath.Join(appRoot, "project.md"), "# project\n")

		got := Discover([]string{userRoot, appRoot})
		if len(got) != 2 {
			t.Fatalf("got %d commands, want 2: %#v", len(got), got)
		}
		bySlug := map[string]Command{}
		for _, c := range got {
			bySlug[c.Name] = c
		}
		if bySlug["personal"].Source != "user" {
			t.Errorf("personal.Source = %q, want user", bySlug["personal"].Source)
		}
		if bySlug["project"].Source != "app" {
			t.Errorf("project.Source = %q, want app", bySlug["project"].Source)
		}
	})

	t.Run("multiple roots contributing the same slug both appear, sorted by Path", func(t *testing.T) {
		rootA := t.TempDir()
		rootB := t.TempDir()
		writeFile(t, filepath.Join(rootA, "shared.md"), "# from A\n")
		writeFile(t, filepath.Join(rootB, "shared.md"), "# from B\n")

		got := Discover([]string{rootA, rootB})
		if len(got) != 2 {
			t.Fatalf("got %d commands, want 2: %#v", len(got), got)
		}
		if got[0].Name != "shared" || got[1].Name != "shared" {
			t.Errorf("expected both entries named 'shared', got %v / %v", got[0].Name, got[1].Name)
		}
		// Sorted by path → the lexicographically earlier path comes first.
		if got[0].Path > got[1].Path {
			t.Errorf("paths not sorted: %q then %q", got[0].Path, got[1].Path)
		}
	})

	t.Run("uppercase .MD extension is honored", func(t *testing.T) {
		root := t.TempDir()
		writeFile(t, filepath.Join(root, "loud.MD"), "# Loud Heading\n")
		got := Discover([]string{root})
		if len(got) != 1 || got[0].Name != "loud" {
			t.Fatalf("got %#v, want one command named 'loud'", got)
		}
		if !strings.EqualFold(filepath.Ext(got[0].Path), ".md") {
			t.Errorf("path %q does not end in .md/.MD", got[0].Path)
		}
	})
}

// writeFile is a fatal-on-error helper for test setup. Mirrors the
// helper in internal/sessions/sessions_test.go to keep the cross-pkg
// test idiom consistent.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
