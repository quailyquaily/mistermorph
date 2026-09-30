// Package discordapi is the small Discord client the Discord channel needs: the REST calls it makes
// and the Gateway connection it listens on. It is not a general Discord SDK; every method maps to a
// call in docs/feat/feat_20260930_discord_channel.md.
package discordapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultAPIBaseURL = "https://discord.com/api/v10"
	// MaxMessageLength is the most characters one message can hold.
	MaxMessageLength    = 2000
	maxAPIResponseBytes = 4 << 20
	maxRequestAttempts  = 4
	userAgent           = "DiscordBot (https://github.com/quailyquaily/mistermorph, 1)"
)

// Channel types used by the channel runtime.
const (
	ChannelTypeGuildText          = 0
	ChannelTypeDM                 = 1
	ChannelTypeGroupDM            = 3
	ChannelTypeGuildAnnouncement  = 5
	ChannelTypeAnnouncementThread = 10
	ChannelTypePublicThread       = 11
	ChannelTypePrivateThread      = 12
	ChannelTypeGuildForum         = 15
)

// Message types that carry a user's words: a plain message and a reply.
const (
	MessageTypeDefault = 0
	MessageTypeReply   = 19
)

type User struct {
	ID            string `json:"id"`
	Username      string `json:"username"`
	GlobalName    string `json:"global_name,omitempty"`
	Discriminator string `json:"discriminator,omitempty"`
	Avatar        string `json:"avatar,omitempty"`
	Bot           bool   `json:"bot,omitempty"`
	System        bool   `json:"system,omitempty"`
}

// DisplayName is the name Discord shows for the user: the global display name, else the username.
func (u User) DisplayName() string {
	if name := strings.TrimSpace(u.GlobalName); name != "" {
		return name
	}
	return strings.TrimSpace(u.Username)
}

// AvatarURL is the user's avatar on Discord's CDN, or "" when the user has the default avatar.
func (u User) AvatarURL() string {
	if strings.TrimSpace(u.ID) == "" || strings.TrimSpace(u.Avatar) == "" {
		return ""
	}
	return "https://cdn.discordapp.com/avatars/" + u.ID + "/" + u.Avatar + ".png"
}

type Member struct {
	Nick string `json:"nick,omitempty"`
}

type Attachment struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type,omitempty"`
	Size        int64  `json:"size"`
	URL         string `json:"url"`
}

type MessageReference struct {
	MessageID       string `json:"message_id,omitempty"`
	ChannelID       string `json:"channel_id,omitempty"`
	GuildID         string `json:"guild_id,omitempty"`
	FailIfNotExists *bool  `json:"fail_if_not_exists,omitempty"`
}

type Message struct {
	ID                string            `json:"id"`
	ChannelID         string            `json:"channel_id"`
	GuildID           string            `json:"guild_id,omitempty"`
	Author            User              `json:"author"`
	Member            *Member           `json:"member,omitempty"`
	Content           string            `json:"content"`
	Timestamp         time.Time         `json:"timestamp"`
	Type              int               `json:"type"`
	Mentions          []User            `json:"mentions,omitempty"`
	Attachments       []Attachment      `json:"attachments,omitempty"`
	MessageReference  *MessageReference `json:"message_reference,omitempty"`
	ReferencedMessage *Message          `json:"referenced_message,omitempty"`
	WebhookID         string            `json:"webhook_id,omitempty"`
}

type Channel struct {
	ID       string `json:"id"`
	Type     int    `json:"type"`
	GuildID  string `json:"guild_id,omitempty"`
	Name     string `json:"name,omitempty"`
	ParentID string `json:"parent_id,omitempty"`
}

// IsThread reports whether the channel is a thread, whose parent_id is the channel it belongs to.
func (c Channel) IsThread() bool {
	return c.Type == ChannelTypePublicThread || c.Type == ChannelTypePrivateThread || c.Type == ChannelTypeAnnouncementThread
}

type Guild struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Channels []Channel `json:"channels,omitempty"`
	Threads  []Channel `json:"threads,omitempty"`
}

// AllowedMentions says who a message may ping. The zero value (with Parse set to an empty slice by
// NoMentions) pings nobody.
type AllowedMentions struct {
	Parse       []string `json:"parse"`
	Users       []string `json:"users,omitempty"`
	RepliedUser bool     `json:"replied_user"`
}

// NoMentions pings nobody, including the author of the message replied to.
func NoMentions() *AllowedMentions {
	return &AllowedMentions{Parse: []string{}}
}

// Component types and button styles used for approvals.
const (
	ComponentTypeActionRow = 1
	ComponentTypeButton    = 2
	ButtonStyleSuccess     = 3
	ButtonStyleDanger      = 4
)

