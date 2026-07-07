package services

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"point-api/internal/repository"
	"strings"
	"sync"
	"syscall"
	"time"
)

type RemarkSupervisor struct {
	settings *SettingsService
	repo     repository.Repository
	cmd      *exec.Cmd
	mu       sync.Mutex
	cancel   context.CancelFunc
	done     chan struct{} // closed when the current process has fully exited
}

func NewRemarkSupervisor(settings *SettingsService, repo repository.Repository) *RemarkSupervisor {
	return &RemarkSupervisor{
		settings: settings,
		repo:     repo,
	}
}

// Start launches the remark42 sidecar. If REMARK_URL or REMARK_SECRET are missing, it silently skips.
func (s *RemarkSupervisor) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.startLocked()
}

func (s *RemarkSupervisor) startLocked() {
	if os.Getenv("REMARK_URL") == "" || os.Getenv("REMARK_SECRET") == "" {
		slog.Info("RemarkSupervisor: REMARK_URL or REMARK_SECRET not set, not starting comments engine")
		return
	}
	// Outside the packaged container (local dev) there is no bundled binary;
	// remark42 runs as a sidecar container instead (scripts/run-remark42-local.sh)
	// and the /comments proxy reaches it on the same port.
	if _, err := os.Stat("/app/remark42/remark42"); err != nil {
		slog.Info("RemarkSupervisor: no bundled remark42 binary, assuming external comments engine on :8081")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel

	// Bake REMARK_URL into the web assets before starting
	// equivalent to: find /app/remark42/web -regex '.*\.\(html\|js\|mjs\)$' -exec sed -i "s|{% REMARK_URL %}|${REMARK_URL}|g" {} \;
	remarkURL := os.Getenv("REMARK_URL")
	webDir := "/app/remark42/web"
	if _, err := os.Stat(webDir); err == nil {
		_ = filepath.Walk(webDir, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			ext := filepath.Ext(path)
			if ext == ".html" || ext == ".js" || ext == ".mjs" {
				b, err := os.ReadFile(path)
				if err == nil && bytes.Contains(b, []byte("{% REMARK_URL %}")) {
					b = bytes.ReplaceAll(b, []byte("{% REMARK_URL %}"), []byte(remarkURL))
					_ = os.WriteFile(path, b, info.Mode())
				}
			}
			return nil
		})
	}

	cmd := exec.CommandContext(ctx, "/app/remark42/remark42", "server")
	// Put remark42 in its own process group to prevent signals like SIGINT from killing it before the context does
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// Graceful stop: SIGTERM on context cancel so bolt closes cleanly; SIGKILL
	// only if it hasn't exited after WaitDelay.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 5 * time.Second

	env := os.Environ()
	env = append(env, "SECRET="+os.Getenv("REMARK_SECRET"))
	env = append(env, "SITE=remark")
	env = append(env, "REMARK_ADDRESS=127.0.0.1")
	env = append(env, "REMARK_PORT=8081")
	env = append(env, "STORE_BOLT_PATH=/data/remark42")
	env = append(env, "BACKUP_PATH=/data/remark42/backup")
	env = append(env, "AVATAR_FS_PATH=/data/remark42/avatars")
	env = append(env, "IMAGE_FS_PATH=/data/remark42/pictures")

	if pwd := os.Getenv("ADMIN_PASSWD"); pwd != "" {
		env = append(env, "ADMIN_PASSWD="+pwd)
	}

	bgCtx := context.Background()

	anon, _ := s.settings.GetSetting(bgCtx, "remark_auth_anon", "true")
	env = append(env, "AUTH_ANON="+anon)

	env = append(env,
		"AUTH_CUSTOM_NAME=point",
		"AUTH_CUSTOM_CID=point",
		"AUTH_CUSTOM_CSEC=point",
		"AUTH_CUSTOM_AUTH_URL="+remarkURL,
		"AUTH_CUSTOM_TOKEN_URL="+remarkURL,
		"AUTH_CUSTOM_INFO_URL="+remarkURL,
	)

	// OAuth creds are stored via SetSecret (secrets table), not SetSetting.
	githubCID, _ := s.settings.GetSecret(bgCtx, "remark_auth_github_cid")
	githubCSEC, _ := s.settings.GetSecret(bgCtx, "remark_auth_github_csec")
	if githubCID != "" && githubCSEC != "" {
		env = append(env, "AUTH_GITHUB_CID="+githubCID)
		env = append(env, "AUTH_GITHUB_CSEC="+githubCSEC)
	}

	googleCID, _ := s.settings.GetSecret(bgCtx, "remark_auth_google_cid")
	googleCSEC, _ := s.settings.GetSecret(bgCtx, "remark_auth_google_csec")
	if googleCID != "" && googleCSEC != "" {
		env = append(env, "AUTH_GOOGLE_CID="+googleCID)
		env = append(env, "AUTH_GOOGLE_CSEC="+googleCSEC)
	}

	emailEnable, _ := s.settings.GetSetting(bgCtx, "remark_auth_email_enable", "false")
	if emailEnable == "true" {
		env = append(env, "AUTH_EMAIL_ENABLE=true")

		smtpHost, _ := s.settings.GetSetting(bgCtx, "remark_smtp_host", "")
		if smtpHost != "" {
			// Admin-UI SMTP settings (Settings → Comments).
			smtpPort, _ := s.settings.GetSetting(bgCtx, "remark_smtp_port", "587")
			smtpUser, _ := s.settings.GetSetting(bgCtx, "remark_smtp_username", "")
			smtpPass, _ := s.settings.GetSecret(bgCtx, "remark_smtp_password")
			smtpTLS, _ := s.settings.GetSetting(bgCtx, "remark_smtp_tls", "true")
			emailFrom, _ := s.settings.GetSetting(bgCtx, "remark_email_from", "")
			env = append(env,
				"SMTP_HOST="+smtpHost,
				"SMTP_PORT="+smtpPort,
				"SMTP_USERNAME="+smtpUser,
				"SMTP_PASSWORD="+smtpPass,
				"SMTP_TLS="+smtpTLS,
				"AUTH_EMAIL_FROM="+emailFrom,
			)
		} else if smtpEnv := smtpEnvFallback(os.Getenv); smtpEnv != nil {
			// No admin-UI SMTP config: reuse the engine's SMTP_* .env vars
			// (the ones password reset uses — Mailgun, Brevo, self-hosted,
			// anything with an SMTP relay) so email is configured once.
			env = append(env, smtpEnv...)
		} else {
			slog.Warn("RemarkSupervisor: email login enabled but no SMTP configured (remark_smtp_host setting or SMTP_HOST in .env); login emails cannot be sent")
		}
	}

	telegramToken, _ := s.settings.GetSecret(bgCtx, "remark_telegram_token")
	telegramChan, _ := s.settings.GetSetting(bgCtx, "remark_telegram_chan", "")
	if telegramToken != "" && telegramChan != "" {
		env = append(env,
			"NOTIFY_ADMINS=telegram",
			"TELEGRAM_TOKEN="+telegramToken,
			"NOTIFY_TELEGRAM_CHAN="+telegramChan,
		)
	}

	// Add all Point users as Remark42 admins
	if s.repo != nil {
		rows, err := s.repo.DB().QueryContext(bgCtx, "SELECT id FROM users")
		if err == nil {
			defer func() { _ = rows.Close() }()
			var adminIDs []string
			for rows.Next() {
				var id int64
				if err := rows.Scan(&id); err == nil {
					adminIDs = append(adminIDs, fmt.Sprintf("point_%d", id))
				}
			}
			if len(adminIDs) > 0 {
				env = append(env, "ADMIN_SHARED_ID="+strings.Join(adminIDs, ","))
			}
		}
	}

	cmd.Env = env
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		slog.Error("RemarkSupervisor: failed to start remark42", "err", err)
		return
	}
	s.cmd = cmd
	done := make(chan struct{})
	s.done = done
	slog.Info("RemarkSupervisor: started remark42", "pid", cmd.Process.Pid)

	go func() {
		err := cmd.Wait()
		slog.Info("RemarkSupervisor: remark42 exited", "err", err)
		close(done)
		if ctx.Err() != nil {
			return // intentional stop (Restart cancelled the context)
		}
		// Crash: relaunch so comments come back without a container restart.
		// ponytail: fixed 5s backoff; make it exponential if it ever flaps hard.
		time.Sleep(5 * time.Second)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.done == done { // no concurrent Restart got here first
			slog.Info("RemarkSupervisor: restarting remark42 after crash")
			s.startLocked()
		}
	}()
}

