package whatsappapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Media limits from the developer manual: 5 MB for an image, 500 KB for a sticker, 16 MB for
// anything else; captions hold 1024 characters.
const (
	MaxImageBytes    = 5 << 20
	MaxStickerBytes  = 500 << 10
	MaxMediaBytes    = 16 << 20
	MaxCaptionLength = 1024

	mediaPerMinute = 12
)

// MediaInfo is what GET /media/{id} returns about stored bytes.
type MediaInfo struct {
	URL      string `json:"url"`
	MimeType string `json:"mime_type"`
	SHA256   string `json:"sha256"`
	FileSize int64  `json:"file_size"`
	ID       string `json:"id"`
}

// DownloadMedia fetches the bytes of a media id, checking size and digest. The token is sent only
// to the API host and to WhatsApp's own media hosts.
func (c *Client) DownloadMedia(ctx context.Context, mediaID string, maxBytes int64) ([]byte, MediaInfo, error) {
	mediaID = strings.TrimSpace(mediaID)
	if mediaID == "" || strings.ContainsAny(mediaID, "/?#") {
		return nil, MediaInfo{}, fmt.Errorf("whatsapp media id is invalid")
	}
	if maxBytes <= 0 || maxBytes > MaxMediaBytes {
		maxBytes = MaxMediaBytes
	}
	if err := c.mediaGets.wait(ctx, c.now, c.sleep); err != nil {
		return nil, MediaInfo{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	req, err := c.request(ctx, http.MethodGet, "/media/"+url.PathEscape(mediaID), nil)
	if err != nil {
		return nil, MediaInfo{}, err
	}
	var info MediaInfo
	if _, err := c.do(req, &info); err != nil {
		return nil, MediaInfo{}, err
	}
	if info.FileSize > maxBytes {
		return nil, info, fmt.Errorf("whatsapp media is %d bytes, over %d", info.FileSize, maxBytes)
	}
	if !c.allowedMediaURL(info.URL) {
		return nil, info, fmt.Errorf("whatsapp media url is not on a WhatsApp host")
	}
	get, err := http.NewRequestWithContext(ctx, http.MethodGet, info.URL, nil)
	if err != nil {
		return nil, info, err
	}
	get.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(get)
	if err != nil {
		return nil, info, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, info, decodeError(resp.StatusCode, raw)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, info, err
	}
	if int64(len(data)) > maxBytes {
		return nil, info, fmt.Errorf("whatsapp media is over %d bytes", maxBytes)
	}
	if want := strings.ToLower(strings.TrimSpace(info.SHA256)); want != "" {
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != want {
			return nil, info, fmt.Errorf("whatsapp media digest does not match")
		}
	}
	return data, info, nil
}

func (c *Client) allowedMediaURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return false
	}
	if base, err := url.Parse(c.baseURL); err == nil && parsed.Scheme == base.Scheme && parsed.Host == base.Host {
		return true
	}
	host := strings.ToLower(parsed.Hostname())
	if parsed.Scheme != "https" {
		return false
	}
	for _, domain := range []string{"whatsapp.com", "whatsapp.net", "fbsbx.com"} {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	return false
}

// SHA256Matches reports whether data has the Base64 SHA-256 an inbound media payload carries.
func SHA256Matches(data []byte, base64Digest string) bool {
	want, err := base64.StdEncoding.DecodeString(strings.TrimSpace(base64Digest))
	if err != nil {
		return false
	}
	sum := sha256.Sum256(data)
	return bytes.Equal(sum[:], want)
}

// MediaType is the message type to send a file as, by its MIME type: image, video, audio or
// document.
func MediaType(mimeType string) string {
	mimeType = strings.ToLower(strings.TrimSpace(strings.SplitN(mimeType, ";", 2)[0]))
	switch mimeType {
	case "image/jpeg", "image/png":
		return "image"
	case "video/mp4", "video/3gpp":
		return "video"
	case "audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg", "audio/opus":
		return "audio"
	}
	return "document"
}

// MaxBytesFor is the upload limit of a message type.
func MaxBytesFor(messageType string) int64 {
	switch messageType {
	case "image":
		return MaxImageBytes
	case "sticker":
		return MaxStickerBytes
	}
	return MaxMediaBytes
}

// UploadMedia stores a file for sending and returns its media id. A MIME type the platform does
// not take for a document is sent as application/octet-stream.
func (c *Client) UploadMedia(ctx context.Context, filename, mimeType string, data []byte) (string, error) {
	mimeType = strings.TrimSpace(mimeType)
	if mimeType == "" || MediaType(mimeType) == "document" && !documentMIME[strings.ToLower(mimeType)] {
		mimeType = "application/octet-stream"
	}
	if limit := MaxBytesFor(MediaType(mimeType)); int64(len(data)) > limit {
		return "", fmt.Errorf("whatsapp upload: %s is %d bytes, over the %d limit", filename, len(data), limit)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("whatsapp upload: file is empty")
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	_ = form.WriteField("messaging_product", "whatsapp")
	_ = form.WriteField("type", mimeType)
	header := make(textproto.MIMEHeader)
	name := strings.NewReplacer(`"`, "", "\r", "", "\n", "").Replace(filepath.Base(filename))
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, name))
	header.Set("Content-Type", mimeType)
	part, err := form.CreatePart(header)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	if err := form.Close(); err != nil {
		return "", err
	}
	if err := c.mediaUploads.wait(ctx, c.now, c.sleep); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/media", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", form.FormDataContentType())
	var resp struct {
		ID string `json:"id"`
	}
	if _, err := c.do(req, &resp); err != nil {
		return "", err
	}
	if strings.TrimSpace(resp.ID) == "" {
		return "", fmt.Errorf("whatsapp upload: no media id in the response")
	}
	return resp.ID, nil
}

var documentMIME = map[string]bool{
	"application/pdf": true, "text/plain": true, "application/msword": true,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
	"application/vnd.ms-excel": true,
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         true,
	"application/vnd.ms-powerpoint":                                             true,
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
	"application/octet-stream":                                                  true,
}

// SendMedia sends an uploaded media id as messageType (image, video, audio or document), with a
// caption where the type takes one and a file name for a document. Like SendText, an unknown
// outcome returns ErrSendUnknown.
func (c *Client) SendMedia(ctx context.Context, userID, messageType, mediaID, caption, filename string) (string, error) {
	object := map[string]any{"id": strings.TrimSpace(mediaID)}
	caption = strings.TrimSpace(caption)
	if utf8.RuneCountInString(caption) > MaxCaptionLength {
		caption = string([]rune(caption)[:MaxCaptionLength-1]) + "…"
	}
	switch messageType {
	case "image", "video":
		if caption != "" {
			object["caption"] = caption
		}
	case "document":
		if caption != "" {
			object["caption"] = caption
		}
		if name := strings.TrimSpace(filepath.Base(filename)); name != "" && name != "." {
			object["filename"] = name
		}
	case "audio":
	default:
		return "", fmt.Errorf("whatsapp send: unsupported media type %q", messageType)
	}
	return c.sendMessage(ctx, userID, map[string]any{"type": messageType, messageType: object}, "")
}
