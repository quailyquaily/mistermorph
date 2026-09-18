package chatcmd

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/pagination"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

const runtimeTokenEnv = "MISTERMORPH_RUNTIME_TOKEN"

type remoteClient struct {
	base, token, defaultLookup string
	http                       *http.Client
}
type remoteHTTPError struct{ status int }

func (e *remoteHTTPError) Error() string {
	switch e.status {
	case 401, 403:
		return "runtime authentication failed; check " + runtimeTokenEnv + " against server.auth_token"
	case 404:
		return "runtime resource not found (or /runtime is not enabled; configure server.auth_token)"
	case 409:
		return "runtime conflict; refresh before trying again"
	case 400:
		return "runtime rejected the request; check the topic and server workspace path"
	default:
		return fmt.Sprintf("runtime HTTP %d", e.status)
	}
}
func newRemoteClient(raw, token string) (*remoteClient, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("runtime-url must be an HTTP(S) base URL without credentials, query or fragment")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme == "http" && u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, errors.New("non-loopback runtime requires HTTPS; use a local secure tunnel for HTTP")
	}
	if strings.TrimSpace(token) == "" {
		return nil, fmt.Errorf("set %s to the Console server.auth_token", runtimeTokenEnv)
	}
	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	return &remoteClient{base: strings.TrimRight(u.String(), "/"), token: token, defaultLookup: "tui-workspace-probe-" + hex.EncodeToString(key), http: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *remoteClient) request(ctx context.Context, method, path string, body, out any) error {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return errors.New("cannot encode runtime request")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, &buf)
	if err != nil {
		return errors.New("invalid runtime request")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("runtime unreachable or timed out; check address, TLS and server availability")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &remoteHTTPError{resp.StatusCode}
	}
	if out == nil || resp.StatusCode == 204 {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(out); err != nil {
		return errors.New("invalid runtime response")
	}
	return nil
}
func (c *remoteClient) connect(ctx context.Context) error {
	var h struct {
		Mode string `json:"mode"`
	}
	if err := c.request(ctx, "GET", "/health", nil, &h); err != nil {
		return err
	}
	if h.Mode != "console" {
		return errors.New("endpoint is not a Console runtime")
	}
	var p pagination.Page[taskdomain.TopicInfo]
	return c.request(ctx, "GET", "/topics?limit=1", nil, &p)
}
func topicPath(id string) string { return "/topics/" + url.PathEscape(id) }
func (c *remoteClient) workspace(ctx context.Context, id string) (string, error) {
	// GET /workspace requires a key but does not require a persisted topic. A
	// random, read-only attachment lookup resolves the default without creating
	// a topic or borrowing the possibly attached legacy `default` topic.
	if id == "" {
		id = c.defaultLookup
	}
	var w struct {
		Dir *string `json:"workspace_dir"`
	}
	err := c.request(ctx, "GET", "/workspace?topic_id="+url.QueryEscape(id), nil, &w)
	if err != nil {
		return "", err
	}
	if w.Dir == nil {
		return "", errors.New("runtime omitted workspace_dir")
	}
	return *w.Dir, nil
}
func (c *remoteClient) scope(ctx context.Context, id, pending string) (string, error) {
	if id != "" || pending == "" {
		return c.workspace(ctx, id)
	}
	var w struct {
		Path string `json:"path"`
	}
	err := c.request(ctx, "GET", "/workspace/browse?path="+url.QueryEscape(pending), nil, &w)
	if err == nil && w.Path == "" {
		err = errors.New("runtime omitted canonical workspace path")
	}
	return w.Path, err
}
func (c *remoteClient) topics(ctx context.Context, dir, cursor string) (pagination.Page[taskdomain.TopicInfo], error) {
	var out pagination.Page[taskdomain.TopicInfo]
	seen := map[string]bool{}
	for {
		if seen[cursor] {
			return out, errors.New("runtime returned a repeated topic cursor")
		}
		seen[cursor] = true
		var p pagination.Page[taskdomain.TopicInfo]
		if err := c.request(ctx, "GET", "/topics?limit=30&cursor="+url.QueryEscape(cursor), nil, &p); err != nil {
			return out, err
		}
		// Serial resolution deliberately bounds concurrency to one. Cancellation
		// interrupts both pagination and workspace lookup; failures are not misses.
		for _, t := range p.Items {
			w, err := c.workspace(ctx, t.ID)
			if err != nil {
				return out, err
			}
			if w == dir {
				out.Items = append(out.Items, t)
			}
		}
		out.NextCursor = p.NextCursor
		out.HasNext = p.HasNext
		if !p.HasNext || len(out.Items) >= 30 {
			return out, nil
		}
		if p.NextCursor == "" {
			return out, errors.New("runtime omitted topic cursor")
		}
		cursor = p.NextCursor
	}
}
func (c *remoteClient) history(ctx context.Context, id, cursor string) (pagination.Page[taskdomain.TaskInfo], error) {
	var p pagination.Page[taskdomain.TaskInfo]
	err := c.request(ctx, "GET", "/tasks?limit=30&topic_id="+url.QueryEscape(id)+"&cursor="+url.QueryEscape(cursor), nil, &p)
	return p, err
}
