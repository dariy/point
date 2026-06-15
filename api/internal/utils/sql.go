package utils

import (
	"database/sql"
)

// ToNullInt64 converts an *int64 to a sql.NullInt64.
func ToNullInt64(i *int64) sql.NullInt64 {
	if i == nil {
		return sql.NullInt64{Valid: false}
	}
	return sql.NullInt64{Int64: *i, Valid: true}
}

// ToNullFloat64 converts a *float64 to a sql.NullFloat64.
func ToNullFloat64(f *float64) sql.NullFloat64 {
	if f == nil {
		return sql.NullFloat64{Valid: false}
	}
	return sql.NullFloat64{Float64: *f, Valid: true}
}
