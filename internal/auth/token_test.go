package auth

import (
	"os"
	"testing"
)

func TestConstantTimeCompareString(t *testing.T) {
	cases := []struct {
		name string
		a, b string
		want bool
	}{
		{"both empty", "", "", false},
		{"a empty", "", "x", false},
		{"b empty", "x", "", false},
		{"equal short", "abc", "abc", true},
		{"equal long", "0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef", true},
		{"different length", "abc", "abcd", false},
		{"different content same length", "abcd", "abce", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ConstantTimeCompareString(tc.a, tc.b); got != tc.want {
				t.Fatalf("ConstantTimeCompareString(%q,%q) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

func TestLoadOrGenerateInternalToken_GeneratesWhenUnset(t *testing.T) {
	t.Setenv(InternalTokenEnv, "")
	// t.Setenv with empty string still sets it — explicitly unset:
	if err := os.Unsetenv(InternalTokenEnv); err != nil {
		t.Fatalf("unsetenv: %v", err)
	}
	tok, generated, err := LoadOrGenerateInternalToken()
	if err != nil {
		t.Fatalf("LoadOrGenerateInternalToken: %v", err)
	}
	if !generated {
		t.Fatalf("expected generated=true when env unset")
	}
	if len(tok) != 64 {
		t.Fatalf("expected 32-byte hex (64 chars), got %d chars", len(tok))
	}
	if got := os.Getenv(InternalTokenEnv); got != tok {
		t.Fatalf("env not exported: got %q want %q", got, tok)
	}
}

func TestLoadOrGenerateInternalToken_ReusesExisting(t *testing.T) {
	t.Setenv(InternalTokenEnv, "preset-token-value")
	tok, generated, err := LoadOrGenerateInternalToken()
	if err != nil {
		t.Fatalf("LoadOrGenerateInternalToken: %v", err)
	}
	if generated {
		t.Fatalf("expected generated=false when env already set")
	}
	if tok != "preset-token-value" {
		t.Fatalf("got %q want preset-token-value", tok)
	}
}
