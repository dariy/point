package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
	"time"

	"point-api/internal/config"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// instagramConnector is the subset of InstagramService used by this handler.
type instagramConnector interface {
	ExchangeCodeForLongLivedToken(ctx context.Context, code, redirectURI string) (string, string, int64, error)
	GetConnectedAccount(ctx context.Context) (username, igUserID string, err error)
}

type InstagramHandler struct {
	instagram instagramConnector
	settings  *services.SettingsService
	cfg       *config.Config
}

func NewInstagramHandler(ig *services.InstagramService, s *services.SettingsService, cfg *config.Config) *InstagramHandler {
	return &InstagramHandler{instagram: ig, settings: s, cfg: cfg}
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
		"redirect_uri":  {appURL + "/api/instagram/callback"},
		"state":         {state},
		"scope":         {"instagram_business_basic,instagram_business_content_publish"},
		"response_type": {"code"},
	}
	return c.Redirect(http.StatusFound, "https://www.instagram.com/oauth/authorize?"+params.Encode())
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

	token, userID, expiresIn, err := h.instagram.ExchangeCodeForLongLivedToken(ctx, code, redirectURI)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "token exchange failed: "+err.Error())
	}

	expiresAt := time.Now().Add(time.Duration(expiresIn) * time.Second).UTC().Format(time.RFC3339)
	_ = h.settings.SetSecret(ctx, "instagram_access_token", token)
	_ = h.settings.SetSecret(ctx, "instagram_token_expires_at", expiresAt)

	username, _, err := h.instagram.GetConnectedAccount(ctx)
	if err != nil {
		_ = h.settings.DeleteSecret(ctx, "instagram_access_token")
		_ = h.settings.DeleteSecret(ctx, "instagram_token_expires_at")
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to fetch Instagram account: "+err.Error())
	}
	_ = h.settings.SetSecret(ctx, "instagram_user_id", userID)
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
