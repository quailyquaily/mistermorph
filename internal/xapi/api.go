package xapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// User is an X account.
type User struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Username string `json:"username"`
}

// Post is a post (tweet).
type Post struct {
	ID               string `json:"id"`
	Text             string `json:"text"`
	AuthorID         string `json:"author_id"`
	ConversationID   string `json:"conversation_id"`
	CreatedAt        string `json:"created_at"`
	ReferencedTweets []struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	} `json:"referenced_tweets,omitempty"`
	Attachments *struct {
		MediaKeys []string `json:"media_keys"`
	} `json:"attachments,omitempty"`
}

// RepliedTo is the ID of the post this one replies to, "" for none.
func (p Post) RepliedTo() string {
	for _, ref := range p.ReferencedTweets {
		if ref.Type == "replied_to" {
			return ref.ID
		}
	}
	return ""
}

// Time is when the post was made.
func (p Post) Time() time.Time {
	at, _ := time.Parse(time.RFC3339Nano, strings.TrimSpace(p.CreatedAt))
	return at
}

// Media is a photo, video or GIF a post carries.
type Media struct {
	MediaKey string `json:"media_key"`
	Type     string `json:"type"`
	URL      string `json:"url,omitempty"`
}

// Includes are the users and media a response expands.
type Includes struct {
	Users []User  `json:"users"`
	Media []Media `json:"media"`
}

// User returns an expanded user by ID.
func (i Includes) User(id string) (User, bool) {
	for _, user := range i.Users {
		if user.ID == id {
			return user, true
		}
	}
	return User{}, false
}

// MediaFor returns the expanded media of a post.
func (i Includes) MediaFor(post Post) []Media {
	if post.Attachments == nil {
		return nil
	}
	var out []Media
	for _, key := range post.Attachments.MediaKeys {
		for _, media := range i.Media {
			if media.MediaKey == key {
				out = append(out, media)
			}
		}
	}
	return out
}

var postFields = url.Values{
	"tweet.fields": {"created_at,conversation_id,author_id,referenced_tweets,attachments"},
	"expansions":   {"author_id,attachments.media_keys"},
	"user.fields":  {"username,name"},
	"media.fields": {"url,type"},
}

func withPostFields(params url.Values) url.Values {
	for key, values := range postFields {
		params[key] = values
	}
	return params
}

// Me returns the authorized account.
func (c *Client) Me(ctx context.Context) (User, error) {
	var out struct {
		Data User `json:"data"`
	}
	err := c.call(ctx, http.MethodGet, "/users/me", url.Values{"user.fields": {"username,name"}}, nil, &out)
	if err == nil {
		c.usage.add(UsageUserReads, 1)
	}
	return out.Data, err
}

// Mentions returns the posts that mention userID after sinceID (all recent ones when it is ""),
// newest first.
func (c *Client) Mentions(ctx context.Context, userID, sinceID string, maxResults int) ([]Post, Includes, string, error) {
	params := withPostFields(url.Values{"max_results": {strconv.Itoa(min(max(maxResults, 5), 100))}})
	if sinceID != "" {
		params.Set("since_id", sinceID)
	}
	var out struct {
		Data     []Post   `json:"data"`
		Includes Includes `json:"includes"`
		Meta     struct {
			NewestID string `json:"newest_id"`
		} `json:"meta"`
	}
	err := c.call(ctx, http.MethodGet, "/users/"+url.PathEscape(userID)+"/mentions", params, nil, &out)
	if err == nil {
		c.usage.add(UsageOwnedReads, len(out.Data))
	}
	return out.Data, out.Includes, out.Meta.NewestID, err
}

// Posts looks up posts by ID.
func (c *Client) Posts(ctx context.Context, ids []string) ([]Post, Includes, error) {
	if len(ids) == 0 {
		return nil, Includes{}, nil
	}
	var out struct {
		Data     []Post   `json:"data"`
		Includes Includes `json:"includes"`
	}
	err := c.call(ctx, http.MethodGet, "/tweets", withPostFields(url.Values{"ids": {strings.Join(ids, ",")}}), nil, &out)
	if err == nil {
		c.usage.add(UsagePostReads, len(out.Data))
	}
	return out.Data, out.Includes, err
}

