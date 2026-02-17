package slackcmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/quailyquaily/mistermorph/internal/slackclient"
)

type slackAPI struct {
	http     *http.Client
	baseURL  string
	botToken string
	appToken string
}

func newSlackAPI(httpClient *http.Client, baseURL, botToken, appToken string) *slackAPI {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	baseURL = strings.TrimSpace(strings.TrimRight(baseURL, "/"))
	if baseURL == "" {
		baseURL = "https://slack.com/api"
	}
	return &slackAPI{
		http:     httpClient,
		baseURL:  baseURL,
		botToken: strings.TrimSpace(botToken),
		appToken: strings.TrimSpace(appToken),
	}
}

type slackAuthTestResult struct {
	TeamID  string
	UserID  string
	BotID   string
	URL     string
	Team    string
	User    string
	IsOwner bool
}

type slackAuthTestResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	TeamID  string `json:"team_id,omitempty"`
	UserID  string `json:"user_id,omitempty"`
	BotID   string `json:"bot_id,omitempty"`
	URL     string `json:"url,omitempty"`
	Team    string `json:"team,omitempty"`
	User    string `json:"user,omitempty"`
	IsOwner bool   `json:"is_owner,omitempty"`
}

func (api *slackAPI) authTest(ctx context.Context) (slackAuthTestResult, error) {
	if api == nil {
		return slackAuthTestResult{}, fmt.Errorf("slack api is not initialized")
	}
	body, status, _, err := api.postAuthJSON(ctx, api.botToken, "/auth.test", nil)
	if err != nil {
		return slackAuthTestResult{}, err
	}
	if status < 200 || status >= 300 {
		return slackAuthTestResult{}, fmt.Errorf("slack auth.test http %d", status)
	}
	var out slackAuthTestResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return slackAuthTestResult{}, err
	}
	if !out.OK {
		code := strings.TrimSpace(out.Error)
		if code == "" {
			code = "unknown_error"
		}
		return slackAuthTestResult{}, fmt.Errorf("slack auth.test failed: %s", code)
	}
	return slackAuthTestResult{
		TeamID:  strings.TrimSpace(out.TeamID),
		UserID:  strings.TrimSpace(out.UserID),
		BotID:   strings.TrimSpace(out.BotID),
		URL:     strings.TrimSpace(out.URL),
		Team:    strings.TrimSpace(out.Team),
		User:    strings.TrimSpace(out.User),
		IsOwner: out.IsOwner,
	}, nil
}

type slackOpenConnectionResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	URL   string `json:"url,omitempty"`
}

func (api *slackAPI) openSocketURL(ctx context.Context) (string, error) {
	if api == nil {
		return "", fmt.Errorf("slack api is not initialized")
	}
	body, status, _, err := api.postAuthJSON(ctx, api.appToken, "/apps.connections.open", nil)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("slack apps.connections.open http %d", status)
	}
	var out slackOpenConnectionResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if !out.OK {
		code := strings.TrimSpace(out.Error)
		if code == "" {
			code = "unknown_error"
		}
		return "", fmt.Errorf("slack apps.connections.open failed: %s", code)
	}
	url := strings.TrimSpace(out.URL)
	if url == "" {
		return "", fmt.Errorf("slack apps.connections.open returned empty url")
	}
	return url, nil
}

func (api *slackAPI) connectSocket(ctx context.Context) (*websocket.Conn, error) {
	url, err := api.openSocketURL(ctx)
	if err != nil {
		return nil, err
	}
	dialer := *websocket.DefaultDialer
	conn, _, err := dialer.DialContext(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

func (api *slackAPI) postMessage(ctx context.Context, channelID, text, threadTS string) error {
	client := slackclient.New(api.http, api.baseURL, api.botToken)
	return client.PostMessage(ctx, channelID, text, threadTS)
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (api *slackAPI) postAuthJSON(ctx context.Context, token, path string, payload any) ([]byte, int, http.Header, error) {
	if api == nil || api.http == nil {
		return nil, 0, nil, fmt.Errorf("slack api is not initialized")
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, 0, nil, fmt.Errorf("slack token is required")
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, 0, nil, fmt.Errorf("slack api path is required")
	}

	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return nil, 0, nil, err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, api.baseURL+path, body)
	if err != nil {
		return nil, 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := api.http.Do(req)
	if err != nil {
		return nil, 0, nil, err
	}
	raw, readErr := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if readErr != nil {
		return nil, resp.StatusCode, resp.Header, readErr
	}
	return raw, resp.StatusCode, resp.Header, nil
}
