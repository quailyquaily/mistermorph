package updatecheck

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// ReleaseIndex is <channel>/releases/index.json: every release in a channel,
// newest version first, without notes.
type ReleaseIndex struct {
	Channel   string              `json:"channel"`
	UpdatedAt string              `json:"updated_at"`
	Latest    string              `json:"latest"`
	Releases  []ReleaseIndexEntry `json:"releases"`
}

type ReleaseIndexEntry struct {
	Tag         string `json:"tag"`
	Version     string `json:"version"`
	Prerelease  bool   `json:"prerelease"`
	PublishedAt string `json:"published_at"`
}

// Release is <channel>/releases/<tag>/release.json: one release with its
// notes and downloadable files.
type Release struct {
	Channel     string        `json:"channel"`
	Tag         string        `json:"tag"`
	Version     string        `json:"version"`
	Prerelease  bool          `json:"prerelease"`
	PublishedAt string        `json:"published_at"`
	Notes       string        `json:"notes"`
	Files       []ReleaseFile `json:"files"`
}

type ReleaseFile struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

// ReleaseIndexURL returns the URL of a channel's release index.
func ReleaseIndexURL(baseURL string, channel string) string {
	return channelBaseURL(baseURL, channel) + "/releases/index.json"
}

// ReleaseURL returns the URL of one release's release.json.
func ReleaseURL(baseURL string, channel string, tag string) string {
	return channelBaseURL(baseURL, channel) + "/releases/" + url.PathEscape(tag) + "/release.json"
}

func channelBaseURL(baseURL string, channel string) string {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return baseURL + "/" + channel
}

// FetchRelease loads a release from a channel. An empty tag or "latest"
// resolves to the newest stable release in the channel's index.
func FetchRelease(ctx context.Context, baseURL string, channel string, tag string, userAgent string) (Release, error) {
	channel, err := NormalizeChannel(channel)
	if err != nil {
		return Release{}, err
	}
	tag = strings.TrimSpace(tag)
	if tag == "" || strings.EqualFold(tag, "latest") {
		var index ReleaseIndex
		if err := fetchJSON(ctx, ReleaseIndexURL(baseURL, channel), userAgent, &index); err != nil {
			return Release{}, fmt.Errorf("fetch %s release index: %w", channel, err)
		}
		if strings.TrimSpace(index.Latest) == "" {
			return Release{}, fmt.Errorf("%s release index has no stable release", channel)
		}
		tag = index.Latest
	} else if !strings.HasPrefix(tag, "v") {
		tag = "v" + tag
	}

	var release Release
	if err := fetchJSON(ctx, ReleaseURL(baseURL, channel, tag), userAgent, &release); err != nil {
		return Release{}, fmt.Errorf("fetch %s release %s: %w", channel, tag, err)
	}
	return release, nil
}

func fetchJSON(ctx context.Context, rawURL string, userAgent string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", normalizedUserAgent(userAgent))

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("http status %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out)
}
