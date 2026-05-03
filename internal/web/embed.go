// Package webdist embeds the Vite SPA build output (web/dist/) into the
// Go binary so cmd/bridge can serve the dashboard from the same process
// as the API. The directory layout is:
//
//	web/                 -- frontend source (Vite, owned by the web team)
//	web/dist/            -- Vite build output (gitignored)
//	internal/web/        -- this package
//	internal/web/dist/   -- copy of web/dist/ produced by `make embed-web`
//
// The duplication exists because //go:embed paths are RELATIVE to the
// .go file's own directory — there is no way to embed a sibling tree
// like ../../web/dist from here. The Makefile's `embed-web` target does
// the copy step (rm -rf internal/web/dist && cp -r web/dist
// internal/web/dist) so the embed always reflects the latest Vite
// output. A .gitkeep keeps the directory tracked so a fresh clone
// compiles even before the first frontend build.
//
// The chosen package name is "webdist" — Go forbids package "web" from
// living next to the top-level "web/" directory because the import path
// "github.com/.../internal/web" already resolves to this package, and
// the build tooling tolerates that fine, but reading "import
// .../internal/web" then seeing `web.FS()` is ambiguous with the source
// tree at web/. "webdist" makes the intent (it's the dist bundle, not
// the source) explicit at every call site.
package webdist

import (
	"embed"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

// FS returns the rooted filesystem for the embedded SPA bundle so
// callers see "index.html" / "assets/foo.js" rather than
// "dist/index.html". The "all:" prefix on the embed directive above
// makes go embed dotfiles too (in particular our .gitkeep, but also
// any .well-known files Vite plugins might emit).
func FS() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}

// StaticHandler returns an http.Handler that serves the SPA bundle.
//
// When devDir is non-empty, files are read live from disk (typically
// "web/dist") so a developer running `air` against `pnpm dev` sees
// changes without rebuilding the Go binary. When empty, the handler
// serves from the embedded bundle — the production path.
//
// The returned handler also implements the SPA fallback: any GET that
// resolves to a non-existent path returns index.html with status 200 so
// the React Router (client-side) can render the requested route. It
// explicitly refuses to fall back for /api/* paths so a typo'd API URL
// returns the chi 404 instead of the SPA shell.
func StaticHandler(devDir string) (http.Handler, error) {
	var (
		root fs.FS
		err  error
	)
	if devDir != "" {
		// os.DirFS is fine for a dev-only loader. We only allow this when
		// the operator explicitly opts in via --web-dir, so the usual
		// "DirFS isn't a security boundary" caveat doesn't bite us.
		info, statErr := os.Stat(devDir)
		if statErr != nil {
			return nil, statErr
		}
		if !info.IsDir() {
			return nil, errors.New("webdist: --web-dir must point to a directory")
		}
		root = os.DirFS(devDir)
	} else {
		root, err = FS()
		if err != nil {
			return nil, err
		}
	}
	return SPAHandler(root), nil
}

// SPAHandler exposes the SPA fallback handler over an arbitrary
// fs.FS — the unit tests use fstest.MapFS to avoid disk I/O.
//
// Behavior:
//
//  1. /api/* paths are 404'd unconditionally. This handler only ever
//     mounts as the chi catch-all, so by the time we see /api/* it
//     means no real route matched — the right answer is "no such
//     endpoint", not "have an SPA shell" (which would mask typos).
//
//  2. For any other path, try to serve the file from the FS. If it
//     resolves to a real file, http.FileServer handles bytes /
//     content-type / etag.
//
//  3. If the path doesn't resolve to a file AND the request is a GET
//     (HEAD too — http.ServeContent handles those), serve index.html
//     so client-side routing can take over. Anything else (POST to a
//     non-existent path, etc.) returns 404.
//
// Static assets are intentionally NOT auth-gated: they contain no
// operator data, the SPA reads its bootstrap state from /api/health
// (already public), and the data layer (/api/*) is still gated by the
// auth middleware mounted upstream.
func SPAHandler(static fs.FS) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(static))
	return func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}

		// Probe for the file before delegating. http.FileServer's own
		// 404 path is fine, but we need to know whether to fall back to
		// index.html — easier to check ourselves than to wrap the
		// ResponseWriter.
		if fileExists(static, r.URL.Path) {
			fileServer.ServeHTTP(w, r)
			return
		}

		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}

		// SPA fallback — serve index.html with 200 so the browser keeps
		// the requested URL but the React app handles routing.
		index, err := fs.ReadFile(static, "index.html")
		if err != nil {
			// Either index.html is missing (fresh clone before
			// `make embed-web`) or the FS is broken. Tell the operator;
			// the alternative is a confusing blank 404 page.
			http.Error(w, "SPA bundle missing index.html — run `make build-web && make embed-web`", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(index)
	}
}

// fileExists reports whether path resolves to a regular file under
// static. Leading slashes are stripped because fs.FS rejects them.
// Directories return false — http.FileServer would 301 to a /-suffixed
// URL or attempt to serve an index, neither of which we want here
// (the SPA fallback is the only "default response" we tolerate).
func fileExists(static fs.FS, urlPath string) bool {
	clean := strings.TrimPrefix(urlPath, "/")
	if clean == "" {
		// Root path → fall through to SPA fallback unless an explicit
		// "index.html" file exists, which it does for any built bundle.
		clean = "index.html"
	}
	info, err := fs.Stat(static, clean)
	if err != nil {
		return false
	}
	return !info.IsDir()
}
