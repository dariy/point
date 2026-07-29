package services

import "errors"

// Error taxonomy for the service layer.
//
// Handlers must not inspect error strings to decide a status code. Instead,
// every error a service returns for a *foreseeable* failure wraps exactly one
// of the kind sentinels below, and handlers (via the central mapper in
// internal/api) recover the kind with errors.Is.
//
// The kinds and the HTTP statuses they stand for:
//
//	ErrNotFound        404  the addressed thing does not exist
//	ErrInvalidInput    400  the caller sent something unusable
//	ErrConflict        409  valid request, incompatible with current state
//	ErrUnauthenticated 401  the caller has not proven who they are
//	ErrForbidden       403  the caller is known but may not do this
//	ErrUpstream        502  a service we depend on failed or misbehaved
//	ErrStorageFull     507  the operation needs more disk than is available
//
// Errors that are *not* foreseeable — a closed database, a failed write, a
// bug — deliberately carry no kind. They fall through to a logged 500, which
// is the correct outcome; do not reach for a kind just to silence one.
//
// To add a failure mode, prefer a named sentinel wrapping a kind (see
// ErrMediaNotFound below) when handlers or tests need to recognise that exact
// case, and wrapKind for one-off errors that only need the kind.
var (
	ErrNotFound        = errors.New("not found")
	ErrInvalidInput    = errors.New("invalid input")
	ErrConflict        = errors.New("conflict")
	ErrUnauthenticated = errors.New("unauthenticated")
	ErrForbidden       = errors.New("forbidden")
	ErrUpstream        = errors.New("upstream failure")
	ErrStorageFull     = errors.New("insufficient storage")
)

// ErrorKinds lists every kind sentinel. The mapper in internal/api and the
// taxonomy tests both iterate it, so a kind added above is picked up by both
// without a second edit.
var ErrorKinds = []error{
	ErrNotFound,
	ErrInvalidInput,
	ErrConflict,
	ErrUnauthenticated,
	ErrForbidden,
	ErrUpstream,
	ErrStorageFull,
}

// kindError is a sentinel that reports its own message but unwraps to a kind,
// so errors.Is matches both. Wrapping with fmt.Errorf would splice the kind's
// text into the message ("media not found: not found"); these messages reach
// users through API responses, so they are kept verbatim.
type kindError struct {
	msg  string
	kind error
}

func (e *kindError) Error() string { return e.msg }
func (e *kindError) Unwrap() error { return e.kind }

// kindSentinel defines a named sentinel carrying msg and classified as kind.
func kindSentinel(kind error, msg string) error { return &kindError{msg: msg, kind: kind} }

// wrapKind classifies err as kind while keeping err in the chain, for failures
// that need no sentinel of their own. The message is err's, unchanged, so
// existing callers that still match on text keep working.
//
// It returns nil when err is nil, so it can wrap a call's result directly.
func wrapKind(kind error, err error) error {
	if err == nil {
		return nil
	}
	return &wrappedKind{err: err, kind: kind}
}

type wrappedKind struct {
	err  error
	kind error
}

func (e *wrappedKind) Error() string { return e.err.Error() }

// Unwrap returns both the original error and the kind, so errors.Is finds the
// kind and any sentinel the original already carried (sql.ErrNoRows, say).
func (e *wrappedKind) Unwrap() []error { return []error{e.err, e.kind} }
