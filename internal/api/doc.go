// Package api holds the oapi-codegen output (chi server interfaces +
// request/response types) generated from api/openapi.yaml. Hand-written
// route handlers wire concrete behavior in sibling packages and mount
// them through the generated ServerInterface.
package api