type Component struct {
	Type       int         `json:"type"`
	Style      int         `json:"style,omitempty"`
	Label      string      `json:"label,omitempty"`
	CustomID   string      `json:"custom_id,omitempty"`
	Disabled   bool        `json:"disabled,omitempty"`
	Components []Component `json:"components,omitempty"`
}

// File is an attachment to upload with a message.
type File struct {
	Name        string
	ContentType string
	Data        []byte
}

type MessageCreate struct {
	Content          string            `json:"content,omitempty"`
	AllowedMentions  *AllowedMentions  `json:"allowed_mentions,omitempty"`
	MessageReference *MessageReference `json:"message_reference,omitempty"`
	Components       []Component       `json:"components,omitempty"`
	Files            []File            `json:"-"`
}

type MessageEdit struct {
	Content         *string          `json:"content,omitempty"`
	AllowedMentions *AllowedMentions `json:"allowed_mentions,omitempty"`
	Components      *[]Component     `json:"components,omitempty"`
}

type GatewayBot struct {
	URL               string `json:"url"`
	Shards            int    `json:"shards"`
	SessionStartLimit struct {
		Total          int `json:"total"`
		Remaining      int `json:"remaining"`
		ResetAfter     int `json:"reset_after"`
		MaxConcurrency int `json:"max_concurrency"`
	} `json:"session_start_limit"`
}

// Interaction response types.
const (
	InteractionResponseChannelMessage = 4
	InteractionResponseDeferredUpdate = 6
	InteractionResponseUpdateMessage  = 7
)

// Message flags.
const MessageFlagEphemeral = 1 << 6

type InteractionResponse struct {
	Type int                      `json:"type"`
	Data *InteractionResponseData `json:"data,omitempty"`
}

type InteractionResponseData struct {
	Content         *string          `json:"content,omitempty"`
	Components      *[]Component     `json:"components,omitempty"`
	AllowedMentions *AllowedMentions `json:"allowed_mentions,omitempty"`
	Flags           int              `json:"flags,omitempty"`
}

// Discord error codes the channel acts on.
const (
	ErrorCodeUnknownChannel     = 10003
	ErrorCodeUnknownMessage     = 10008
	ErrorCodeMissingAccess      = 50001
	ErrorCodeCannotDMUser       = 50007
	ErrorCodeMissingPermission  = 50013
	ErrorCodeUnknownInteraction = 10062
)

type APIError struct {
	HTTPStatus int
	Code       int
	Message    string
	RetryAfter time.Duration
	Global     bool
}

func (e *APIError) Error() string {
	if e == nil {
		return "discord api error"
	}
	message := strings.TrimSpace(e.Message)
	if message == "" {
		message = http.StatusText(e.HTTPStatus)
	}
	if e.Code != 0 {
		return fmt.Sprintf("discord api error: http=%d code=%d message=%s", e.HTTPStatus, e.Code, message)
	}
	return fmt.Sprintf("discord api error: http=%d message=%s", e.HTTPStatus, message)
}

// IsUnauthorized reports a rejected bot token.
func IsUnauthorized(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.HTTPStatus == http.StatusUnauthorized
}

// ErrorCode is the Discord JSON error code of err, or 0.
func ErrorCode(err error) int {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.Code
	}
	return 0
}

type ClientOptions struct {
	BaseURL    string
	HTTPClient *http.Client
	// CDNHosts are the hosts attachments may be downloaded from; defaults to Discord's CDN.
	CDNHosts []string
	Now      func() time.Time
	Sleep    func(context.Context, time.Duration) error
}

// Client makes the REST calls. It is safe for concurrent use.
type Client struct {
	token      string
	baseURL    *url.URL
	httpClient *http.Client
	cdnHosts   map[string]bool
	limiter    *rateLimiter
}

