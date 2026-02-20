package consolecmd

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

	"github.com/quailyquaily/mistermorph/cmd/mistermorph/daemoncmd"
)

var errTaskNotFound = errors.New("task not found")

type daemonTaskClient struct {
	baseURL   string
	authToken string
	client    *http.Client
}

func newDaemonTaskClient(baseURL, authToken string) *daemonTaskClient {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	authToken = strings.TrimSpace(authToken)
	return &daemonTaskClient{
		baseURL:   baseURL,
		authToken: authToken,
		client:    &http.Client{Timeout: 20 * time.Second},
	}
}

func (c *daemonTaskClient) readyBaseURL() error {
	if c == nil || strings.TrimSpace(c.baseURL) == "" {
		return fmt.Errorf("daemon server url is not configured")
	}
	return nil
}

func (c *daemonTaskClient) ready() error {
	if err := c.readyBaseURL(); err != nil {
		return err
	}
	if strings.TrimSpace(c.authToken) == "" {
		return fmt.Errorf("daemon server auth token is not configured")
	}
	return nil
}

func (c *daemonTaskClient) HealthMode(ctx context.Context) (string, error) {
	if err := c.readyBaseURL(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/health", nil)
	if err != nil {
		return "", err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("daemon health http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var out struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("invalid daemon health response: %w", err)
	}
	return strings.ToLower(strings.TrimSpace(out.Mode)), nil
}

func (c *daemonTaskClient) List(ctx context.Context, status daemoncmd.TaskStatus, limit int) ([]daemoncmd.TaskInfo, error) {
	if err := c.ready(); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 20
	}
	q := url.Values{}
	if strings.TrimSpace(string(status)) != "" {
		q.Set("status", strings.TrimSpace(string(status)))
	}
	q.Set("limit", fmt.Sprintf("%d", limit))

	endpoint := c.baseURL + "/tasks"
	if qs := q.Encode(); qs != "" {
		endpoint = endpoint + "?" + qs
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("daemon http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var out struct {
		Items []daemoncmd.TaskInfo `json:"items"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("invalid daemon response: %w", err)
	}
	return out.Items, nil
}

func (c *daemonTaskClient) Get(ctx context.Context, id string) (*daemoncmd.TaskInfo, error) {
	if err := c.ready(); err != nil {
		return nil, err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, fmt.Errorf("missing task id")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/tasks/"+id, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode == http.StatusNotFound {
		return nil, errTaskNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("daemon http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var out daemoncmd.TaskInfo
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("invalid daemon response: %w", err)
	}
	return &out, nil
}
