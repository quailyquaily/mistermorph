// Package wechatapi is the small client for WeChat's iLink Bot protocol that the WeChat channel
// needs: QR login, long-polled updates, text replies and typing. It follows the client behaviour of
// Tencent's openclaw-weixin plugin (docs/protocol_zh_CN.md at 24de5c9); see
// docs/feat/feat_20261001_wechat_whatsapp_channels_research.md.
package wechatapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultBaseURL is where QR login starts; a login names the API host the bot then uses.
	DefaultBaseURL = "https://ilinkai.weixin.qq.com"
	// ProtocolVersion is the plugin revision whose client behaviour this package follows. It is
	// sent as channel_version and iLink-App-ClientVersion.
	ProtocolVersion = "2.4.8"
	appID           = "bot"
	botType         = "3"

	longPollTimeout   = 35 * time.Second
	apiTimeout        = 15 * time.Second
	lightTimeout      = 10 * time.Second
	maxResponseBytes  = 4 << 20
	sessionExpiredErr = -14
)

type Options struct {
	BaseURL    string
	HTTPClient *http.Client
	// BotAgent identifies Morph in base_info, for the server's logs; "Mistermorph" by default.
	BotAgent string
	// CDNBaseURL is where media is downloaded and uploaded; DefaultCDNBaseURL by default.
	CDNBaseURL string
}

// Client talks to one iLink API host, with or without a bot token (login calls need none).
type Client struct {
	token      string
	baseURL    string
	cdnBaseURL string
	http       *http.Client
	botAgent   string
}

func NewClient(token string, opts Options) (*Client, error) {
	base := strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/")
	if base == "" {
		base = DefaultBaseURL
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "https" && parsed.Scheme != "http" || parsed.Host == "" {
		return nil, fmt.Errorf("wechat api base url is invalid: %q", opts.BaseURL)
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	agent := strings.TrimSpace(opts.BotAgent)
	if agent == "" {
		agent = "Mistermorph"
	}
	cdn := strings.TrimRight(strings.TrimSpace(opts.CDNBaseURL), "/")
	if cdn == "" {
		cdn = DefaultCDNBaseURL
	}
	if parsed, err := url.Parse(cdn); err != nil || parsed.Scheme != "https" && parsed.Scheme != "http" || parsed.Host == "" {
		return nil, fmt.Errorf("wechat cdn base url is invalid: %q", opts.CDNBaseURL)
	}
	return &Client{token: strings.TrimSpace(token), baseURL: base, cdnBaseURL: cdn, http: client, botAgent: agent}, nil
}

// BaseURL is the API host the client sends to.
func (c *Client) BaseURL() string { return c.baseURL }

// APIError is a failed call: an HTTP error status, or a business error (ret or errcode not 0) in a
// successful response.
type APIError struct {
	HTTPStatus int
	Ret        int
	ErrCode    int
	ErrMsg     string
	Op         string
}

func (e *APIError) Error() string {
	if e.HTTPStatus != 0 && e.HTTPStatus/100 != 2 {
		return fmt.Sprintf("wechat %s: HTTP %d", e.Op, e.HTTPStatus)
	}
	msg := fmt.Sprintf("wechat %s: ret=%d errcode=%d", e.Op, e.Ret, e.ErrCode)
	if e.ErrMsg != "" {
		msg += " " + e.ErrMsg
	}
	return msg
}

// IsSessionExpired reports whether the bot's session is no longer valid (ret or errcode -14): the
// user has to scan a QR code again, so retrying does not help.
func IsSessionExpired(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && (apiErr.Ret == sessionExpiredErr || apiErr.ErrCode == sessionExpiredErr)
}

type baseInfo struct {
	ChannelVersion string `json:"channel_version"`
	BotAgent       string `json:"bot_agent"`
}

func (c *Client) baseInfo() baseInfo {
	return baseInfo{ChannelVersion: ProtocolVersion, BotAgent: c.botAgent}
}

func clientVersion() string {
	parts := strings.Split(ProtocolVersion, ".")
	value := 0
	for i := 0; i < 3; i++ {
		n := 0
		if i < len(parts) {
			n, _ = strconv.Atoi(parts[i])
		}
		value = value<<8 | n&0xff
	}
	return strconv.Itoa(value)
}

// randomUIN is X-WECHAT-UIN: a random uint32, as a decimal string, base64 encoded.
func randomUIN() string {
	var raw [4]byte
	_, _ = rand.Read(raw[:])
	return base64.StdEncoding.EncodeToString([]byte(strconv.FormatUint(uint64(binary.BigEndian.Uint32(raw[:])), 10)))
}

func (c *Client) commonHeaders(req *http.Request) {
	req.Header.Set("iLink-App-Id", appID)
	req.Header.Set("iLink-App-ClientVersion", clientVersion())
}

// post sends a JSON POST. withToken adds the bot token; the QR-code request goes without one.
func (c *Client) post(ctx context.Context, op, path string, body any, withToken bool, timeout time.Duration, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("AuthorizationType", "ilink_bot_token")
	req.Header.Set("X-WECHAT-UIN", randomUIN())
	c.commonHeaders(req)
	if withToken {
		if c.token == "" {
			return fmt.Errorf("wechat %s: bot token is required", op)
		}
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	return c.do(req, op, out)
}

func (c *Client) do(req *http.Request, op string, out any) error {
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return &APIError{HTTPStatus: resp.StatusCode, Op: op}
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("wechat %s: invalid response: %w", op, err)
	}
	return nil
}

// result holds the business result fields some responses carry.
type result struct {
	Ret     *int   `json:"ret,omitempty"`
	ErrCode *int   `json:"errcode,omitempty"`
	ErrMsg  string `json:"errmsg,omitempty"`
}

func (r result) err(op string) error {
	ret, code := 0, 0
	if r.Ret != nil {
		ret = *r.Ret
	}
	if r.ErrCode != nil {
		code = *r.ErrCode
	}
	if ret == 0 && code == 0 {
		return nil
	}
	return &APIError{HTTPStatus: http.StatusOK, Ret: ret, ErrCode: code, ErrMsg: strings.TrimSpace(r.ErrMsg), Op: op}
}

func isTimeout(err error) bool {
	var netErr interface{ Timeout() bool }
	return errors.Is(err, context.DeadlineExceeded) || errors.As(err, &netErr) && netErr.Timeout()
}
