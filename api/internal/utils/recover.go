package utils

import (
	"log/slog"
	"runtime/debug"
)

// SafeGo runs fn in its own goroutine, recovering any panic and logging it
// with a stack trace instead of letting it take the process down.
//
// Background goroutines have no backstop: HTTP handlers sit behind
// middleware.Recover and scheduler tasks behind SchedulerService.runTask, but
// a bare `go func()` that panics crashes the whole server. name identifies the
// work in the log line.
func SafeGo(name string, fn func()) {
	go func() {
		defer Recovered(name)
		fn()
	}()
}

// Recovered is a deferred recover that logs a panic (with its stack) under
// name. Use it directly instead of SafeGo when the goroutine needs its own
// defer chain for cleanup:
//
//	go func() {
//		defer someCleanup()
//		defer utils.Recovered("instagram import")
//		...
//	}()
//
// It must be deferred directly (`defer utils.Recovered(name)`), not called from
// inside another deferred function — recover only works one call deep.
func Recovered(name string) {
	if r := recover(); r != nil {
		logPanic(name, r)
	}
}

// RecoveredFunc is Recovered plus a callback that receives the recovered value,
// for goroutines that must also reset shared state (a "running" flag, a
// progress struct) when they die by panic rather than by returning. Same
// direct-defer rule as Recovered.
func RecoveredFunc(name string, onPanic func(recovered any)) {
	if r := recover(); r != nil {
		logPanic(name, r)
		if onPanic != nil {
			onPanic(r)
		}
	}
}

func logPanic(name string, r any) {
	slog.Error("background goroutine panicked",
		"goroutine", name, "panic", r, "stack", string(debug.Stack()))
}
