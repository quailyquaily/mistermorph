package larkapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Client sends Lark IM messages and uploads their files, authenticated with a tenant token.
type Client struct {
	http    *http.Client
	baseURL string
	tokens  *TenantTokenClient
}

type SendMessageRequest struct {
	ReceiveID string `json:"receive_id"`
	MsgType   string `json:"msg_type"`
	Content   string `json:"content"`
	UUID      string `json:"uuid,omitempty"`
}

type ReplyMessageRequest struct {
	Content       string `json:"content"`
	MsgType       string `json:"msg_type"`
	ReplyInThread bool   `json:"reply_in_thread,omitempty"`
	UUID          string `json:"uuid,omitempty"`
}

func NewClient(httpClient *http.Client, baseURL string, tokens *TenantTokenClient) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	baseURL = strings.TrimSpace(strings.TrimRight(baseURL, "/"))
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{http: httpClient, baseURL: baseURL, tokens: tokens}
}

// SendMessage sends a message of msgType with content (marshaled to JSON) to a chat or user.
func (c *Client) SendMessage(ctx context.Context, receiveIDType, receiveID, msgType string, content any) error {
	if c == nil {
		return fmt.Errorf("lark api is not initialized")
	}
	receiveIDType = strings.TrimSpace(receiveIDType)
	receiveID = strings.TrimSpace(receiveID)
	msgType = strings.TrimSpace(msgType)
	if receiveIDType == "" {
		return fmt.Errorf("lark receive_id_type is required")
	}
	if receiveID == "" {
		return fmt.Errorf("lark receive_id is required")
	}
	if msgType == "" {
		return fmt.Errorf("lark msg_type is required")
	}
	contentRaw, err := json.Marshal(content)
	if err != nil {
		return err
	}
	endpoint := c.baseURL + "/im/v1/messages?receive_id_type=" + url.QueryEscape(receiveIDType)
	return c.PostJSON(ctx, endpoint, SendMessageRequest{
		ReceiveID: receiveID,
		MsgType:   msgType,
		Content:   string(contentRaw),
		UUID:      uuid.NewString(),
	})
}

// ReplyMessage replies to messageID with a message of msgType.
func (c *Client) ReplyMessage(ctx context.Context, messageID, msgType string, content any) error {
	if c == nil {
		return fmt.Errorf("lark api is not initialized")
	}
	messageID = strings.TrimSpace(messageID)
	msgType = strings.TrimSpace(msgType)
	if messageID == "" {
		return fmt.Errorf("lark message id is required")
	}
	if msgType == "" {
		return fmt.Errorf("lark msg_type is required")
	}
	contentRaw, err := json.Marshal(content)
	if err != nil {
		return err
	}
	endpoint := c.baseURL + "/im/v1/messages/" + url.PathEscape(messageID) + "/reply"
	return c.PostJSON(ctx, endpoint, ReplyMessageRequest{
		Content: string(contentRaw),
		MsgType: msgType,
		UUID:    uuid.NewString(),
	})
}

// UploadImage uploads an image for an image message and returns its image_key.
func (c *Client) UploadImage(ctx context.Context, filePath string) (string, error) {
	if c == nil {
		return "", fmt.Errorf("lark api is not initialized")
	}
	var out struct {
		Data struct {
			ImageKey string `json:"image_key"`
		} `json:"data"`
	}
	if err := c.postMultipartFile(ctx, c.baseURL+"/im/v1/images", filePath, "", "image", map[string]string{
		"image_type": "message",
	}, &out); err != nil {
		return "", err
	}
	imageKey := strings.TrimSpace(out.Data.ImageKey)
	if imageKey == "" {
		return "", fmt.Errorf("lark image upload returned empty image_key")
	}
	return imageKey, nil
}

// UploadFile uploads a file of fileType ("stream" for any file, "opus" for audio) and returns its
// file_key.
func (c *Client) UploadFile(ctx context.Context, filePath, filename, fileType string, durationMS int) (string, error) {
	if c == nil {
		return "", fmt.Errorf("lark api is not initialized")
	}
	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = filepath.Base(strings.TrimSpace(filePath))
	}
	fields := map[string]string{
		"file_type": strings.TrimSpace(fileType),
		"file_name": filename,
	}
	if durationMS > 0 {
		fields["duration"] = fmt.Sprint(durationMS)
	}
	var out struct {
		Data struct {
			FileKey string `json:"file_key"`
		} `json:"data"`
	}
	if err := c.postMultipartFile(ctx, c.baseURL+"/im/v1/files", filePath, filename, "file", fields, &out); err != nil {
		return "", err
	}
	fileKey := strings.TrimSpace(out.Data.FileKey)
	if fileKey == "" {
		return "", fmt.Errorf("lark file upload returned empty file_key")
	}
	return fileKey, nil
}

// PostJSON posts payload to endpoint and checks Lark's response code.
func (c *Client) PostJSON(ctx context.Context, endpoint string, payload any) error {
	if c == nil {
		return fmt.Errorf("lark api is not initialized")
	}
	if c.tokens == nil {
		return fmt.Errorf("lark token client is not initialized")
	}
	bodyRaw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	token, err := c.tokens.Token(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyRaw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("lark http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return decodeResponse(raw, nil)
}

func (c *Client) postMultipartFile(ctx context.Context, endpoint, filePath, filename, fileField string, fields map[string]string, out any) error {
	if c.tokens == nil {
		return fmt.Errorf("lark token client is not initialized")
	}
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		return fmt.Errorf("missing file path")
	}
	fileField = strings.TrimSpace(fileField)
	if fileField == "" {
		return fmt.Errorf("lark multipart file field is required")
	}
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.IsDir() {
		return fmt.Errorf("path is a directory: %s", filePath)
	}
	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = filepath.Base(filePath)
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for k, v := range fields {
		if strings.TrimSpace(k) == "" || strings.TrimSpace(v) == "" {
			continue
		}
		if err := mw.WriteField(k, v); err != nil {
			_ = mw.Close()
			return err
		}
	}
	part, err := mw.CreateFormFile(fileField, filename)
	if err != nil {
		_ = mw.Close()
		return err
	}
	if _, err := io.Copy(part, f); err != nil {
		_ = mw.Close()
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}

	token, err := c.tokens.Token(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("lark http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return decodeResponse(raw, out)
}

func decodeResponse(raw []byte, out any) error {
	var code struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err := json.Unmarshal(raw, &code); err != nil {
		return fmt.Errorf("decode lark response: %w", err)
	}
	if code.Code != 0 {
		return fmt.Errorf("lark api code %d: %s", code.Code, strings.TrimSpace(code.Msg))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode lark response: %w", err)
	}
	return nil
}
