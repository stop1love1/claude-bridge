package meta

import "encoding/json"

// marshalIndent matches the byte shape libs/atomicWrite.ts produces:
// JSON.stringify(value, null, 2) — 2-space indent, no trailing newline
// (the trailing newline is added by WriteStringAtomic instead, mirroring
// writeJsonAtomic's `+ "\n"`).
//
// Centralized so a future bytewise-parity adjustment (Next.js's
// JSON.stringify orders object keys differently from json.Marshal in
// some edge cases) lands in one file.
func marshalIndent(value any) ([]byte, error) {
	return json.MarshalIndent(value, "", "  ")
}
