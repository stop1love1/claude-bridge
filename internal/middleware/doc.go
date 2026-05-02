// Package middleware holds cross-cutting HTTP middleware: cookie auth
// gate (with internal-token bypass for /api/tasks/<id>/link), token-
// bucket rate limiting, and the JSON error response shape that
// matches the existing Next handlers.
package middleware
