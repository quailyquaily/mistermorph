package blueskyapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// StrongRef points at one version of a record.
type StrongRef struct {
	URI string `json:"uri"`
	CID string `json:"cid"`
}

// ReplyRef places a post in a thread.
type ReplyRef struct {
	Root   StrongRef `json:"root"`
	Parent StrongRef `json:"parent"`
}

// PostRecord is the record of a post.
type PostRecord struct {
	Text      string    `json:"text"`
	Facets    []Facet   `json:"facets,omitempty"`
	Reply     *ReplyRef `json:"reply,omitempty"`
	CreatedAt string    `json:"createdAt"`
	Langs     []string  `json:"langs,omitempty"`
}

// Notification is one item of the account's notifications.
type Notification struct {
	URI           string          `json:"uri"`
	CID           string          `json:"cid"`
	Author        ProfileBasic    `json:"author"`
	Reason        string          `json:"reason"`
	ReasonSubject string          `json:"reasonSubject,omitempty"`
	Record        json.RawMessage `json:"record"`
	IsRead        bool            `json:"isRead"`
	IndexedAt     string          `json:"indexedAt"`
}

// Post decodes the notification's record as a post.
func (n Notification) Post() (PostRecord, bool) {
	var post PostRecord
	if json.Unmarshal(n.Record, &post) != nil {
		return PostRecord{}, false
	}
	return post, true
}

// Time is when the post was made, or indexed when its record has no time.
func (n Notification) Time() time.Time {
	if post, ok := n.Post(); ok {
		if at, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(post.CreatedAt)); err == nil {
			return at
		}
	}
	at, _ := time.Parse(time.RFC3339Nano, strings.TrimSpace(n.IndexedAt))
	return at
}

// ListNotifications returns the latest notifications for reasons, newest first.
func (c *Client) ListNotifications(ctx context.Context, reasons []string, limit int, cursor string) ([]Notification, string, error) {
	params := url.Values{"limit": {strconv.Itoa(min(max(limit, 1), 100))}}
	for _, reason := range reasons {
		params.Add("reasons", reason)
	}
	if cursor != "" {
		params.Set("cursor", cursor)
	}
	var out struct {
		Notifications []Notification `json:"notifications"`
		Cursor        string         `json:"cursor"`
	}
	err := c.xrpc(ctx, http.MethodGet, "app.bsky.notification.listNotifications", params, nil, &out, "")
	return out.Notifications, out.Cursor, err
}

// UpdateSeen marks notifications up to seenAt as seen.
func (c *Client) UpdateSeen(ctx context.Context, seenAt time.Time) error {
	return c.xrpc(ctx, http.MethodPost, "app.bsky.notification.updateSeen", nil, map[string]string{"seenAt": seenAt.UTC().Format(time.RFC3339Nano)}, nil, "")
}

// ThreadPost is one post of a thread as the channel uses it.
type ThreadPost struct {
	URI       string
	CID       string
	Author    ProfileBasic
	Text      string
	Reply     *ReplyRef
	Images    []ImageView
	CreatedAt time.Time
}

// ImageView is an image embedded in a post.
type ImageView struct {
	Fullsize string `json:"fullsize"`
	Alt      string `json:"alt"`
}

type postView struct {
	URI       string          `json:"uri"`
	CID       string          `json:"cid"`
	Author    ProfileBasic    `json:"author"`
	Record    PostRecord      `json:"record"`
	Embed     json.RawMessage `json:"embed,omitempty"`
	IndexedAt string          `json:"indexedAt"`
}

func (v postView) threadPost() ThreadPost {
	at, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(v.Record.CreatedAt))
	if err != nil {
		at, _ = time.Parse(time.RFC3339Nano, strings.TrimSpace(v.IndexedAt))
	}
	return ThreadPost{URI: v.URI, CID: v.CID, Author: v.Author, Text: v.Record.Text, Reply: v.Record.Reply, Images: embeddedImages(v.Embed), CreatedAt: at}
}

