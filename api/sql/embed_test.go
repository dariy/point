package pointsql

import (
	"strings"
	"testing"
)

// The schema is executed a statement at a time, so a CREATE TRIGGER — the one
// thing in the file that holds semicolons of its own — must come out of the
// split whole rather than as three broken fragments.
func TestSchemaStatements_KeepsTriggersWhole(t *testing.T) {
	stmts := SchemaStatements()
	if len(stmts) < 2 {
		t.Fatalf("schema split into %d statements", len(stmts))
	}

	var triggers int
	for _, stmt := range stmts {
		if !strings.Contains(strings.ToUpper(stmt), "CREATE TRIGGER") {
			// Only a trigger body may carry an inner semicolon.
			if i := strings.Index(stmt, ";"); i >= 0 && strings.TrimSpace(stmt[i+1:]) != "" {
				t.Errorf("statement holds more than one statement:\n%s", stmt)
			}
			continue
		}
		triggers++
		if !strings.HasSuffix(strings.TrimSuffix(stmt, ";"), "END") {
			t.Errorf("trigger was cut short of its END:\n%s", stmt)
		}
	}
	if triggers == 0 {
		t.Error("no CREATE TRIGGER found; the split has swallowed one")
	}
}

// Every statement has to be one SQLite accepts, and the file has to be readable
// end to end — a fresh install is exactly this loop.
func TestSchemaStatements_CoversTheWholeFile(t *testing.T) {
	var rejoined strings.Builder
	for _, stmt := range SchemaStatements() {
		rejoined.WriteString(stmt)
	}
	strip := func(s string) string {
		var b strings.Builder
		for _, r := range s {
			switch r {
			case ' ', '\t', '\n', '\r', ';':
			default:
				b.WriteRune(r)
			}
		}
		return b.String()
	}
	// Comments between statements are carried along with the statement that
	// follows them, so nothing but whitespace and statement terminators is
	// allowed to go missing.
	if got, want := strip(rejoined.String()), strip(SchemaSQL); got != want {
		t.Errorf("the split lost or reordered part of schema.sql (%d chars vs %d)", len(got), len(want))
	}
}
