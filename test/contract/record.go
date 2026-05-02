package contract

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"unicode/utf8"
)

// Capture is the in-memory representation of one HTTP response. Bodies
// are kept as raw bytes so binary payloads (uploads, gzipped) survive
// a round-trip through golden files unchanged.
type Capture struct {
	Status  int
	Headers http.Header
	Body    []byte
}

// goldenFile is the on-disk JSON representation of a Capture. BodyText
// mirrors Body when the bytes are valid UTF-8, purely so humans
// reviewing a golden in code review can read the response without
// base64-decoding. The loader reconstructs the Capture from BodyB64 only.
type goldenFile struct {
	Status   int                 `json:"status"`
	Headers  map[string][]string `json:"headers"`
	BodyB64  string              `json:"body_base64"`
	BodyText string              `json:"body_text,omitempty"`
}

// RecordAgainst issues req against an external server and captures the
// full response. Used by `cmd/contract record` to seed golden files
// from the live Next dev server. Not used in CI verify (which goes
// in-process via ServeHTTP).
func RecordAgainst(client *http.Client, req *http.Request) (*Capture, error) {
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	return &Capture{
		Status:  resp.StatusCode,
		Headers: cloneHeader(resp.Header),
		Body:    body,
	}, nil
}

// BuildRequest assembles an *http.Request from an Endpoint definition
// targeting baseURL (e.g. "http://localhost:7777"). Used by both record
// (URL is the live baseline) and replay paths that exercise a real
// server; in-process verify builds requests via httptest.NewRequest.
func BuildRequest(baseURL string, e Endpoint) (*http.Request, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("baseURL: %w", err)
	}
	u.Path = e.Path
	u.RawQuery = e.RawQuery
	var body io.Reader
	if len(e.Body) > 0 {
		body = bytes.NewReader(e.Body)
	}
	req, err := http.NewRequest(e.Method, u.String(), body)
	if err != nil {
		return nil, err
	}
	for k, vv := range e.Headers {
		for _, v := range vv {
			req.Header.Add(k, v)
		}
	}
	return req, nil
}

// WriteGolden serializes c to path. Headers are written sorted so
// goldens are stable across runs; the loader treats header order as
// insignificant anyway, but a stable on-disk order keeps diffs in
// code review readable.
func WriteGolden(path string, c *Capture) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	gf := goldenFile{
		Status:  c.Status,
		Headers: sortedHeader(c.Headers),
		BodyB64: base64.StdEncoding.EncodeToString(c.Body),
	}
	if utf8.Valid(c.Body) {
		gf.BodyText = string(c.Body)
	}
	out, err := json.MarshalIndent(gf, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return os.WriteFile(path, out, 0o644)
}

// ReadGolden loads a golden file from path.
func ReadGolden(path string) (*Capture, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var gf goldenFile
	if err := json.Unmarshal(raw, &gf); err != nil {
		return nil, fmt.Errorf("unmarshal %s: %w", path, err)
	}
	body, err := base64.StdEncoding.DecodeString(gf.BodyB64)
	if err != nil {
		return nil, fmt.Errorf("decode body in %s: %w", path, err)
	}
	hdr := make(http.Header, len(gf.Headers))
	for k, vv := range gf.Headers {
		for _, v := range vv {
			hdr.Add(k, v)
		}
	}
	return &Capture{
		Status:  gf.Status,
		Headers: hdr,
		Body:    body,
	}, nil
}

// GoldenPath returns the on-disk path to an endpoint's golden file
// relative to the test/contract package directory.
func GoldenPath(name string) string {
	return filepath.Join("testdata", name, "golden.json")
}

func cloneHeader(h http.Header) http.Header {
	out := make(http.Header, len(h))
	for k, vv := range h {
		out[k] = append([]string(nil), vv...)
	}
	return out
}

func sortedHeader(h http.Header) map[string][]string {
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make(map[string][]string, len(keys))
	for _, k := range keys {
		out[k] = append([]string(nil), h[k]...)
	}
	return out
}
