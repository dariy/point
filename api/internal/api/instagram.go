package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"point-api/internal/config"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// instagramConnector is the subset of InstagramService used by this handler.
type instagramConnector interface {
	ExchangeCodeForLongLivedToken(ctx context.Context, code, redirectURI string) (string, string, int64, error)
	GetConnectedAccount(ctx context.Context) (username, igUserID, accountType string, err error)
}

// importState tracks a single in-flight (or recently finished) import run.
type importState struct {
	mu       sync.Mutex
	running  bool
	progress services.ImportProgress
	result   *services.ImportResult
	err      string
	startedAt time.Time
	finishedAt time.Time
}

type InstagramHandler struct {
	instagram instagramConnector
	importer  *services.InstagramImportService
	settings  *services.SettingsService
	cfg       *config.Config
	state     importState
}

func NewInstagramHandler(ig *services.InstagramService, importer *services.InstagramImportService, s *services.SettingsService, cfg *config.Config) *InstagramHandler {
	return &InstagramHandler{instagram: ig, importer: importer, settings: s, cfg: cfg}
}

// Connect redirects the admin to Meta's OAuth dialog.
// GET /api/instagram/connect
func (h *InstagramHandler) Connect(c echo.Context) error {
	ctx := c.Request().Context()

	appID, _ := h.settings.GetSecret(ctx, "instagram_app_id")
	if appID == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "Instagram App ID is not configured")
	}

	appURL := strings.TrimRight(strings.TrimSpace(h.cfg.AppURL), "/")
	if appURL == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "APP_URL must be configured for Instagram OAuth")
	}

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to generate state token")
	}
	state := hex.EncodeToString(raw)

	if err := h.settings.SetSecret(ctx, "instagram_oauth_state", state); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to store OAuth state")
	}

	params := url.Values{
		"client_id":     {appID},
		"display":       {"page"},
		"redirect_uri":  {appURL + "/api/instagram/callback"},
		"state":         {state},
		"scope":         {"instagram_basic,instagram_content_publish,pages_read_engagement,business_management,pages_show_list"},
		"response_type": {"code"},
	}
	return c.Redirect(http.StatusFound, "https://www.facebook.com/dialog/oauth?"+params.Encode())
}

// Callback handles the OAuth redirect from Meta.
// GET /api/instagram/callback
func (h *InstagramHandler) Callback(c echo.Context) error {
	ctx := c.Request().Context()

	if errMsg := c.QueryParam("error"); errMsg != "" {
		return echo.NewHTTPError(http.StatusBadRequest, "OAuth denied: "+errMsg)
	}

	code := c.QueryParam("code")
	state := c.QueryParam("state")
	if code == "" || state == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "missing code or state parameter")
	}

	storedState, _ := h.settings.GetSecret(ctx, "instagram_oauth_state")
	if storedState == "" || state != storedState {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid or expired OAuth state")
	}
	_ = h.settings.DeleteSecret(ctx, "instagram_oauth_state")

	appURL := strings.TrimRight(strings.TrimSpace(h.cfg.AppURL), "/")
	redirectURI := appURL + "/api/instagram/callback"

	token, _, expiresIn, err := h.instagram.ExchangeCodeForLongLivedToken(ctx, code, redirectURI)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "token exchange failed: "+err.Error())
	}

	expiresAt := time.Now().Add(time.Duration(expiresIn) * time.Second).UTC().Format(time.RFC3339)
	_ = h.settings.SetSecret(ctx, "instagram_access_token", token)
	_ = h.settings.SetSecret(ctx, "instagram_token_expires_at", expiresAt)

	username, igUserID, accountType, err := h.instagram.GetConnectedAccount(ctx)
	if err != nil {
		_ = h.settings.DeleteSecret(ctx, "instagram_access_token")
		_ = h.settings.DeleteSecret(ctx, "instagram_token_expires_at")
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to fetch Instagram account: "+err.Error())
	}

	if accountType == "PERSONAL" {
		_ = h.settings.DeleteSecret(ctx, "instagram_access_token")
		_ = h.settings.DeleteSecret(ctx, "instagram_token_expires_at")
		return c.Redirect(http.StatusFound, appURL+"/light/settings?error=instagram_personal#instagram")
	}

	_ = h.settings.SetSecret(ctx, "instagram_user_id", igUserID)
	_ = h.settings.SetSecret(ctx, "instagram_username", username)

	return c.Redirect(http.StatusFound, appURL+"/light/settings#instagram")
}

// Disconnect clears all stored Instagram credentials.
// POST /api/instagram/disconnect
func (h *InstagramHandler) Disconnect(c echo.Context) error {
	ctx := c.Request().Context()
	for _, key := range []string{
		"instagram_access_token",
		"instagram_user_id",
		"instagram_token_expires_at",
		"instagram_username",
		"instagram_oauth_state",
	} {
		_ = h.settings.DeleteSecret(ctx, key)
	}
	return c.JSON(http.StatusOK, echo.Map{"message": "disconnected"})
}

type InstagramStatusResponse struct {
	Connected      bool   `json:"connected"`
	Username       string `json:"username"`
	TokenExpiresAt string `json:"token_expires_at"`
	Enabled        bool   `json:"enabled"`
	DefaultShare   bool   `json:"default_share"`
}

