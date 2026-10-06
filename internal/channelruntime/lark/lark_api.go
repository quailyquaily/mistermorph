package lark

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/larkapi"
)

type larkAPI struct {
	*larkapi.Client
	http        *http.Client
	baseURL     string
	tokenClient *larkapi.TenantTokenClient
}

type larkUserProfileResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		User struct {
			Avatar struct {
				Avatar72     string `json:"avatar_72"`
				Avatar240    string `json:"avatar_240"`
				Avatar640    string `json:"avatar_640"`
				AvatarOrigin string `json:"avatar_origin"`
			} `json:"avatar"`
		} `json:"user"`
	} `json:"data"`
}

func newLarkAPI(httpClient *http.Client, baseURL string, tokenClient *larkapi.TenantTokenClient) *larkAPI {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	baseURL = strings.TrimSpace(strings.TrimRight(baseURL, "/"))
	if baseURL == "" {
		baseURL = larkapi.DefaultBaseURL
	}
	return &larkAPI{Client: larkapi.NewClient(httpClient, baseURL, tokenClient), http: httpClient, baseURL: baseURL, tokenClient: tokenClient}
}

func (api *larkAPI) sendText(ctx context.Context, receiveIDType, receiveID, text string) error {
	if api == nil {
		return fmt.Errorf("lark api is not initialized")
	}
	receiveIDType = strings.TrimSpace(receiveIDType)
	receiveID = strings.TrimSpace(receiveID)
	text = strings.TrimSpace(text)
	if receiveIDType == "" {
		return fmt.Errorf("lark receive_id_type is required")
	}
	if receiveID == "" {
		return fmt.Errorf("lark receive_id is required")
	}
	if text == "" {
		return fmt.Errorf("lark text is required")
	}
	return api.SendMessage(ctx, receiveIDType, receiveID, "text", map[string]string{"text": text})
}

func (api *larkAPI) replyText(ctx context.Context, messageID, text string) error {
	if api == nil {
		return fmt.Errorf("lark api is not initialized")
	}
	messageID = strings.TrimSpace(messageID)
	text = strings.TrimSpace(text)
	if messageID == "" {
		return fmt.Errorf("lark message id is required")
	}
	if text == "" {
		return fmt.Errorf("lark text is required")
	}
	return api.ReplyMessage(ctx, messageID, "text", map[string]string{"text": text})
}

func (api *larkAPI) sendFile(ctx context.Context, chatID, filePath, filename, caption string) error {
	if strings.TrimSpace(chatID) == "" {
		return fmt.Errorf("lark chat id is required")
	}
	fileKey, err := api.UploadFile(ctx, filePath, filename, "stream", 0)
	if err != nil {
		return err
	}
	if err := api.SendMessage(ctx, "chat_id", chatID, "file", map[string]string{"file_key": fileKey}); err != nil {
		return err
	}
	caption = strings.TrimSpace(caption)
	if caption == "" {
		return nil
	}
	if err := api.sendText(ctx, "chat_id", chatID, caption); err != nil {
		return fmt.Errorf("lark file sent but caption failed: %w", err)
	}
	return nil
}

func (api *larkAPI) sendPhoto(ctx context.Context, chatID, filePath, _ string, caption string) error {
	if strings.TrimSpace(chatID) == "" {
		return fmt.Errorf("lark chat id is required")
	}
	imageKey, err := api.UploadImage(ctx, filePath)
	if err != nil {
		return err
	}
	if err := api.SendMessage(ctx, "chat_id", chatID, "image", map[string]string{"image_key": imageKey}); err != nil {
		return err
	}
	caption = strings.TrimSpace(caption)
	if caption == "" {
		return nil
	}
	if err := api.sendText(ctx, "chat_id", chatID, caption); err != nil {
		return fmt.Errorf("lark photo sent but caption failed: %w", err)
	}
	return nil
}

func (api *larkAPI) sendVoice(ctx context.Context, chatID, filePath, filename string) error {
	if strings.TrimSpace(chatID) == "" {
		return fmt.Errorf("lark chat id is required")
	}
	fileKey, err := api.UploadFile(ctx, filePath, filename, "opus", 0)
	if err != nil {
		return err
	}
	return api.SendMessage(ctx, "chat_id", chatID, "audio", map[string]string{"file_key": fileKey})
}

func (api *larkAPI) setEmojiReaction(ctx context.Context, messageID, emojiType string) error {
	if api == nil {
		return fmt.Errorf("lark api is not initialized")
	}
	messageID = strings.TrimSpace(messageID)
	emojiType = strings.TrimSpace(emojiType)
	if messageID == "" {
		return fmt.Errorf("lark message id is required")
	}
	if emojiType == "" {
		return fmt.Errorf("lark emoji_type is required")
	}
	endpoint := api.baseURL + "/im/v1/messages/" + url.PathEscape(messageID) + "/reactions"
	return api.PostJSON(ctx, endpoint, map[string]any{
		"reaction_type": map[string]string{"emoji_type": emojiType},
	})
}

func (api *larkAPI) userAvatarURL(ctx context.Context, openID string) (string, error) {
	if api == nil || api.tokenClient == nil {
		return "", fmt.Errorf("lark api is not initialized")
	}
	openID = strings.TrimSpace(openID)
	if openID == "" {
		return "", fmt.Errorf("lark open id is required")
	}
	token, err := api.tokenClient.Token(ctx)
	if err != nil {
		return "", err
	}
	endpoint := api.baseURL + "/contact/v3/users/" + url.PathEscape(openID) + "?user_id_type=open_id"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := api.http.Do(req)
	if err != nil {
		return "", err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("lark user profile http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out larkUserProfileResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	if out.Code != 0 {
		return "", fmt.Errorf("lark user profile failed: %s", strings.TrimSpace(out.Msg))
	}
	return firstLarkAvatarURL(out.Data.User.Avatar.Avatar240, out.Data.User.Avatar.Avatar640, out.Data.User.Avatar.AvatarOrigin, out.Data.User.Avatar.Avatar72), nil
}

func firstLarkAvatarURL(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func (api *larkAPI) messageResource(ctx context.Context, messageID, fileKey, fileType string, maxBytes int64) ([]byte, string, error) {
	if api == nil {
		return nil, "", fmt.Errorf("lark api is not initialized")
	}
	if api.tokenClient == nil {
		return nil, "", fmt.Errorf("lark token client is not initialized")
	}
	messageID = strings.TrimSpace(messageID)
	fileKey = strings.TrimSpace(fileKey)
	fileType = strings.TrimSpace(fileType)
	if messageID == "" {
		return nil, "", fmt.Errorf("lark message id is required")
	}
	if fileKey == "" {
		return nil, "", fmt.Errorf("lark file key is required")
	}
	if fileType == "" {
		return nil, "", fmt.Errorf("lark file type is required")
	}
	if maxBytes <= 0 {
		return nil, "", fmt.Errorf("lark max bytes must be positive")
	}
	token, err := api.tokenClient.Token(ctx)
	if err != nil {
		return nil, "", err
	}
	endpoint := api.baseURL + "/im/v1/messages/" + url.PathEscape(messageID) + "/resources/" + url.PathEscape(fileKey) + "?type=" + url.QueryEscape(fileType)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := api.http.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if readErr != nil {
		return nil, "", readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("lark resource download http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if int64(len(raw)) > maxBytes {
		return nil, "", fmt.Errorf("lark resource too large: > %d bytes", maxBytes)
	}
	return raw, resp.Header.Get("Content-Type"), nil
}