// smtpEnvFallback builds remark42 SMTP env entries from the engine's own
// SMTP_* variables. Returns nil when SMTP_HOST is unset. remark42 uses
// SMTP_TLS for implicit TLS (port 465) and SMTP_STARTTLS otherwise (587),
// matching what SendEmail infers from the port.
func smtpEnvFallback(getenv func(string) string) []string {
	host := getenv("SMTP_HOST")
	if host == "" {
		return nil
	}
	port := getenv("SMTP_PORT")
	if port == "" {
		port = "587"
	}
	from := getenv("SMTP_FROM")
	if from == "" {
		from = getenv("SMTP_USERNAME")
	}
	tlsFlag := "SMTP_STARTTLS=true"
	if port == "465" {
		tlsFlag = "SMTP_TLS=true"
	}
	return []string{
		"SMTP_HOST=" + host,
		"SMTP_PORT=" + port,
		"SMTP_USERNAME=" + getenv("SMTP_USERNAME"),
		"SMTP_PASSWORD=" + getenv("SMTP_PASSWORD"),
		tlsFlag,
		"AUTH_EMAIL_FROM=" + from,
	}
}

// Restart stops the current sidecar process (if any) and starts a new one with fresh settings.
func (s *RemarkSupervisor) Restart() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.cancel != nil {
		s.cancel() // Sends SIGKILL to the process
	}
	if s.done != nil {
		// Wait for the old process to fully exit and release port 8081.
		// (cmd.Wait is owned by the goroutine in startLocked; a second Wait
		// call would return immediately with an error, not block.)
		<-s.done
	}
	s.startLocked()
}
