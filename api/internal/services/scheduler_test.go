package services

import (
	"context"
	"errors"
	"testing"
)

// A panicking task must not propagate — background goroutines have no
// middleware.Recover, so an unrecovered panic would kill the server.
func TestSchedulerRunTaskRecoversPanic(t *testing.T) {
	s := &SchedulerService{}
	s.runTask(context.Background(), "boom", func(context.Context) error {
		panic("kaboom")
	})
	// Reaching this line means the panic was recovered.
}

func TestSchedulerRunTaskLogsErrorWithoutPanic(t *testing.T) {
	s := &SchedulerService{}
	s.runTask(context.Background(), "fails", func(context.Context) error {
		return errors.New("nope")
	})
}
