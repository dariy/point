package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type InstagramService struct {
	settingsService      *SettingsService
	apiBaseURL           string // graph.facebook.com — OAuth token exchange
	graphBaseURL         string // graph.facebook.com — Graph API calls
	httpClient           *http.Client
	containerWaitInitial time.Duration // wait before first status poll
	containerWaitPoll    time.Duration // wait between subsequent polls
}

func NewInstagramService(settingsService *SettingsService) *InstagramService {
	return &InstagramService{
		settingsService:      settingsService,
		apiBaseURL:           "https://graph.facebook.com/v25.0",
		graphBaseURL:         "https://graph.facebook.com/v25.0",
		httpClient:           &http.Client{Timeout: 30 * time.Second},
		containerWaitInitial: 2 * time.Second,
		containerWaitPoll:    4 * time.Second,
	}
}

// withBaseURL returns a shallow copy with both base URLs overridden and poll
// intervals zeroed (tests only).
func (s *InstagramService) withBaseURL(u string) *InstagramService {
	clone := *s
	clone.apiBaseURL = u
	clone.graphBaseURL = u
	clone.containerWaitInitial = 0
	clone.containerWaitPoll = 0
	return &clone
}

type igTokenResponse struct {
	AccessToken string      `json:"access_token"`
	UserID      json.Number `json:"user_id"`
	ExpiresIn   int64       `json:"expires_in"`
}

type igContainerResponse struct {
	ID string `json:"id"`
}

type igContainerStatus struct {
	StatusCode string `json:"status_code"`
	Status     string `json:"status"`
}

type igAPIError struct {
	Error struct {
		Message        string `json:"message"`
		Code           int    `json:"code"`
		ErrorSubcode   int    `json:"error_subcode"`
		ErrorUserTitle string `json:"error_user_title"`
		ErrorUserMsg   string `json:"error_user_msg"`
		FbtraceID      string `json:"fbtrace_id"`
	} `json:"error"`
}

func (s *InstagramService) secret(ctx context.Context, key string) (string, error) {
	val, err := s.settingsService.GetSecret(ctx, key)
	if err != nil || val == "" {
		return "", fmt.Errorf("instagram: secret %q not configured", key)
	}
	return val, nil
}

// redactTransportErr strips the request URL from a transport error before it
// can be logged or stored: Graph API URLs carry access_token in the query
// string, and url.Error embeds the full URL. The path (no query) is kept for
// diagnosability.
func redactTransportErr(op string, req *http.Request, err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return fmt.Errorf("instagram API %s %s: %w", op, req.URL.Path, err)
}

func (s *InstagramService) get(ctx context.Context, rawURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		// The parse error may embed the raw URL (token included) — drop it.
		return nil, fmt.Errorf("instagram API: invalid request URL")
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, redactTransportErr("GET", req, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		var apiErr igAPIError
		if json.Unmarshal(body, &apiErr) == nil && apiErr.Error.Message != "" {
			msg := apiErr.Error.Message
			if apiErr.Error.ErrorUserMsg != "" {
				msg = apiErr.Error.ErrorUserMsg
			}
			return nil, fmt.Errorf("instagram API error %d (subcode %d, fbtrace %s): %s", apiErr.Error.Code, apiErr.Error.ErrorSubcode, apiErr.Error.FbtraceID, msg)
		}
		return nil, fmt.Errorf("instagram API HTTP %d", resp.StatusCode)
	}
	return body, nil
}

func (s *InstagramService) post(ctx context.Context, rawURL string, params url.Values) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, strings.NewReader(params.Encode()))
	if err != nil {
		// The parse error may embed the raw URL (token included) — drop it.
		return nil, fmt.Errorf("instagram API: invalid request URL")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, redactTransportErr("POST", req, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		var apiErr igAPIError
		if json.Unmarshal(body, &apiErr) == nil && apiErr.Error.Message != "" {
			msg := apiErr.Error.Message
			if apiErr.Error.ErrorUserMsg != "" {
				msg = apiErr.Error.ErrorUserMsg
			}
			return nil, fmt.Errorf("instagram API error %d (subcode %d, fbtrace %s): %s", apiErr.Error.Code, apiErr.Error.ErrorSubcode, apiErr.Error.FbtraceID, msg)
		}
		return nil, fmt.Errorf("instagram API HTTP %d", resp.StatusCode)
	}
	return body, nil
}

