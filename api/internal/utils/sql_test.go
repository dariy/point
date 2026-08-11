package utils

import (
	"testing"
)

func TestToNullInt64(t *testing.T) {
	t.Run("nil", func(t *testing.T) {
		got := ToNullInt64(nil)
		if got.Valid {
			t.Errorf("expected Valid to be false")
		}
	})

	t.Run("value", func(t *testing.T) {
		val := int64(42)
		got := ToNullInt64(&val)
		if !got.Valid {
			t.Errorf("expected Valid to be true")
		}
		if got.Int64 != 42 {
			t.Errorf("expected 42, got %d", got.Int64)
		}
	})
}

func TestToNullFloat64(t *testing.T) {
	t.Run("nil", func(t *testing.T) {
		got := ToNullFloat64(nil)
		if got.Valid {
			t.Errorf("expected Valid to be false")
		}
	})

	t.Run("value", func(t *testing.T) {
		val := float64(42.5)
		got := ToNullFloat64(&val)
		if !got.Valid {
			t.Errorf("expected Valid to be true")
		}
		if got.Float64 != 42.5 {
			t.Errorf("expected 42.5, got %f", got.Float64)
		}
	})
}
