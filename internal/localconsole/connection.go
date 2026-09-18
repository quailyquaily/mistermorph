// Package localconsole stores private connection credentials for an explicitly
// started Console. It does not start processes or store conversation history.
package localconsole

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

type Connection struct {
	URL    string `json:"url"`
	Token  string `json:"token"`
	WebURL string `json:"web_url"`
}

func Load(stateDir string) (Connection, bool, error) {
	var c Connection
	found, err := fsstore.ReadJSON(filepath.Join(stateDir, "console", "runtime.json"), &c)
	return c, found, err
}

func Save(stateDir string, c Connection) error {
	if err := c.validate(); err != nil {
		return err
	}
	return fsstore.WriteJSONAtomic(filepath.Join(stateDir, "console", "runtime.json"), c, fsstore.FileOptions{})
}

func (c Connection) validate() error {
	u, err := url.Parse(c.URL)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.TrimSpace(c.Token) == "" {
		return errors.New("invalid local Console connection")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return errors.New("local Console connection must use a loopback IP address")
	}
	return nil
}

func (c Connection) request(ctx context.Context, method, route string) (*http.Response, error) {
	if err := c.validate(); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.URL, "/")+route, nil)
	if err != nil {
		return nil, errors.New("invalid local Console request")
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("local Console is unavailable")
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("local Console returned HTTP %d", resp.StatusCode)
	}
	return resp, nil
}

func (c Connection) Probe(ctx context.Context) error {
	resp, err := c.request(ctx, http.MethodGet, "/health")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var health struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&health); err != nil || health.Mode != "console" {
		return errors.New("local endpoint is not a Console runtime")
	}
	resp, err = c.request(ctx, http.MethodGet, "/topics?limit=1")
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

func Stop(ctx context.Context, stateDir string) error {
	c, found, err := Load(stateDir)
	if err != nil {
		return err
	}
	if !found {
		return errors.New("no local Console is running")
	}
	resp, err := c.request(ctx, http.MethodPost, "/shutdown")
	if err != nil {
		return err
	}
	return resp.Body.Close()
}