// ExchangeCodeForLongLivedToken exchanges an OAuth authorization code for a
// long-lived Instagram access token. Returns the token, the canonical user ID
// from the short-lived token response, and seconds until expiry.
// Two Graph API calls are made: code → short-lived token, then short-lived → long-lived.
func (s *InstagramService) ExchangeCodeForLongLivedToken(ctx context.Context, code, redirectURI string) (string, string, int64, error) {
	appID, err := s.secret(ctx, "instagram_app_id")
	if err != nil {
		return "", "", 0, err
	}
	appSecret, err := s.secret(ctx, "instagram_app_secret")
	if err != nil {
		return "", "", 0, err
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
		return "", "", 0, fmt.Errorf("exchange code: %w", err)
	}
	var shortToken igTokenResponse
	if err := json.Unmarshal(body, &shortToken); err != nil {
		return "", "", 0, fmt.Errorf("decode short-lived token: %w", err)
	}

	longParams := url.Values{
		"grant_type":        {"fb_exchange_token"},
		"client_id":         {appID},
		"client_secret":     {appSecret},
		"fb_exchange_token": {shortToken.AccessToken},
	}
	body2, err := s.get(ctx, s.graphBaseURL+"/oauth/access_token?"+longParams.Encode())
	if err != nil {
		return "", "", 0, fmt.Errorf("exchange long-lived token: %w", err)
	}
	var longToken igTokenResponse
	if err := json.Unmarshal(body2, &longToken); err != nil {
		return "", "", 0, fmt.Errorf("decode long-lived token: %w", err)
	}
	return longToken.AccessToken, shortToken.UserID.String(), longToken.ExpiresIn, nil
}

// ExchangeShortLivedForLongLived exchanges a short-lived user access token (received
// directly via response_type=token OAuth flow) for a long-lived token.
func (s *InstagramService) ExchangeShortLivedForLongLived(ctx context.Context, shortLivedToken string) (string, int64, error) {
	appID, err := s.secret(ctx, "instagram_app_id")
	if err != nil {
		return "", 0, err
	}
	appSecret, err := s.secret(ctx, "instagram_app_secret")
	if err != nil {
		return "", 0, err
	}

	params := url.Values{
		"grant_type":        {"fb_exchange_token"},
		"client_id":         {appID},
		"client_secret":     {appSecret},
		"fb_exchange_token": {shortLivedToken},
	}
	body, err := s.get(ctx, s.graphBaseURL+"/oauth/access_token?"+params.Encode())
	if err != nil {
		return "", 0, fmt.Errorf("exchange long-lived token: %w", err)
	}
	var resp igTokenResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", 0, fmt.Errorf("decode long-lived token: %w", err)
	}
	return resp.AccessToken, resp.ExpiresIn, nil
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

