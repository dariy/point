package services

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/gorilla/css/scanner"
)

// CSS sanitization for per-post CSS blocks works in two layers:
//
//  1. Normalization (regex): strip comments and decode escape sequences, so
//     evasion tricks like url(/**/https://…) or \40 import can't hide a
//     dangerous construct from step 2. This is the anti-bypass layer.
//  2. Tokenized walk (gorilla/css scanner): parse the normalized CSS into
//     declarations and reject dangerous ones by their *actual* property name
//     and value — not a substring match. This is the accuracy layer: it can't
//     mangle justify-content the way a `\bcontent` regex did, because the
//     property token is matched whole.
var (
	cssCommentRe     = regexp.MustCompile(`/\*[\s\S]*?\*/`)                   // url(/**/https://…) comment splitting
	cssHexEscapeRe   = regexp.MustCompile(`\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?`) // \40 import → @import
	cssOtherEscapeRe = regexp.MustCompile(`\\([^0-9a-fA-F\r\n])`)             // \@import → @import
	cssExternalURLRe = regexp.MustCompile(`(?i)url\(\s*['"]?\s*https?:`)      // external resource in a declaration value
)

// normalizeCSSForSanitizing strips CSS comments and decodes CSS escape
// sequences so SanitizePostCSS can't be evaded via comment-splitting or
// escaped characters (e.g. `\40 import`, `url(/**/https://…)`).
func normalizeCSSForSanitizing(css string) string {
	css = cssCommentRe.ReplaceAllString(css, "")
	css = cssHexEscapeRe.ReplaceAllStringFunc(css, func(m string) string {
		h := cssHexEscapeRe.FindStringSubmatch(m)[1]
		n, err := strconv.ParseInt(h, 16, 32)
		if err != nil || n == 0 || n > 0x10FFFF {
			return ""
		}
		return string(rune(n))
	})
	return cssOtherEscapeRe.ReplaceAllString(css, "$1")
}

// cssScope selects how strictly a CSS blob is sanitized.
type cssScope int

const (
	// cssScopePost is per-post CSS. A post is a page fragment, so on top of the
	// escapes it must not reposition itself out of its own box or paint over
	// the rest of the page.
	cssScopePost cssScope = iota
	// cssScopeGlobal is the site-wide custom CSS an admin writes to theme their
	// own site. Fixed positioning, stacking order and generated content are all
	// legitimate there, so only the escapes are removed: @import, external
	// url() resources and a '<' breakout.
	cssScopeGlobal
)

// SanitizePostCSS removes dangerous constructs from per-post CSS blocks:
// @import at-rules, external url() resources, position:fixed/sticky, z-index,
// the content property, and any stray '<' (a style/script breakout). Returns
// the sanitized CSS and the list of removed construct names (deduplicated).
func SanitizePostCSS(css string) (string, []string) {
	return sanitizeCSS(css, cssScopePost)
}

// SanitizeGlobalCSS removes the escapes from the site-wide custom CSS: @import
// at-rules, external url() resources and any stray '<'. It deliberately allows
// the layout properties SanitizePostCSS strips — see cssScopeGlobal.
func SanitizeGlobalCSS(css string) (string, []string) {
	return sanitizeCSS(css, cssScopeGlobal)
}

func sanitizeCSS(css string, scope cssScope) (string, []string) {
	if css == "" {
		return "", nil
	}

	norm := normalizeCSSForSanitizing(css)
	sc := scanner.New(norm)

	var out strings.Builder
	var seg []*scanner.Token // tokens of the current declaration / at-rule / prelude
	depth := 0

	seen := map[string]bool{}
	var stripped []string
	record := func(name string) {
		if !seen[name] {
			seen[name] = true
			stripped = append(stripped, name)
		}
	}

	emit := func(tokens []*scanner.Token) {
		for _, t := range tokens {
			out.WriteString(t.Value)
		}
	}
	// flushDecl evaluates a buffered declaration (inside a rule block) or a
	// top-level at-rule (e.g. @import) and emits it unless it's dangerous.
	flushDecl := func(terminator string) {
		if drop, reason := classifyCSSSegment(seg, scope); drop {
			record(reason)
		} else if len(seg) > 0 {
			emit(seg)
			out.WriteString(terminator)
		}
		seg = nil
	}

	for {
		tok := sc.Next()
		if tok.Type == scanner.TokenEOF || tok.Type == scanner.TokenError {
			break
		}
		if tok.Type == scanner.TokenComment {
			continue // normalization already removed these; belt-and-suspenders
		}
		if tok.Type == scanner.TokenChar {
			switch tok.Value {
			case "{":
				// seg is a selector or at-rule prelude — emit verbatim.
				emit(seg)
				out.WriteString("{")
				seg = nil
				depth++
				continue
			case "}":
				flushDecl("") // flush a trailing declaration missing its ';'
				out.WriteString("}")
				if depth > 0 {
					depth--
				}
				continue
			case ";":
				flushDecl(";")
				continue
			case "<":
				// '<' is never valid CSS — drop it (style/script breakout).
				record("<script>")
				continue
			}
		}
		seg = append(seg, tok)
	}
	// Any trailing prelude/selector with no block (malformed) is emitted as-is.
	emit(seg)

	return strings.TrimSpace(out.String()), stripped
}

// classifyCSSSegment decides whether a buffered CSS segment (a declaration or a
// top-level at-rule) must be dropped, returning the removal reason.
func classifyCSSSegment(seg []*scanner.Token, scope cssScope) (bool, string) {
	// Property name: the first ident (at-rules surface as an at-keyword).
	var prop string
	for _, t := range seg {
		switch t.Type {
		case scanner.TokenS:
			continue
		case scanner.TokenAtKeyword:
			if strings.EqualFold(t.Value, "@import") {
				return true, "@import"
			}
			// Other at-rules (e.g. a stray @media prelude) pass through.
			prop = ""
		case scanner.TokenIdent:
			prop = strings.ToLower(t.Value)
		}
		break
	}

	// Reconstruct the value (everything is fine to lowercase for matching).
	var val strings.Builder
	for _, t := range seg {
		val.WriteString(t.Value)
	}
	lower := strings.ToLower(val.String())

	// Layout containment only applies to per-post CSS: a post is a fragment of
	// a page it does not own. Site-wide CSS is the admin styling their own
	// site, where all of these are ordinary.
	if scope == cssScopePost {
		switch prop {
		case "z-index":
			return true, "z-index"
		case "content":
			return true, "content"
		case "position":
			if strings.Contains(lower, "fixed") {
				return true, "position: fixed"
			}
			if strings.Contains(lower, "sticky") {
				return true, "position: sticky"
			}
		}
	}

	if cssExternalURLRe.MatchString(lower) {
		return true, "url() with external resource"
	}
	return false, ""
}
