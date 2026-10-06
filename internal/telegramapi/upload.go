// Package telegramapi holds Telegram Bot API calls shared by the Telegram runtime and code that
// sends outside it, such as contacts_send.
package telegramapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf16"
)

// MaxCaptionLength is the longest caption Telegram attaches to a file.
const MaxCaptionLength = 1024

// CaptionFits reports whether caption fits on a file. Telegram counts UTF-16 code units.
func CaptionFits(caption string) bool {
	return len(utf16.Encode([]rune(strings.TrimSpace(caption)))) <= MaxCaptionLength
}

// Upload is one multipart Bot API call that sends a local file.
type Upload struct {
	// ChatID is a numeric chat ID or an @username.
	ChatID          string
	MessageThreadID int64
	FilePath        string
	Filename        string
	Caption         string
	// Method is the Bot API method, such as sendDocument, and FormField its file field.
	Method    string
	FormField string
	// FallbackFilename names the file when neither Filename nor FilePath gives a name.
	FallbackFilename string
}

// SendFile streams the file in upload to the Bot API.
func SendFile(ctx context.Context, httpClient *http.Client, baseURL, token string, upload Upload) error {
	filePath := strings.TrimSpace(upload.FilePath)
	if filePath == "" {
		return fmt.Errorf("missing file path")
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

	filename := strings.TrimSpace(upload.Filename)
	if filename == "" {
		filename = filepath.Base(filePath)
	}
	if filename == "" {
		filename = upload.FallbackFilename
	}
	caption := strings.TrimSpace(upload.Caption)

	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		defer pw.Close()
		defer mw.Close()

		_ = mw.WriteField("chat_id", strings.TrimSpace(upload.ChatID))
		if upload.MessageThreadID > 0 {
			_ = mw.WriteField("message_thread_id", strconv.FormatInt(upload.MessageThreadID, 10))
		}
		if caption != "" {
			_ = mw.WriteField("caption", caption)
		}

		part, err := mw.CreateFormFile(upload.FormField, filename)
		if err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		if _, err := io.Copy(part, f); err != nil {
			_ = pw.CloseWithError(err)
			return
		}
	}()

	url := fmt.Sprintf("%s/bot%s/%s", strings.TrimRight(baseURL, "/"), token, upload.Method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, pr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var ok struct {
		OK bool `json:"ok"`
	}
	_ = json.Unmarshal(raw, &ok)
	if !ok.OK {
		return fmt.Errorf("telegram %s: ok=false", upload.Method)
	}
	return nil
}