// GetConnectedAccount returns the username, IG user ID, and account_type for the stored token.
// Business Login returns a Facebook User token; the Instagram account is retrieved via
// the connected Facebook Page using the /me/accounts endpoint.
func (s *InstagramService) GetConnectedAccount(ctx context.Context) (username, igUserID, accountType string, err error) {
	token, err := s.secret(ctx, "instagram_access_token")
	if err != nil {
		return "", "", "", err
	}
	params := url.Values{
		"fields":       {"instagram_business_account{id,username}"},
		"access_token": {token},
	}
	body, err := s.get(ctx, s.graphBaseURL+"/me/accounts?"+params.Encode())
	if err != nil {
		return "", "", "", fmt.Errorf("get connected account: %w", err)
	}
	var result struct {
		Data []struct {
			InstagramBusinessAccount *struct {
				ID       json.Number `json:"id"`
				Username string      `json:"username"`
			} `json:"instagram_business_account"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", "", "", fmt.Errorf("decode account response: %w", err)
	}
	for _, page := range result.Data {
		if page.InstagramBusinessAccount != nil {
			acc := page.InstagramBusinessAccount
			// Business Login only surfaces Business/Creator accounts — Personal accounts
			// don't expose an instagram_business_account node.
			return acc.Username, acc.ID.String(), "BUSINESS", nil
		}
	}
	return "", "", "", fmt.Errorf("get connected account: no Instagram Business Account linked to your Facebook Pages")
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

// WaitForContainerReady polls the container status until it is FINISHED,
// returning an error if the container reaches ERROR or EXPIRED state.
// Callers should pass a context with a deadline to bound total wait time.
func (s *InstagramService) WaitForContainerReady(ctx context.Context, containerID string) error {
	token, err := s.secret(ctx, "instagram_access_token")
	if err != nil {
		return err
	}

	if s.containerWaitInitial > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.containerWaitInitial):
		}
	}

	params := url.Values{
		"fields":       {"status_code,status"},
		"access_token": {token},
	}
	rawURL := fmt.Sprintf("%s/%s?%s", s.graphBaseURL, containerID, params.Encode())

	for {
		body, err := s.get(ctx, rawURL)
		if err != nil {
			return fmt.Errorf("poll container %s: %w", containerID, err)
		}
		var cs igContainerStatus
		if err := json.Unmarshal(body, &cs); err != nil {
			return fmt.Errorf("decode container status: %w", err)
		}
		switch cs.StatusCode {
		case "FINISHED":
			return nil
		case "ERROR", "EXPIRED":
			msg := cs.Status
			if msg == "" {
				msg = cs.StatusCode
			}
			return fmt.Errorf("container %s: %s", cs.StatusCode, msg)
		}
		// IN_PROGRESS or unknown — wait then retry
		if s.containerWaitPoll > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(s.containerWaitPoll):
			}
		}
	}
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

// InstagramMediaChild is one image/video inside a CAROUSEL_ALBUM.
type InstagramMediaChild struct {
	ID           string `json:"id"`
	MediaType    string `json:"media_type"`
	MediaURL     string `json:"media_url"`
	ThumbnailURL string `json:"thumbnail_url"`
}

// parseInstagramTimestamp parses the timestamp string returned by the Graph
// /media endpoint. Instagram emits a numeric timezone offset without a colon
// (e.g. "2026-06-09T18:37:59+0000"), which is NOT valid RFC3339, so RFC3339 is
// tried only as a fallback. Returns the zero time if no layout matches.
func parseInstagramTimestamp(s string) time.Time {
	for _, layout := range []string{"2006-01-02T15:04:05-0700", time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// InstagramMedia represents one item returned by the /media Graph endpoint.
type InstagramMedia struct {
	ID           string                `json:"id"`
	Caption      string                `json:"caption"`
	MediaType    string                `json:"media_type"`   // IMAGE | VIDEO | CAROUSEL_ALBUM
	MediaURL     string                `json:"media_url"`
	Permalink    string                `json:"permalink"`
	Timestamp    time.Time             `json:"timestamp"`
	ThumbnailURL string                `json:"thumbnail_url"` // VIDEO only
	Children     []InstagramMediaChild `json:"children"`
}

// ListUserMedia returns all media items for the connected account, following
// pagination cursors until all pages are exhausted.
func (s *InstagramService) ListUserMedia(ctx context.Context) ([]InstagramMedia, error) {
	token, err := s.secret(ctx, "instagram_access_token")
	if err != nil {
		return nil, err
	}
	igUserID, err := s.secret(ctx, "instagram_user_id")
	if err != nil {
		return nil, err
	}

	const fields = "id,caption,media_type,media_url,permalink,timestamp,thumbnail_url,children{media_url,media_type,thumbnail_url}"
	params := url.Values{
		"fields":       {fields},
		"access_token": {token},
	}
	rawURL := fmt.Sprintf("%s/%s/media?%s", s.graphBaseURL, igUserID, params.Encode())

	var all []InstagramMedia
	for rawURL != "" {
		body, err := s.get(ctx, rawURL)
		if err != nil {
			return nil, fmt.Errorf("list user media: %w", err)
		}

		var page struct {
			Data []struct {
				ID           string `json:"id"`
				Caption      string `json:"caption"`
				MediaType    string `json:"media_type"`
				MediaURL     string `json:"media_url"`
				Permalink    string `json:"permalink"`
				Timestamp    string `json:"timestamp"`
				ThumbnailURL string `json:"thumbnail_url"`
				Children     *struct {
					Data []InstagramMediaChild `json:"data"`
				} `json:"children"`
			} `json:"data"`
			Paging *struct {
				Next string `json:"next"`
			} `json:"paging"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("decode media page: %w", err)
		}

		for _, d := range page.Data {
			m := InstagramMedia{
				ID:           d.ID,
				Caption:      d.Caption,
				MediaType:    d.MediaType,
				MediaURL:     d.MediaURL,
				Permalink:    d.Permalink,
				ThumbnailURL: d.ThumbnailURL,
			}
			m.Timestamp = parseInstagramTimestamp(d.Timestamp)
			if d.Children != nil {
				m.Children = d.Children.Data
			}
			all = append(all, m)
		}

		rawURL = ""
		if page.Paging != nil {
			rawURL = page.Paging.Next
		}
	}
	return all, nil
}
