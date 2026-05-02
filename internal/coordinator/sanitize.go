package coordinator

import "regexp"

// yourJobRE matches `## Your job` (and case-insensitive variants with
// 1-6 leading hashes) so sanitizeUserContent can degrade them via a
// ZWSP after the hashes. Without this, a user-supplied body
// containing `## Your job` would relocate the splice point that
// spliceScopeBlock looks for.
var yourJobRE = regexp.MustCompile(`(?im)^(#{1,6})(\s+Your job\b)`)
