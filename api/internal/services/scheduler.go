package services

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strconv"
	"time"
)

const igTokenRefreshWindow = 7 * 24 * time.Hour

type SchedulerService struct {
	authService      *AuthService
	postService      *PostService
	systemService    *SystemService
	mediaService     *MediaService
	settingsService  *SettingsService
	instagramService *InstagramService
}

func NewSchedulerService(authService *AuthService, postService *PostService, systemService *SystemService, mediaService *MediaService, settingsService *SettingsService, instagramService *InstagramService) *SchedulerService {
	return &SchedulerService{
		authService:      authService,
		postService:      postService,
		systemService:    systemService,
		mediaService:     mediaService,
		settingsService:  settingsService,
		instagramService: instagramService,
	}
}

func (s *SchedulerService) Start(ctx context.Context) {
	slog.Info("starting background scheduler")

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
				slog.Error("scheduler: media visibility update for scheduled posts failed",
					"posts", len(published), "error", err)
			}
		}
		return nil
	})

	// Daily task: Instagram token refresh (at 4 AM)
	go s.runDaily(ctx, "instagram token refresh", 4, s.refreshInstagramTokenIfNeeded)

	// Daily task: Backups (checked at 3 AM). The cadence (backup_interval_days)
	// and retention (backup_keep) are admin settings; the check runs daily but
	// only creates a backup when one is due, then prunes old ones.
	go s.runDaily(ctx, "daily backup", 3, func(ctx context.Context) error {
		enabled, _ := s.settingsService.GetSetting(ctx, "enable_backup", "true")
		if enabled != "true" {
			return nil
		}
		if !s.systemService.BackupDue(s.settingInt(ctx, "backup_interval_days", 1)) {
			return nil
		}
		if _, _, err := s.systemService.CreateBackup(ctx); err != nil {
			return err
		}
		_, err := s.systemService.RotateBackups(s.settingInt(ctx, "backup_keep", 7))
		return err
	})
}

// settingInt reads an integer setting, falling back to def when unset or unparseable.
func (s *SchedulerService) settingInt(ctx context.Context, key string, def int) int {
	v, _ := s.settingsService.GetSetting(ctx, key, "")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// runTask invokes one scheduled task, logging failures and recovering panics.
// The recover matters: task goroutines have no middleware.Recover like HTTP
// handlers do, so without it a panic in any background task kills the server.
func (s *SchedulerService) runTask(ctx context.Context, name string, task func(context.Context) error) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("scheduler task panicked",
				"task", name, "panic", r, "stack", string(debug.Stack()))
		}
	}()
	if err := task(ctx); err != nil {
		slog.Error("scheduler task failed", "task", name, "error", err)
	}
}

func (s *SchedulerService) runHourly(ctx context.Context, name string, task func(context.Context) error) {
	s.runPeriodic(ctx, name, 1*time.Hour, task)
}

func (s *SchedulerService) runPeriodic(ctx context.Context, name string, interval time.Duration, task func(context.Context) error) {
	// Run once at start
	s.runTask(ctx, name, task)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runTask(ctx, name, task)
		}
	}
}

func (s *SchedulerService) refreshInstagramTokenIfNeeded(ctx context.Context) error {
	expiresAtStr, err := s.settingsService.GetSecret(ctx, "instagram_token_expires_at")
	if err != nil || expiresAtStr == "" {
		return nil // not connected
	}
	expiresAt, err := time.Parse(time.RFC3339, expiresAtStr)
	if err != nil {
		return fmt.Errorf("instagram token refresh: parse expiry: %w", err)
	}
	if time.Until(expiresAt) > igTokenRefreshWindow {
		return nil // not close enough to expiry
	}
	newToken, expiresIn, err := s.instagramService.RefreshLongLivedToken(ctx)
	if err != nil {
		return fmt.Errorf("instagram token refresh: %w", err)
	}
	newExpiresAt := time.Now().Add(time.Duration(expiresIn) * time.Second).UTC().Format(time.RFC3339)
	if err := s.settingsService.SetSecret(ctx, "instagram_access_token", newToken); err != nil {
		return fmt.Errorf("instagram token refresh: save token: %w", err)
	}
	if err := s.settingsService.SetSecret(ctx, "instagram_token_expires_at", newExpiresAt); err != nil {
		return fmt.Errorf("instagram token refresh: save expiry: %w", err)
	}
	slog.Info("scheduler: instagram token refreshed", "expires_at", newExpiresAt)
	return nil
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
			s.runTask(ctx, name, task)
		}
	}
}