// Reply posts text as a reply to postID and returns the new post's ID.
func (c *Client) Reply(ctx context.Context, postID, text string) (string, error) {
	body := map[string]any{"text": text, "reply": map[string]string{"in_reply_to_tweet_id": postID}}
	var out struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	err := c.call(ctx, http.MethodPost, "/tweets", nil, body, &out)
	if err == nil {
		c.usage.add(UsagePostsCreated, 1)
		if strings.Contains(text, "http://") || strings.Contains(text, "https://") {
			c.usage.add(UsagePostsWithLinks, 1)
		}
	}
	return out.Data.ID, err
}

// DMEvent is a direct-message event.
type DMEvent struct {
	ID               string `json:"id"`
	EventType        string `json:"event_type"`
	Text             string `json:"text"`
	SenderID         string `json:"sender_id"`
	DMConversationID string `json:"dm_conversation_id"`
	CreatedAt        string `json:"created_at"`
}

// Time is when the message was sent.
func (e DMEvent) Time() time.Time {
	at, _ := time.Parse(time.RFC3339Nano, strings.TrimSpace(e.CreatedAt))
	return at
}

// DMEvents returns the account's latest received and sent messages, newest first.
func (c *Client) DMEvents(ctx context.Context, maxResults int) ([]DMEvent, Includes, error) {
	params := url.Values{
		"event_types":     {"MessageCreate"},
		"dm_event.fields": {"id,text,event_type,dm_conversation_id,created_at,sender_id"},
		"expansions":      {"sender_id"},
		"user.fields":     {"username,name"},
		"max_results":     {strconv.Itoa(min(max(maxResults, 1), 100))},
	}
	var out struct {
		Data     []DMEvent `json:"data"`
		Includes Includes  `json:"includes"`
	}
	err := c.call(ctx, http.MethodGet, "/dm_events", params, nil, &out)
	if err == nil {
		c.usage.add(UsageDMReads, len(out.Data))
	}
	return out.Data, out.Includes, err
}

// SendDM sends text to a user's one-to-one conversation.
func (c *Client) SendDM(ctx context.Context, userID, text string) error {
	err := c.call(ctx, http.MethodPost, "/dm_conversations/with/"+url.PathEscape(userID)+"/messages", nil, map[string]string{"text": text}, nil)
	if err == nil {
		c.usage.add(UsageDMsSent, 1)
	}
	return err
}

// UserByUsername looks up an account by its @username.
func (c *Client) UserByUsername(ctx context.Context, username string) (User, error) {
	var out struct {
		Data User `json:"data"`
	}
	err := c.call(ctx, http.MethodGet, "/users/by/username/"+url.PathEscape(strings.TrimPrefix(strings.TrimSpace(username), "@")), url.Values{"user.fields": {"username,name"}}, nil, &out)
	if err == nil {
		c.usage.add(UsageUserReads, 1)
	}
	return out.Data, err
}

// mediaHosts are where post images may be downloaded from.
var mediaHosts = []string{"pbs.twimg.com"}

// DownloadImage fetches a post's photo, up to maxBytes.
func (c *Client) DownloadImage(ctx context.Context, rawURL string, maxBytes int64) ([]byte, string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" {
		return nil, "", fmt.Errorf("x: image url %q is not https", rawURL)
	}
	allowed := false
	for _, host := range mediaHosts {
		if strings.EqualFold(parsed.Hostname(), host) {
			allowed = true
		}
	}
	if !allowed {
		return nil, "", fmt.Errorf("x: image host %q is not allowed", parsed.Hostname())
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
		return nil, "", fmt.Errorf("x: image download: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > maxBytes {
		return nil, "", fmt.Errorf("x: image is larger than %d bytes", maxBytes)
	}
	return data, resp.Header.Get("Content-Type"), nil
}

// StripLinks removes URLs from text, for posts where a link would cost extra.
func StripLinks(text string) string {
	out := urlPattern.ReplaceAllString(text, "")
	lines := strings.Split(out, "\n")
	for i, line := range lines {
		lines[i] = strings.Join(strings.Fields(line), " ")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}