func NewClient(token string, opts ClientOptions) (*Client, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, fmt.Errorf("discord bot token is required")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/")
	if baseURL == "" {
		baseURL = DefaultAPIBaseURL
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("discord api base url is invalid")
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	hosts := opts.CDNHosts
	if len(hosts) == 0 {
		hosts = []string{"cdn.discordapp.com", "media.discordapp.net"}
	}
	cdnHosts := make(map[string]bool, len(hosts))
	for _, host := range hosts {
		cdnHosts[strings.ToLower(strings.TrimSpace(host))] = true
	}
	return &Client{
		token:      token,
		baseURL:    parsed,
		httpClient: httpClient,
		cdnHosts:   cdnHosts,
		limiter:    newRateLimiter(opts.Now, opts.Sleep),
	}, nil
}

// Me is the bot's own user.
func (c *Client) Me(ctx context.Context) (User, error) {
	var user User
	err := c.do(ctx, http.MethodGet, "/users/@me", "users/@me", nil, &user)
	return user, err
}

// GatewayBot is the Gateway URL to connect to, with the session start limit.
func (c *Client) GatewayBot(ctx context.Context) (GatewayBot, error) {
	var info GatewayBot
	err := c.do(ctx, http.MethodGet, "/gateway/bot", "gateway/bot", nil, &info)
	return info, err
}

func (c *Client) Channel(ctx context.Context, channelID string) (Channel, error) {
	if err := requireID("channel_id", channelID); err != nil {
		return Channel{}, err
	}
	var channel Channel
	err := c.do(ctx, http.MethodGet, "/channels/"+channelID, "channels/"+channelID, nil, &channel)
	return channel, err
}

// CreateMessage sends a message, with files when msg has any.
func (c *Client) CreateMessage(ctx context.Context, channelID string, msg MessageCreate) (Message, error) {
	if err := requireID("channel_id", channelID); err != nil {
		return Message{}, err
	}
	if len([]rune(msg.Content)) > MaxMessageLength {
		return Message{}, fmt.Errorf("discord message is longer than %d characters", MaxMessageLength)
	}
	var sent Message
	path := "/channels/" + channelID + "/messages"
	route := "channels/" + channelID + "/messages"
	if len(msg.Files) == 0 {
		err := c.do(ctx, http.MethodPost, path, route, msg, &sent)
		return sent, err
	}
	err := c.doMultipart(ctx, path, route, msg, &sent)
	return sent, err
}

func (c *Client) EditMessage(ctx context.Context, channelID, messageID string, edit MessageEdit) (Message, error) {
	if err := requireID("channel_id", channelID); err != nil {
		return Message{}, err
	}
	if err := requireID("message_id", messageID); err != nil {
		return Message{}, err
	}
	if edit.Content != nil && len([]rune(*edit.Content)) > MaxMessageLength {
		return Message{}, fmt.Errorf("discord message is longer than %d characters", MaxMessageLength)
	}
	var edited Message
	err := c.do(ctx, http.MethodPatch, "/channels/"+channelID+"/messages/"+messageID, "channels/"+channelID+"/messages/:id", edit, &edited)
	return edited, err
}

// TriggerTyping shows "typing…" in the channel for about 10 seconds.
func (c *Client) TriggerTyping(ctx context.Context, channelID string) error {
	if err := requireID("channel_id", channelID); err != nil {
		return err
	}
	return c.do(ctx, http.MethodPost, "/channels/"+channelID+"/typing", "channels/"+channelID+"/typing", nil, nil)
}

// AddReaction reacts to a message with a Unicode emoji, or a custom one as "name:id".
func (c *Client) AddReaction(ctx context.Context, channelID, messageID, emoji string) error {
	if err := requireID("channel_id", channelID); err != nil {
		return err
	}
	if err := requireID("message_id", messageID); err != nil {
		return err
	}
	emoji = strings.TrimSpace(emoji)
	if emoji == "" {
		return fmt.Errorf("discord reaction emoji is required")
	}
	path := "/channels/" + channelID + "/messages/" + messageID + "/reactions/" + url.PathEscape(emoji) + "/@me"
	return c.do(ctx, http.MethodPut, path, "channels/"+channelID+"/messages/:id/reactions", nil, nil)
}

// CreateDM opens (or finds) the DM channel with a user.
func (c *Client) CreateDM(ctx context.Context, userID string) (Channel, error) {
	if err := requireID("user_id", userID); err != nil {
		return Channel{}, err
	}
	var channel Channel
	err := c.do(ctx, http.MethodPost, "/users/@me/channels", "users/@me/channels", map[string]string{"recipient_id": userID}, &channel)
	return channel, err
}

// RespondInteraction answers an interaction; Discord requires it within 3 seconds.
func (c *Client) RespondInteraction(ctx context.Context, interactionID, token string, response InteractionResponse) error {
	if err := requireID("interaction_id", interactionID); err != nil {
		return err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("discord interaction token is required")
	}
	path := "/interactions/" + interactionID + "/" + url.PathEscape(token) + "/callback"
	return c.doAuth(ctx, http.MethodPost, path, "interactions/callback", response, nil, false)
}

// DownloadAttachment reads an attachment from Discord's CDN, up to maxBytes. The bot token is never
// sent: attachment URLs are signed, and a URL on any other host is refused.
func (c *Client) DownloadAttachment(ctx context.Context, rawURL string, maxBytes int64) ([]byte, string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme != "https" || !c.cdnHosts[strings.ToLower(parsed.Hostname())] {
		return nil, "", fmt.Errorf("discord attachment url is not on Discord's CDN")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", &APIError{HTTPStatus: resp.StatusCode}
	}
	if maxBytes > 0 && resp.ContentLength > maxBytes {
		return nil, "", fmt.Errorf("discord attachment is larger than %d bytes", maxBytes)
	}
	limit := maxBytes
	if limit <= 0 {
		limit = maxAPIResponseBytes
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > limit {
		return nil, "", fmt.Errorf("discord attachment is larger than %d bytes", limit)
	}
	return data, resp.Header.Get("Content-Type"), nil
}

func (c *Client) do(ctx context.Context, method, path, route string, body, out any) error {
	return c.doAuth(ctx, method, path, route, body, out, true)
}

func (c *Client) doAuth(ctx context.Context, method, path, route string, body, out any, auth bool) error {
	var payload []byte
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = data
	}
	return c.send(ctx, method+" "+route, func() (*http.Request, error) {
		var reader io.Reader
		if payload != nil {
			reader = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.endpoint(path), reader)
		if err != nil {
			return nil, err
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if auth {
			req.Header.Set("Authorization", "Bot "+c.token)
		}
		return req, nil
	}, out)
}

func (c *Client) doMultipart(ctx context.Context, path, route string, msg MessageCreate, out any) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="payload_json"`)
	header.Set("Content-Type", "application/json")
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	if _, err := part.Write(payload); err != nil {
		return err
	}
	for i, file := range msg.Files {
		name := strings.TrimSpace(file.Name)
		if name == "" {
			return fmt.Errorf("discord file name is required")
		}
		fileHeader := make(textproto.MIMEHeader)
		fileHeader.Set("Content-Disposition", fmt.Sprintf(`form-data; name="files[%d]"; filename=%q`, i, name))
		contentType := strings.TrimSpace(file.ContentType)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		fileHeader.Set("Content-Type", contentType)
		filePart, err := writer.CreatePart(fileHeader)
		if err != nil {
			return err
		}
		if _, err := filePart.Write(file.Data); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	data := body.Bytes()
	contentType := writer.FormDataContentType()
	return c.send(ctx, http.MethodPost+" "+route, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(path), bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("Authorization", "Bot "+c.token)
		return req, nil
	}, out)
}

// send runs one request through the rate limiter, retrying on 429 and transient server errors.
func (c *Client) send(ctx context.Context, routeKey string, build func() (*http.Request, error), out any) error {
	var lastErr error
	for attempt := 0; attempt < maxRequestAttempts; attempt++ {
		if err := c.limiter.wait(ctx, routeKey); err != nil {
			return err
		}
		req, err := build()
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", userAgent)
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return err
		}
		c.limiter.update(routeKey, resp.Header)
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, maxAPIResponseBytes))
		resp.Body.Close()
		if readErr != nil {
			return readErr
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if out == nil || len(bytes.TrimSpace(data)) == 0 {
				return nil
			}
			if err := json.Unmarshal(data, out); err != nil {
				return fmt.Errorf("decode discord response: %w", err)
			}
			return nil
		}
		apiErr := decodeAPIError(resp, data)
		lastErr = apiErr
		switch {
		case resp.StatusCode == http.StatusTooManyRequests:
			c.limiter.limited(routeKey, apiErr.RetryAfter, apiErr.Global)
			continue
		case resp.StatusCode >= 500:
			if err := c.limiter.sleep(ctx, time.Duration(attempt+1)*500*time.Millisecond); err != nil {
				return err
			}
			continue
		}
		return apiErr
	}
	return lastErr
}

func (c *Client) endpoint(path string) string {
	return strings.TrimRight(c.baseURL.String(), "/") + path
}

func decodeAPIError(resp *http.Response, data []byte) *APIError {
	apiErr := &APIError{HTTPStatus: resp.StatusCode}
	var payload struct {
		Code       int     `json:"code"`
		Message    string  `json:"message"`
		RetryAfter float64 `json:"retry_after"`
		Global     bool    `json:"global"`
	}
	if json.Unmarshal(data, &payload) == nil {
		apiErr.Code = payload.Code
		apiErr.Message = payload.Message
		apiErr.Global = payload.Global
		if payload.RetryAfter > 0 {
			apiErr.RetryAfter = time.Duration(payload.RetryAfter * float64(time.Second))
		}
	}
	if apiErr.RetryAfter <= 0 {
		if seconds := parseSeconds(resp.Header.Get("Retry-After")); seconds > 0 {
			apiErr.RetryAfter = seconds
		}
	}
	if strings.EqualFold(resp.Header.Get("X-RateLimit-Global"), "true") {
		apiErr.Global = true
	}
	return apiErr
}

func requireID(name, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("discord %s is required", name)
	}
	for _, r := range id {
		if r < '0' || r > '9' {
			return fmt.Errorf("discord %s is invalid", name)
		}
	}
	return nil
}
