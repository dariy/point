package services

import (
	"context"
	"fmt"
	"time"
)

type SchedulerService struct {
	authService     *AuthService
	postService     *PostService
	systemService   *SystemService
	mediaService    *MediaService
	settingsService *SettingsService
}

func NewSchedulerService(authService *AuthService, postService *PostService, systemService *SystemService, mediaService *MediaService, settingsService *SettingsService) *SchedulerService {
	return &SchedulerService{
		authService:     authService,
		postService:     postService,
		systemService:   systemService,
		mediaService:    mediaService,
		settingsService: settingsService,
	}
}

func (s *SchedulerService) Start(ctx context.Context) {
	fmt.Println("Starting background scheduler...")

	// Hourly task: Session cleanup
	go s.runHourly(ctx, "session cleanup", s.authService.CleanupExpiredSessions)

	// Periodic task: View count flushing (every 5 minutes)
	go s.runPeriodic(ctx, "view count flushing", 5*time.Minute, s.postService.FlushViewCounts)

	// Periodic task: Publish scheduled posts (every 1 minute)
	go s.runPeriodic(ctx, "scheduled post publishing", 1*time.Minute, func(ctx context.Context) error {
		published, err := s.postService.PublishDueScheduledPosts(ctx)
		if err != nil {
			return err
		}
		if len(published) == 0 {
			return nil
		}
		var allPaths []string
		for _, post := range published {
			allPaths = append(allPaths, ExtractMediaPaths(post.Content, post.ThumbnailPath.String)...)
		}
		if len(allPaths) > 0 {
			if err := s.mediaService.UpdateMediaVisibilityForPaths(ctx, allPaths); err != nil {
				fmt.Printf("Scheduler: failed to update media visibility for %d scheduled post(s): %v\n", len(published), err)
			}
		}
		return nil
	})

	// Daily task: Backups (at 3 AM)
	go s.runDaily(ctx, "daily backup", 3, func(ctx context.Context) error {
		enabled, _ := s.settingsService.GetSetting(ctx, "enable_backup", "true")
		if enabled != "true" {
			return nil
		}
		_, _, err := s.systemService.CreateBackup(ctx)
		return err
	})
}

func (s *SchedulerService) runHourly(ctx context.Context, name string, task func(context.Context) error) {
	// Run once at start
	if err := task(ctx); err != nil {
		fmt.Printf("Scheduler task %s (initial) failed: %v\n", name, err)
	}

	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := task(ctx); err != nil {
				fmt.Printf("Scheduler task %s failed: %v\n", name, err)
			}
		}
	}
}

func (s *SchedulerService) runPeriodic(ctx context.Context, name string, interval time.Duration, task func(context.Context) error) {
	// Run once at start
	if err := task(ctx); err != nil {
		fmt.Printf("Scheduler task %s (initial) failed: %v\n", name, err)
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := task(ctx); err != nil {
				fmt.Printf("Scheduler task %s failed: %v\n", name, err)
			}
		}
	}
}

func (s *SchedulerService) runDaily(ctx context.Context, name string, hour int, task func(context.Context) error) {
	for {
		now := time.Now()
		next := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, now.Location())
		if next.Before(now) {
			next = next.Add(24 * time.Hour)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(next.Sub(now)):
			if err := task(ctx); err != nil {
				fmt.Printf("Scheduler task %s failed: %v\n", name, err)
			}
		}
	}
}
