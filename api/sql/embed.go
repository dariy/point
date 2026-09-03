package pointsql

import (
	_ "embed"
	"regexp"
	"strings"
)

//go:embed schema.sql
var SchemaSQL string

// beginEndWord matches the two keywords that make a semicolon in schema.sql
// mean something other than "end of statement". Word-bounded and
// case-insensitive; neither word appears anywhere else in the file.
var beginEndWord = regexp.MustCompile(`(?i)\b(BEGIN|END)\b`)

// SchemaStatements cuts schema.sql into statements to execute one at a
// time, so a failure names the statement that failed. Splitting on ";" alone
// would be enough for tables and indexes, but a CREATE TRIGGER carries its own
// statements — and their semicolons — between BEGIN and END, and the fragments
// of one have to be glued back together. Nothing in the file nests further than
// that, so counting the two keywords is enough to know when a semicolon is the
// real one.
func SchemaStatements() []string {
	var out []string
	var buf strings.Builder
	depth := 0

	for _, frag := range strings.SplitAfter(SchemaSQL, ";") {
		buf.WriteString(frag)
		for _, kw := range beginEndWord.FindAllString(frag, -1) {
			if strings.EqualFold(kw, "BEGIN") {
				depth++
			} else if depth > 0 {
				depth--
			}
		}
		if depth > 0 {
			continue
		}
		if trimmed := strings.TrimSpace(buf.String()); trimmed != "" {
			out = append(out, trimmed)
		}
		buf.Reset()
	}
	// An unterminated tail (no trailing semicolon, or an unclosed BEGIN) is
	// still handed to SQLite, which reports it far better than this can.
	if trimmed := strings.TrimSpace(buf.String()); trimmed != "" {
		out = append(out, trimmed)
	}
	return out
}
