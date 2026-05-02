// Package symbol builds a tree-sitter-backed symbol index per repo so
// the bridge can answer "where is X defined" without shelling out.
// CGO via go-tree-sitter is the default; a tree-sitter CLI fallback
// is available if CGO is blocked on the target platform.
package symbol
