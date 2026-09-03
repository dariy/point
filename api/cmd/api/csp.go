package main

// Content-Security-Policy assembly. The enforcing header is built here, once, at
// startup: the static directive skeleton, the operator-supplied source lists
// (validated, never trusted whole), and the inline-script hashes computed from
// the shell on disk. setupEcho hands the result straight to middleware.Secure;
// the two per-request script-src splices (the shell in routes.go, the media
// fallback in media.go) rewrite the string this produces.

import (
	"crypto/sha256"
	"encoding/base64"
	"os"
	"regexp"
	"strings"
)

// trustedTypesCSP is appended to the enforcing Content-Security-Policy.
//
// require-trusted-types-for 'script' makes every HTML sink — .innerHTML,
// .outerHTML, insertAdjacentHTML — refuse a plain string; only a value minted
// by a registered TrustedTypePolicy gets through, and trusted-types names the
// policies allowed to exist at all. Chromium rejects a write from anywhere
// else at the sink, which is the point: it moves the escaping rule from lint,
// which an author can suppress, to the browser, which nobody can. Firefox and
// Safari ignore the directive entirely, so this is defence in depth on top of
// the lint rule, never a replacement for it.
//
// Three names, and the list is the security claim, so it is worth reading
// literally:
//
//	point           registered in utils/helpers.js, held by setHTML() /
//	                insertHTML() / setScriptSrc() / setScriptJSON(). Every
//	                write this frontend makes goes through it.
//	point-leaflet   frontend/vendor/leaflet/leaflet.js, patched.
//	point-codejar   frontend/vendor/codejar/codejar.js, patched.
//
// The two vendor policies are pass-through: those libraries build their own
// markup and there is no second escaping pass to add. What the split buys is
// that the waiver is *scoped and named*. A pass-through `default` policy — the
// cheap alternative — would have caught every unrouted sink on the page,
// including one reached by injected content, and left the directive decorative.
// These two catch only the writes inside two files that were read line by line
// (fourteen sinks between them; scripts/check-vendor-sinks.sh fails if a
// version bump adds a fifteenth). Prism needed no waiver at all: PostContent
// drives Prism.highlight(), the string-returning form, and writes the result
// with setHTML().
//
// There is no 'allow-duplicates', so each name can be minted exactly once per
// document — the three policies are created at load, and nothing that runs
// later can register another under the same name.
//
// Appending to the enforcing policy means the two script-src splices (the
// shell in routes.go, the media fallback in media.go) now rewrite a header that
// carries directives they did not put there. Both do a single
// strings.Replace on "script-src", which is unaffected by anything appended
// after it; main_bootstrap_test.go pins that.
const trustedTypesCSP = "require-trusted-types-for 'script'; trusted-types point point-leaflet point-codejar"

// sanitizeCSPSources normalizes an operator-supplied CSP source list (the
// CSP_SCRIPT_SRC / CSP_CONNECT_SRC deploy config) into a safe space-separated
// token list before it is appended to a directive. It splits on whitespace and
// drops any token carrying a character that could break out of the directive:
// ';' would start a new directive, ',' a second policy, and CR/LF could split
// the header. Trusted config, but validated as defense-in-depth.
func sanitizeCSPSources(s string) string {
	var out []string
	for _, tok := range strings.Fields(s) {
		if strings.ContainsAny(tok, ";,\r\n") {
			continue
		}
		out = append(out, tok)
	}
	return strings.Join(out, " ")
}

// inlineScriptRe matches attribute-less inline <script> blocks in index.html.
// Scripts with attributes (src=, type=module) load external files and are
// covered by CSP 'self'.
var inlineScriptRe = regexp.MustCompile(`(?s)<script>(.*?)</script>`)

// inlineScriptHashes returns CSP 'sha256-…' source tokens for every inline
// <script> in the file, so the script-src policy always matches the shell that
// is actually served — no hardcoded hash to keep in sync with index.html by
// hand. Computed once at startup: index.html only changes at build/deploy time
// (the __BUILD_VERSION__ stamp rewrites URLs, not inline script bodies).
func inlineScriptHashes(path string) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []string
	for _, m := range inlineScriptRe.FindAllSubmatch(b, -1) {
		h := sha256.Sum256(m[1])
		out = append(out, "'sha256-"+base64.StdEncoding.EncodeToString(h[:])+"'")
	}
	return out
}

// buildContentSecurityPolicy assembles the enforcing Content-Security-Policy
// header value handed to middleware.Secure.
//
// script-src starts at 'self' plus the shell's inline <script> hashes
// (indexHTMLPath, read once here). connect-src starts at 'self' plus the map
// tile origin. Both then take an optional deployment-supplied extra origin list
// (CSP_SCRIPT_SRC / CSP_CONNECT_SRC) — sanitized, never appended raw — which
// lets an operator allow-list a script injected via HEAD_HTML without the
// engine hardcoding any third-party domain. Empty by default, so the shipped
// policy is unchanged unless a deployment opts in.
//
// The trusted-types tail is appended last; the per-request script-src splices
// rewrite the "script-src" token and leave everything after it alone.
func buildContentSecurityPolicy(indexHTMLPath, cspScriptSrc, cspConnectSrc string) string {
	scriptSrc := strings.Join(append([]string{"'self'"}, inlineScriptHashes(indexHTMLPath)...), " ")
	connectSrc := "'self' https://server.arcgisonline.com"
	if extra := sanitizeCSPSources(cspScriptSrc); extra != "" {
		scriptSrc += " " + extra
	}
	if extra := sanitizeCSPSources(cspConnectSrc); extra != "" {
		connectSrc += " " + extra
	}
	return "default-src 'self'; script-src " + scriptSrc +
		"; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://server.arcgisonline.com https://github.com https://*.githubusercontent.com; media-src 'self' blob:; connect-src " + connectSrc +
		"; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " + trustedTypesCSP
}
