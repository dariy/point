package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type InstagramService struct {
	settingsService *SettingsService
	apiBaseURL      string // api.instagram.com — OAuth token exchange
	graphBaseURL    string // graph.instagram.com — Graph API calls
	httpClient      *http.Client
}

func NewInstagramService(settingsService *SettingsService) *InstagramService {
	return &InstagramService{
		settingsService: settingsService,
		apiBaseURL:      "https://api.instagram.com",
		graphBaseURL:    "https://graph.instagram.com",
		httpClient:      &http.Client{Timeout: 30 * time.Second},
	}
}

// withBaseURL returns a shallow copy with both base URLs overridden (tests only).
func (s *InstagramService) withBaseURL(u string) *InstagramService {
	clone := *s
	clone.apiBaseURL = u
	clone.graphBaseURL = u
	return &clone
}

type igTokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
}

type igContainerResponse struct {
	ID string `json:"id"`
}

type igAPIError struct {
	Error struct {
		Message string `json:"message"`
		Code    int    `json:"code"`
	} `json:"error"`
}

func (s *InstagramService) secret(ctx context.Context, key string) (string, error) {
	val, err := s.settingsService.GetSecret(ctx, key)
	if err != nil || val == "" {
		return "", fmt.Errorf("instagram: secret %q not configured", key)
	}
	return val, nil
}

func (s *InstagramService) get(ctx context.Context, rawURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		var apiErr igAPIError
		if json.Unmarshal(body, &apiErr) == nil && apiErr.Error.Message != "" {
			return nil, fmt.Errorf("instagram API error %d: %s", apiErr.Error.Code, apiErr.Error.Message)
		}
		return nil, fmt.Errorf("instagram API HTTP %d", resp.StatusCode)
	}
	return body, nil
}

func (s *InstagramService) post(ctx context.Context, rawURL string, params url.Values) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, strings.NewReader(params.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		var apiErr igAPIError
		if json.Unmarshal(body, &apiErr) == nil && apiErr.Error.Message != "" {
			return nil, fmt.Errorf("instagram API error %d: %s", apiErr.Error.Code, apiErr.Error.Message)
		}
		return nil, fmt.Errorf("instagram API HTTP %d", resp.StatusCode)
	}
	return body, nil
}

// ExchangeCodeForLongLivedToken exchanges an OAuth authorization code for a
// long-lived Instagram access token. Returns the token and seconds until expiry.
// Two Graph API calls are made: code → short-lived token, then short-lived → long-lived.
func (s *InstagramService) ExchangeCodeForLongLivedToken(ctx context.Context, code, redirectURI string) (string, int64, error) {
	appID, err := s.secret(ctx, "instagram_app_id")
	if err != nil {
		return "", 0, err
	}
	appSecret, err := s.secret(ctx, "instagram_app_secret")
	if err != nil {
		return "", 0, err
	}

	shortParams := url.Values{
		"client_id":     {appID},
		"client_secret": {appSecret},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {redirectURI},
		"code":          {code},
	}
	body, err := s.post(ctx, s.apiBaseURL+"/oauth/access_token", shortParams)
	if err != nil {
		return "", 0, fmt.Errorf("exchange code: %w", err)
	}
	var shortToken igTokenResponse
	if err := json.Unmarshal(body, &shortToken); err != nil {
		return "", 0, fmt.Errorf("decode short-lived token: %w", err)
	}

	longParams := url.Values{
		"grant_type":   {"ig_exchange_token"},
		"client_secret": {appSecret},
		"access_token": {shortToken.AccessToken},
	}
	body2, err := s.get(ctx, s.graphBaseURL+"/access_token?"+longParams.Encode())
	if err != nil {
		return "", 0, fmt.Errorf("exchange long-lived token: %w", err)
	}
	var longToken igTokenResponse
	if err := json.Unmarshal(body2, &longToken); err != nil {
		return "", 0, fmt.Errorf("decode long-lived token: %w", err)
	}
	return longToken.AccessToken, longToken.ExpiresIn, nil
}

