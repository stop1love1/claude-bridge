package server

import (
	"strings"
	"testing"
)

func TestValidateAllowedOrigins(t *testing.T) {
	cases := []struct {
		name    string
		input   []string
		wantErr string // empty = expect nil error
	}{
		{"nil ok", nil, ""},
		{"empty slice ok", []string{}, ""},
		{"single valid", []string{"http://localhost:7777"}, ""},
		{"multiple valid", []string{"http://localhost:7777", "https://claude.example.com"}, ""},
		{"wildcard rejected", []string{"*"}, "wildcard"},
		{"wildcard rejected mid-list", []string{"http://localhost:7777", "*"}, "wildcard"},
		{"null origin rejected", []string{"null"}, "null"},
		{"NULL case-insensitive rejected", []string{"NULL"}, "null"},
		{"empty entry rejected", []string{""}, "empty"},
		{"whitespace-only rejected", []string{"   "}, "empty"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateAllowedOrigins(tc.input)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErr)
			}
			if !strings.Contains(strings.ToLower(err.Error()), tc.wantErr) {
				t.Fatalf("error %q missing substring %q", err.Error(), tc.wantErr)
			}
		})
	}
}
