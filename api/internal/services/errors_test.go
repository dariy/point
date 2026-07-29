package services

import (
	"database/sql"
	"errors"
	"fmt"
	"testing"
)

// TestKindsAreDistinct guards the property the mapper depends on: an error
// carries at most one kind, so a single errors.Is sweep yields one status.
func TestKindsAreDistinct(t *testing.T) {
	for i, a := range ErrorKinds {
		for j, b := range ErrorKinds {
			if i != j && errors.Is(a, b) {
				t.Errorf("kind %v also matches %v; kinds must be mutually exclusive", a, b)
			}
		}
	}
}

// TestNamedSentinelKinds pins every named sentinel to its kind. A sentinel
// added without a line here is not necessarily wrong, but a sentinel whose
// kind *changes* silently moves an HTTP status, so the mapping is asserted.
func TestNamedSentinelKinds(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		kind     error
		wantText string
	}{
		{"ErrMediaNotFound", ErrMediaNotFound, ErrNotFound, "media not found"},
		{"ErrNotAnImage", ErrNotAnImage, ErrInvalidInput, "media item is not an image"},
		{"ErrResponseUnusable", ErrResponseUnusable, ErrUpstream, "the response cannot be used"},
		{"ErrUnsupportedMediaType", ErrUnsupportedMediaType, ErrInvalidInput, "unsupported media type"},
		{"ErrActiveSVGContent", ErrActiveSVGContent, ErrInvalidInput, "SVG contains active content (script, event handler, or external reference)"},
		{"ErrBackupInProgress", ErrBackupInProgress, ErrConflict, "a backup is already in progress"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if !errors.Is(tt.err, tt.kind) {
				t.Errorf("errors.Is(%s, %v) = false, want true", tt.name, tt.kind)
			}
			// Messages reach users through API responses; the kind must not
			// leak into the text.
			if got := tt.err.Error(); got != tt.wantText {
				t.Errorf("%s message = %q, want %q", tt.name, got, tt.wantText)
			}
			// Exactly one kind, so the mapper's first match is the only match.
			// TestKindsAreDistinct proves errors.Is(k, tt.kind) holds only for
			// the kind itself, so it is the right way to skip the expected one.
			for _, k := range ErrorKinds {
				if !errors.Is(k, tt.kind) && errors.Is(tt.err, k) {
					t.Errorf("%s carries a second kind %v", tt.name, k)
				}
			}
		})
	}
}

// TestUnkindedSentinelsStay500 documents the sentinels that deliberately carry
// no kind: they mean our own stored data or config is broken, not that the
// caller did anything wrong, so a logged 500 is the honest answer.
func TestUnkindedSentinelsStay500(t *testing.T) {
	for _, tt := range []struct {
		name string
		err  error
	}{
		{"ErrInvalidHash", ErrInvalidHash},
		{"ErrIncompatibleVersion", ErrIncompatibleVersion},
	} {
		for _, k := range ErrorKinds {
			if errors.Is(tt.err, k) {
				t.Errorf("%s unexpectedly carries kind %v; it should fall through to a 500", tt.name, k)
			}
		}
	}
}

func TestWrapKind(t *testing.T) {
	t.Run("nil stays nil", func(t *testing.T) {
		if err := wrapKind(ErrNotFound, nil); err != nil {
			t.Errorf("wrapKind(kind, nil) = %v, want nil", err)
		}
	})

	t.Run("message is unchanged", func(t *testing.T) {
		// Handlers still match on error text until they move to the mapper,
		// so wrapping must not rewrite the message.
		inner := fmt.Errorf("field %q contains disallowed characters", "Make")
		wrapped := wrapKind(ErrInvalidInput, inner)
		if wrapped.Error() != inner.Error() {
			t.Errorf("message = %q, want %q", wrapped.Error(), inner.Error())
		}
	})

	t.Run("both kind and original are findable", func(t *testing.T) {
		// The case that matters most: a not-found row must satisfy errors.Is
		// for the kind *and* keep sql.ErrNoRows for callers that check it.
		wrapped := wrapKind(ErrNotFound, fmt.Errorf("get media: %w", sql.ErrNoRows))
		if !errors.Is(wrapped, ErrNotFound) {
			t.Error("errors.Is(wrapped, ErrNotFound) = false, want true")
		}
		if !errors.Is(wrapped, sql.ErrNoRows) {
			t.Error("errors.Is(wrapped, sql.ErrNoRows) = false, want true")
		}
	})

	t.Run("kind survives further wrapping", func(t *testing.T) {
		// Services routinely re-wrap on the way up; the kind has to survive it.
		err := fmt.Errorf("outer: %w", wrapKind(ErrConflict, errors.New("inner")))
		if !errors.Is(err, ErrConflict) {
			t.Error("kind lost through fmt.Errorf wrapping")
		}
	})
}

// TestClassifiedServiceErrors covers the classifications that exist purely so
// handlers can stop matching on error text.
func TestClassifiedServiceErrors(t *testing.T) {
	t.Run("post slug collision is a conflict", func(t *testing.T) {
		err := classifyPostSaveError(errors.New("UNIQUE constraint failed: posts.slug"))
		if !errors.Is(err, ErrConflict) {
			t.Error("slug collision not classified as ErrConflict")
		}
	})

	t.Run("other save failures keep no kind", func(t *testing.T) {
		err := classifyPostSaveError(errors.New("database is locked"))
		for _, k := range ErrorKinds {
			if errors.Is(err, k) {
				t.Errorf("unrelated save failure classified as %v", k)
			}
		}
	})

	t.Run("nil save error stays nil", func(t *testing.T) {
		if err := classifyPostSaveError(nil); err != nil {
			t.Errorf("classifyPostSaveError(nil) = %v, want nil", err)
		}
	})
}
