package slackclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// UploadFile uploads a local file and shares it in channelID, in the thread threadTS when set, with
// initialComment as its message. It uses Slack's external upload flow: get an upload URL, send the
// bytes, then complete the upload.
func (c *Client) UploadFile(ctx context.Context, channelID, threadTS, filePath, filename, title, initialComment string) error {
	if c == nil || c.http == nil {
		return fmt.Errorf("slack client is not initialized")
	}
	channelID = strings.TrimSpace(channelID)
	threadTS = strings.TrimSpace(threadTS)
	filePath = strings.TrimSpace(filePath)
	filename = strings.TrimSpace(filename)
	title = strings.TrimSpace(title)
	initialComment = strings.TrimSpace(initialComment)
	if channelID == "" {
		return fmt.Errorf("channel_id is required")
	}
	if filePath == "" {
		return fmt.Errorf("file path is required")
	}
	if filename == "" {
		filename = filepath.Base(filePath)
	}
	if title == "" {
		title = filename
	}
	st, err := os.Stat(filePath)
	if err != nil {
		return err
	}
	if st.IsDir() {
		return fmt.Errorf("file path is a directory: %s", filePath)
	}
	uploadURL, fileID, err := c.getUploadURLExternal(ctx, filename, st.Size())
	if err != nil {
		return err
	}
	if err := c.uploadFileToExternalURL(ctx, uploadURL, filePath, st.Size()); err != nil {
		return err
	}
	return c.completeUploadExternal(ctx, channelID, threadTS, fileID, title, initialComment)
}

func (c *Client) getUploadURLExternal(ctx context.Context, filename string, length int64) (string, string, error) {
	if length <= 0 {
		return "", "", fmt.Errorf("file length is invalid")
	}
	form := url.Values{
		"filename": []string{filename},
		"length":   []string{strconv.FormatInt(length, 10)},
	}
	var out struct {
		OK        bool   `json:"ok"`
		Error     string `json:"error,omitempty"`
		UploadURL string `json:"upload_url,omitempty"`
		FileID    string `json:"file_id,omitempty"`
	}
	if err := c.postOnce(ctx, "/files.getUploadURLExternal", "application/x-www-form-urlencoded; charset=utf-8", []byte(form.Encode()), &out); err != nil {
		return "", "", err
	}
	if !out.OK {
		return "", "", fmt.Errorf("slack files.getUploadURLExternal failed: %s", slackErrorCode(out.Error))
	}
	uploadURL := strings.TrimSpace(out.UploadURL)
	fileID := strings.TrimSpace(out.FileID)
	if uploadURL == "" || fileID == "" {
		return "", "", fmt.Errorf("slack files.getUploadURLExternal returned incomplete payload")
	}
	return uploadURL, fileID, nil
}

func (c *Client) uploadFileToExternalURL(ctx context.Context, uploadURL, filePath string, contentLength int64) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL, f)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = contentLength
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	raw, readErr := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if readErr != nil {
		return readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(raw))
		if msg == "" {
			return fmt.Errorf("slack external file upload http %d", resp.StatusCode)
		}
		return fmt.Errorf("slack external file upload http %d: %s", resp.StatusCode, msg)
	}
	return nil
}

func (c *Client) completeUploadExternal(ctx context.Context, channelID, threadTS, fileID, title, initialComment string) error {
	payload := map[string]any{
		"channel_id": channelID,
		"files":      []map[string]string{{"id": fileID, "title": title}},
	}
	if threadTS != "" {
		payload["thread_ts"] = threadTS
	}
	if initialComment != "" {
		payload["initial_comment"] = initialComment
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
	}
	if err := c.postOnce(ctx, "/files.completeUploadExternal", "application/json", raw, &out); err != nil {
		return err
	}
	if !out.OK {
		return fmt.Errorf("slack files.completeUploadExternal failed: %s", slackErrorCode(out.Error))
	}
	return nil
}

// postOnce posts body to a Slack method without retrying, and decodes the reply into out.
func (c *Client) postOnce(ctx context.Context, path, contentType string, body []byte, out any) error {
	if c.botToken == "" {
		return fmt.Errorf("slack token is required")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.botToken)
	req.Header.Set("Content-Type", contentType)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	raw, readErr := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if readErr != nil {
		return readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("slack %s http %d", strings.TrimPrefix(path, "/"), resp.StatusCode)
	}
	return json.Unmarshal(raw, out)
}

func slackErrorCode(code string) string {
	if code = strings.TrimSpace(code); code != "" {
		return code
	}
	return "unknown_error"
}