// Status returns the Instagram connection status.
// GET /api/instagram/status
func (h *InstagramHandler) Status(c echo.Context) error {
	ctx := c.Request().Context()

	connected := h.settings.SecretIsSet(ctx, "instagram_access_token")
	username, _ := h.settings.GetSecret(ctx, "instagram_username")
	tokenExpiresAt, _ := h.settings.GetSecret(ctx, "instagram_token_expires_at")
	enabledStr, _ := h.settings.GetSetting(ctx, "enable_instagram", "false")
	enabled := enabledStr == "true" || enabledStr == "1"
	defaultShareStr, _ := h.settings.GetSetting(ctx, "instagram_default_share", "false")
	defaultShare := defaultShareStr == "true" || defaultShareStr == "1"

	return c.JSON(http.StatusOK, InstagramStatusResponse{
		Connected:      connected,
		Username:       username,
		TokenExpiresAt: tokenExpiresAt,
		Enabled:        enabled,
		DefaultShare:   defaultShare,
	})
}

// importStatusResponse is the JSON shape for GET /api/instagram/import/status.
type importStatusResponse struct {
	Running    bool                    `json:"running"`
	Imported   int                     `json:"imported"`
	Skipped    int                     `json:"skipped"`
	Errors     int                     `json:"errors"`
	StartedAt  string                  `json:"started_at,omitempty"`
	FinishedAt string                  `json:"finished_at,omitempty"`
	Progress   *services.ImportProgress `json:"progress,omitempty"`
	ErrorMsg   string                  `json:"error,omitempty"`
	Messages   []string                `json:"messages,omitempty"`
}

// triggerAuthorID returns the first admin user ID (1) for posts created during import.
// A proper implementation would look up the authenticated user from the session.
const triggerAuthorID int64 = 1

// StartImport kicks off a background import goroutine (one at a time).
// POST /api/instagram/import
func (h *InstagramHandler) StartImport(c echo.Context) error {
	ctx := c.Request().Context()

	// Guard: importer must be initialised.
	if h.importer == nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "import service not available")
	}
	// Guard: Instagram must be connected.
	if !h.settings.SecretIsSet(ctx, "instagram_access_token") {
		return echo.NewHTTPError(http.StatusBadRequest, "Instagram is not connected")
	}

	h.state.mu.Lock()
	if h.state.running {
		h.state.mu.Unlock()
		return c.JSON(http.StatusConflict, echo.Map{"message": "import already running"})
	}
	h.state.running = true
	h.state.result = nil
	h.state.err = ""
	h.state.progress = services.ImportProgress{}
	h.state.startedAt = time.Now()
	h.state.finishedAt = time.Time{}
	h.state.mu.Unlock()

	// Run in background.
	go func() {
		bgCtx := context.Background()
		result, err := h.importer.ImportAccount(bgCtx, triggerAuthorID, func(p services.ImportProgress) {
			h.state.mu.Lock()
			h.state.progress = p
			h.state.mu.Unlock()
		})

		h.state.mu.Lock()
		h.state.running = false
		h.state.finishedAt = time.Now()
		if err != nil {
			h.state.err = err.Error()
		} else {
			h.state.result = &result
		}
		h.state.mu.Unlock()

		// Persist summary to blog_settings for survival across restarts.
		if err == nil {
			summary, _ := json.Marshal(map[string]interface{}{
				"imported":    result.Imported,
				"skipped":     result.Skipped,
				"errors":      result.Errors,
				"finished_at": time.Now().UTC().Format(time.RFC3339),
			})
			_ = h.settings.SetSetting(bgCtx, "instagram_import_last_run", string(summary), "string")
		}
	}()

	return c.JSON(http.StatusAccepted, echo.Map{"message": "import started"})
}

// GetImportStatus returns the current (or last) import state.
// GET /api/instagram/import/status
func (h *InstagramHandler) GetImportStatus(c echo.Context) error {
	ctx := c.Request().Context()

	h.state.mu.Lock()
	running := h.state.running
	prog := h.state.progress
	result := h.state.result
	errMsg := h.state.err
	startedAt := h.state.startedAt
	finishedAt := h.state.finishedAt
	h.state.mu.Unlock()

	resp := importStatusResponse{Running: running}

	if running {
		resp.Progress = &prog
		resp.Imported = prog.Imported
		resp.Skipped = prog.Skipped
		resp.Errors = prog.Errors
		if !startedAt.IsZero() {
			resp.StartedAt = startedAt.UTC().Format(time.RFC3339)
		}
	} else if result != nil {
		resp.Imported = result.Imported
		resp.Skipped = result.Skipped
		resp.Errors = result.Errors
		resp.Messages = result.Messages
		if !startedAt.IsZero() {
			resp.StartedAt = startedAt.UTC().Format(time.RFC3339)
		}
		if !finishedAt.IsZero() {
			resp.FinishedAt = finishedAt.UTC().Format(time.RFC3339)
		}
	} else {
		// No in-memory state — fall back to persisted last-run summary.
		raw, _ := h.settings.GetSetting(ctx, "instagram_import_last_run", "")
		if raw != "" {
			var persisted struct {
				Imported   int    `json:"imported"`
				Skipped    int    `json:"skipped"`
				Errors     int    `json:"errors"`
				FinishedAt string `json:"finished_at"`
			}
			if json.Unmarshal([]byte(raw), &persisted) == nil {
				resp.Imported = persisted.Imported
				resp.Skipped = persisted.Skipped
				resp.Errors = persisted.Errors
				resp.FinishedAt = persisted.FinishedAt
			}
		}
	}

	resp.ErrorMsg = errMsg
	return c.JSON(http.StatusOK, resp)
}