// RefreshLongLivedToken refreshes the stored long-lived token before expiry.
// Returns the new token and seconds until expiry.
func (s *InstagramService) RefreshLongLivedToken(ctx context.Context) (string, int64, error) {
	token, err := s.secret(ctx, "instagram_access_token")
	if err != nil {
		return "", 0, err
	}
	params := url.Values{
		"grant_type":   {"ig_refresh_token"},
		"access_token": {token},
	}
	body, err := s.get(ctx, s.graphBaseURL+"/refresh_access_token?"+params.Encode())
	if err != nil {
		return "", 0, fmt.Errorf("refresh token: %w", err)
	}
	var resp igTokenResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", 0, fmt.Errorf("decode refresh response: %w", err)
	}
	return resp.AccessToken, resp.ExpiresIn, nil
}

// GetConnectedAccount returns the username and IG user ID for the stored token.
func (s *InstagramService) GetConnectedAccount(ctx context.Context) (username, igUserID string, err error) {
	token, err := s.secret(ctx, "instagram_access_token")
	if err != nil {
		return "", "", err
	}
	params := url.Values{
		"fields":       {"id,username"},
		"access_token": {token},
	}
	body, err := s.get(ctx, s.graphBaseURL+"/me?"+params.Encode())
	if err != nil {
		return "", "", fmt.Errorf("get connected account: %w", err)
	}
	var result struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", "", fmt.Errorf("decode account response: %w", err)
	}
	return result.Username, result.ID, nil
}

// CreateImageContainer creates a single-image media container on Instagram.
func (s *InstagramService) CreateImageContainer(ctx context.Context, imageURL, caption string) (string, error) {
	token, err := s.secret(ctx, "instagram_access_token")
	if err != nil {
		return "", err
	}
	igUserID, err := s.secret(ctx, "instagram_user_id")
	if err != nil {
		return "", err
	}
	params := url.Values{
		"image_url":    {imageURL},
		"caption":      {caption},
		"access_token": {token},
	}
	body, err := s.post(ctx, fmt.Sprintf("%s/%s/media", s.graphBaseURL, igUserID), params)
	if err != nil {
		return "", fmt.Errorf("create image container: %w", err)
	}
	var resp igContainerResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("decode container response: %w", err)
	}
	return resp.ID, nil
}

// CreateCarouselChild creates a carousel child container for one image.
func (s *InstagramService) CreateCarouselChild(ctx context.Context, imageURL string) (string, error) {
	token, err := s.secret(ctx, "instagram_access_token")
	if err != nil {
		return "", err
	}
	igUserID, err := s.secret(ctx, "instagram_user_id")
	if err != nil {
		return "", err
	}
	params := url.Values{
		"image_url":        {imageURL},
		"is_carousel_item": {"true"},
		"access_token":     {token},
	}
	body, err := s.post(ctx, fmt.Sprintf("%s/%s/media", s.graphBaseURL, igUserID), params)
	if err != nil {
		return "", fmt.Errorf("create carousel child: %w", err)
	}
	var resp igContainerResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("decode container response: %w", err)
	}
	return resp.ID, nil
}

// CreateCarousel creates a carousel container from child container IDs.
func (s *InstagramService) CreateCarousel(ctx context.Context, childIDs []string, caption string) (string, error) {
	token, err := s.secret(ctx, "instagram_access_token")
	if err != nil {
		return "", err
	}
	igUserID, err := s.secret(ctx, "instagram_user_id")
	if err != nil {
		return "", err
	}
	params := url.Values{
		"media_type":   {"CAROUSEL"},
		"children":     {strings.Join(childIDs, ",")},
		"caption":      {caption},
		"access_token": {token},
	}
	body, err := s.post(ctx, fmt.Sprintf("%s/%s/media", s.graphBaseURL, igUserID), params)
	if err != nil {
		return "", fmt.Errorf("create carousel: %w", err)
	}
	var resp igContainerResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("decode container response: %w", err)
	}
	return resp.ID, nil
}

// PublishContainer publishes a media container to Instagram.
func (s *InstagramService) PublishContainer(ctx context.Context, creationID string) (string, error) {
	token, err := s.secret(ctx, "instagram_access_token")
	if err != nil {
		return "", err
	}
	igUserID, err := s.secret(ctx, "instagram_user_id")
	if err != nil {
		return "", err
	}
	params := url.Values{
		"creation_id":  {creationID},
		"access_token": {token},
	}
	body, err := s.post(ctx, fmt.Sprintf("%s/%s/media_publish", s.graphBaseURL, igUserID), params)
	if err != nil {
		return "", fmt.Errorf("publish container: %w", err)
	}
	var resp igContainerResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("decode publish response: %w", err)
	}
	return resp.ID, nil
}
