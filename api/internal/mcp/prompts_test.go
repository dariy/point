package mcp

import (
	"strings"
	"testing"
)

func TestMediaStep(t *testing.T) {
	// No paths → the skip-able fallback.
	if got := mediaStep(""); !strings.Contains(got, "Otherwise skip this step") {
		t.Errorf("empty mediaStep should return fallback, got %q", got)
	}
	// Whitespace/empty entries collapse to the fallback too.
	if got := mediaStep(" , ,"); !strings.Contains(got, "Otherwise skip this step") {
		t.Errorf("all-blank mediaStep should return fallback, got %q", got)
	}
	// Real paths render one bullet each, trimmed.
	got := mediaStep("a.jpg, b.png")
	if !strings.Contains(got, "- `a.jpg`") || !strings.Contains(got, "- `b.png`") {
		t.Errorf("mediaStep should list both files, got %q", got)
	}
}

func TestLandingPageBody(t *testing.T) {
	body := landingPageBody("Widgets", mediaStep("hero.jpg"))
	if !strings.Contains(body, "**Widgets**") {
		t.Error("topic was not substituted into the body")
	}
	if !strings.Contains(body, "- `hero.jpg`") {
		t.Error("media step was not substituted into the body")
	}
	if strings.Contains(body, "§TOPIC§") || strings.Contains(body, "§MEDIA§") {
		t.Error("placeholders left unsubstituted")
	}
}

func TestFixFences(t *testing.T) {
	if got := fixFences("::: {.hero}"); got != ":::{.hero}" {
		t.Errorf("fixFences = %q, want %q", got, ":::{.hero}")
	}
	if got := fixFences("no fences here"); got != "no fences here" {
		t.Errorf("fixFences should leave plain text untouched, got %q", got)
	}
}