// embeddedImages reads the images of an images embed, or of a record-with-media embed.
func embeddedImages(raw json.RawMessage) []ImageView {
	if len(raw) == 0 {
		return nil
	}
	var embed struct {
		Type   string      `json:"$type"`
		Images []ImageView `json:"images"`
		Media  *struct {
			Type   string      `json:"$type"`
			Images []ImageView `json:"images"`
		} `json:"media"`
	}
	if json.Unmarshal(raw, &embed) != nil {
		return nil
	}
	if len(embed.Images) > 0 {
		return embed.Images
	}
	if embed.Media != nil {
		return embed.Media.Images
	}
	return nil
}

// GetThread returns the post at uri with up to parents posts above it, oldest first, the post last.
func (c *Client) GetThread(ctx context.Context, uri string, parents int) ([]ThreadPost, error) {
	params := url.Values{"uri": {uri}, "depth": {"0"}, "parentHeight": {strconv.Itoa(min(max(parents, 0), 1000))}}
	var out struct {
		Thread json.RawMessage `json:"thread"`
	}
	if err := c.xrpc(ctx, http.MethodGet, "app.bsky.feed.getPostThread", params, nil, &out, ""); err != nil {
		return nil, err
	}
	var chain []ThreadPost
	raw := out.Thread
	for len(raw) > 0 {
		var node struct {
			Type   string          `json:"$type"`
			Post   *postView       `json:"post"`
			Parent json.RawMessage `json:"parent"`
		}
		if json.Unmarshal(raw, &node) != nil || node.Post == nil || !strings.HasSuffix(node.Type, "#threadViewPost") {
			// A deleted or blocked post ends the chain.
			break
		}
		chain = append(chain, node.Post.threadPost())
		raw = node.Parent
	}
	if len(chain) == 0 {
		return nil, fmt.Errorf("bluesky: post %s is not available", uri)
	}
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	return chain, nil
}

// CreatePost posts text, as a reply when reply is set, and returns the new post.
func (c *Client) CreatePost(ctx context.Context, text string, facets []Facet, reply *ReplyRef) (StrongRef, error) {
	if err := c.Connect(ctx); err != nil {
		return StrongRef{}, err
	}
	record := PostRecord{Text: text, Facets: facets, Reply: reply, CreatedAt: c.now().UTC().Format(time.RFC3339Nano)}
	body := map[string]any{
		"repo":       c.DID(),
		"collection": "app.bsky.feed.post",
		"record":     map[string]any{"$type": "app.bsky.feed.post", "text": record.Text, "facets": record.Facets, "reply": record.Reply, "createdAt": record.CreatedAt},
	}
	if len(facets) == 0 {
		delete(body["record"].(map[string]any), "facets")
	}
	if reply == nil {
		delete(body["record"].(map[string]any), "reply")
	}
	var out StrongRef
	err := c.xrpc(ctx, http.MethodPost, "com.atproto.repo.createRecord", nil, body, &out, "")
	return out, err
}

// GetProfile returns a profile by handle or DID.
func (c *Client) GetProfile(ctx context.Context, actor string) (ProfileBasic, error) {
	var out ProfileBasic
	err := c.xrpc(ctx, http.MethodGet, "app.bsky.actor.getProfile", url.Values{"actor": {actor}}, nil, &out, "")
	return out, err
}

// imageHosts are where post images may be downloaded from.
var imageHosts = []string{"cdn.bsky.app", "video.bsky.app"}

// DownloadImage fetches an image a post embeds, up to maxBytes.
func (c *Client) DownloadImage(ctx context.Context, rawURL string, maxBytes int64) ([]byte, string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" {
		return nil, "", fmt.Errorf("bluesky: image url %q is not https", rawURL)
	}
	allowed := false
	for _, host := range imageHosts {
		if strings.EqualFold(parsed.Hostname(), host) {
			allowed = true
		}
	}
	if !allowed {
		return nil, "", fmt.Errorf("bluesky: image host %q is not allowed", parsed.Hostname())
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, "", fmt.Errorf("bluesky: image download: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > maxBytes {
		return nil, "", fmt.Errorf("bluesky: image is larger than %d bytes", maxBytes)
	}
	return data, resp.Header.Get("Content-Type"), nil
}
