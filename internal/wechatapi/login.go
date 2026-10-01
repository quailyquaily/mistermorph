package wechatapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// QRCode is a login QR code: Code identifies it when polling; Image is what to show the user (a URL
// or image content, as the server returns it).
type QRCode struct {
	Code  string
	Image string
}

// Login statuses, as the server reports them.
const (
	QRWait              = "wait"
	QRScanned           = "scaned"
	QRConfirmed         = "confirmed"
	QRExpired           = "expired"
	QRNeedVerifyCode    = "need_verifycode"
	QRVerifyCodeBlocked = "verify_code_blocked"
	QRRedirect          = "scaned_but_redirect"
	QRAlreadyBound      = "binded_redirect"
)

// QRStatus is one poll of a login. On QRConfirmed the bot's credentials are set; on QRRedirect,
// RedirectHost names the host to keep polling.
type QRStatus struct {
	Status       string `json:"status"`
	BotToken     string `json:"bot_token,omitempty"`
	BotID        string `json:"ilink_bot_id,omitempty"`
	BaseURL      string `json:"baseurl,omitempty"`
	UserID       string `json:"ilink_user_id,omitempty"`
	RedirectHost string `json:"redirect_host,omitempty"`
}

// GetQRCode starts a login.
func (c *Client) GetQRCode(ctx context.Context) (QRCode, error) {
	var resp struct {
		QRCode  string `json:"qrcode"`
		Content string `json:"qrcode_img_content"`
	}
	body := map[string]any{"local_token_list": []string{}}
	if err := c.post(ctx, "get_bot_qrcode", "/ilink/bot/get_bot_qrcode?bot_type="+botType, body, false, apiTimeout, &resp); err != nil {
		return QRCode{}, err
	}
	if strings.TrimSpace(resp.QRCode) == "" {
		return QRCode{}, fmt.Errorf("wechat get_bot_qrcode: no qrcode in the response")
	}
	return QRCode{Code: resp.QRCode, Image: resp.Content}, nil
}

// QRCodeStatus polls a login once; the server holds the request until the status changes or its
// long-poll time passes, which reads as QRWait. verifyCode is sent only when the user typed one.
// This call carries the app headers but no bot credentials.
func (c *Client) QRCodeStatus(ctx context.Context, code, verifyCode string) (QRStatus, error) {
	query := "qrcode=" + url.QueryEscape(code)
	if verifyCode = strings.TrimSpace(verifyCode); verifyCode != "" {
		query += "&verify_code=" + url.QueryEscape(verifyCode)
	}
	pollCtx, cancel := context.WithTimeout(ctx, longPollTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(pollCtx, http.MethodGet, c.baseURL+"/ilink/bot/get_qrcode_status?"+query, nil)
	if err != nil {
		return QRStatus{}, err
	}
	c.commonHeaders(req)
	var status QRStatus
	if err := c.do(req, "get_qrcode_status", &status); err != nil {
		if ctx.Err() == nil && isTimeout(err) {
			return QRStatus{Status: QRWait}, nil
		}
		return QRStatus{}, err
	}
	if status.Status == "" {
		status.Status = QRWait
	}
	return status, nil
}

// WithBaseURL is the same client on another host: a login redirect, or the host a login returned.
func (c *Client) WithBaseURL(base string) (*Client, error) {
	return NewClient(c.token, Options{BaseURL: base, HTTPClient: c.http, BotAgent: c.botAgent, CDNBaseURL: c.cdnBaseURL})
}

// RedirectBaseURL is the API URL for a redirect host. Only a bare host name is accepted, so a
// redirect cannot point the login at a path or another scheme.
func RedirectBaseURL(host string) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" || strings.ContainsAny(host, "/?#@ \\") {
		return "", fmt.Errorf("wechat redirect host is invalid: %q", host)
	}
	return "https://" + host, nil
}
