package services

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

type RemarkSupervisor struct {
	settings *SettingsService
	cmd      *exec.Cmd
	mu       sync.Mutex
	cancel   context.CancelFunc
	done     chan struct{} // closed when the current process has fully exited
}

func NewRemarkSupervisor(settings *SettingsService) *RemarkSupervisor {
	return &RemarkSupervisor{
		settings: settings,
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
		if smtpHost == "" {
			slog.Warn("RemarkSupervisor: email login enabled but remark_smtp_host is not set; login emails cannot be sent")
		}
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
