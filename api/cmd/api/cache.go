package main

// Request-time cache policy: who is allowed to see a cached response, and which
// Cache-Control the origin advertises for it. The build-time half — the
// immutable header for content-addressed asset URLs — lives in assets.go.

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"

	"point-api/internal/repository"

	"github.com/labstack/echo/v4"
)

// isAdminPath reports whether p is served by the admin ("light") SPA section.
// Mirrors the section switch in index.html's inline bootstrap so the two agree
// on what counts as admin.
func isAdminPath(p string) bool {
	return strings.HasPrefix(p, "/light") || p == "/setup"
}

// newSetupGate returns a predicate reporting whether the install has an owner
// user yet, i.e. whether first-run setup has been completed. Setup runs once and
// never reverts, so the answer is latched the first time it comes back true and
// the query only costs anything while the install is still unconfigured.
func newSetupGate(repo repository.Repository) func(context.Context) bool {
	var complete atomic.Bool
	return func(ctx context.Context) bool {
		if complete.Load() {
			return true
		}
		if _, err := repo.GetFirstUser(ctx); err == nil {
			complete.Store(true)
			return true
		}
		return false
	}
}

// noStoreBeforeSetup keeps the responses of an unconfigured install out of
// caches. Listed AFTER visibilityCache on a route so it overrides the
// `public, max-age=60` a guest GET is stamped with: everything a fresh install
// returns is empty, and it stops being true the instant the wizard finishes.
// The settings payload is the one that bites — the wizard's own page load puts
// the empty version in the browser cache, and the admin, loading seconds later,
// reads it back with no blog title and the wrong theme.
func noStoreBeforeSetup(setupComplete func(context.Context) bool) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if !setupComplete(c.Request().Context()) {
				c.Response().Header().Set("Cache-Control", "private, no-store")
			}
			return next(c)
		}
	}
}

// hasSession reports whether the request carries a non-empty session cookie —
// i.e. the viewer is (or claims to be) logged in. Used to keep deployment-
// injected third-party markup out of any authenticated DOM. It only checks for
// the cookie's presence, not validity: a stale cookie merely costs one visitor
// their analytics ping, never a security regression, and it avoids a DB lookup
// on every HTML page load.
func hasSession(c echo.Context) bool {
	ck, err := c.Cookie("session")
	return err == nil && ck.Value != ""
}

// isGuestRequest reports whether a request is an anonymous public reader: no
// session cookie, no Bearer API key, and not an admin path. Such a response is
// identical for every anonymous visitor, so it is safe to share at a CDN edge.
// It mirrors the guest test serveSimplifiedMedia already uses for media
// (isAuthenticated := c.Get("user") != nil), but reads the request directly so
// it does not depend on auth middleware having run first.
func isGuestRequest(c echo.Context) bool {
	if hasSession(c) {
		return false
	}
	if h := c.Request().Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return false
	}
	return !isAdminPath(c.Request().URL.Path)
}

// visibilityCache emits a visibility-aware Cache-Control on a public read route
// so a shared cache can store the anonymous response while never storing an
// authenticated one — the HTML/API analogue of serveSimplifiedMedia's media
// caching, for surviving a traffic spike behind a CDN. A guest GET gets
// `public, max-age=60`; everything else (authenticated reads, any write) gets
// private,no-store so a per-user response is never stored at the edge even if
// the edge's own cache rule misfires. The header is set before the handler runs
// because Echo flushes headers on first write; handlers that set their own
// Cache-Control (media) still win by overwriting it.
//
// Why plain max-age=60 and not `s-maxage=60, max-age=0` (edge caches, browser
// revalidates): some CDNs read max-age=0 as "do not cache" even when s-maxage is
// also present, and then store nothing at all. Verified empirically against a
// major CDN under both of its origin-cache-control modes (honour the origin's
// headers, and ignore them by default): the two-part header cached nothing,
// while a plain max-age=60 cached as intended. The browser-revalidation half is
// better handled at the edge anyway — the CDN can pin browser TTL to 0 on these
// routes, which also stops a zone-wide default browser TTL from leaking a long
// max-age downstream. So the origin just advertises the 60 s shared TTL here.
func visibilityCache(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if c.Request().Method == http.MethodGet && isGuestRequest(c) {
			c.Response().Header().Set("Cache-Control", "public, max-age=60")
			// Many shared caches refuse to store a response whose Vary lists
			// anything but Accept-Encoding. The global CORS middleware adds
			// `Vary: Origin`, but a guest public read does not vary by Origin
			// (ACAO is a constant `*`, no credentialed CORS), so Origin in Vary
			// only defeats edge caching — strip it while keeping Accept-Encoding.
			stripVaryOrigin(c.Response().Header())
		} else {
			c.Response().Header().Set("Cache-Control", "private, no-store")
		}
		return next(c)
	}
}

// stripVaryOrigin removes the Origin token from the Vary header, preserving any
// other tokens (notably Accept-Encoding). CORS (the global middleware set up in
// server.go) runs outside this route-level middleware, so `Vary: Origin` is
// already set by the time visibilityCache runs and can be rewritten here.
func stripVaryOrigin(h http.Header) {
	vals := h.Values("Vary")
	if len(vals) == 0 {
		return
	}
	var kept []string
	for _, v := range vals {
		for _, tok := range strings.Split(v, ",") {
			t := strings.TrimSpace(tok)
			if t == "" || strings.EqualFold(t, "Origin") {
				continue
			}
			kept = append(kept, t)
		}
	}
	h.Del("Vary")
	for _, k := range kept {
		h.Add("Vary", k)
	}
}
