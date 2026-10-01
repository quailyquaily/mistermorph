package wechatapi

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
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
	// DefaultCDNBaseURL is the CDN that holds message media; files there are AES-128-ECB encrypted.
	DefaultCDNBaseURL = "https://novac2c.cdn.weixin.qq.com/c2c"
	// MaxMediaBytes caps one media download or upload.
	MaxMediaBytes = 100 << 20

	mediaTimeout = 2 * time.Minute

	uploadImage = 1
	uploadVideo = 2
	uploadFile  = 3
)

// CDNMedia locates one encrypted file on the CDN. AESKey is base64, of either the 16 key bytes or
// their 32-character hex form; both are seen.
type CDNMedia struct {
	EncryptQueryParam string `json:"encrypt_query_param,omitempty"`
	AESKey            string `json:"aes_key,omitempty"`
	EncryptType       int    `json:"encrypt_type,omitempty"`
	FullURL           string `json:"full_url,omitempty"`
}

func (m *CDNMedia) present() bool {
	return m != nil && (strings.TrimSpace(m.EncryptQueryParam) != "" || strings.TrimSpace(m.FullURL) != "")
}

// MediaKind names what a media item is.
type MediaKind string

const (
	MediaImage MediaKind = "image"
	MediaVoice MediaKind = "voice"
	MediaFile  MediaKind = "file"
	MediaVideo MediaKind = "video"
)

// MediaRef is one media item of a message, ready to download.
type MediaRef struct {
	Kind MediaKind
	// Name is the file name the sender gave (files only).
	Name string
	// Size is the plaintext size when the message states it, else 0.
	Size  int64
	media CDNMedia
	// hexKey is the image key given as hex in image_item.aeskey, preferred over media.aes_key.
	hexKey string
}

// Media lists the message's downloadable media. A voice message with a transcript is read as text
// (see Text) and not listed.
func (m Message) Media() []MediaRef {
	var out []MediaRef
	for _, item := range m.ItemList {
		switch item.Type {
		case ItemImage:
			if item.ImageItem != nil && item.ImageItem.Media.present() {
				out = append(out, MediaRef{Kind: MediaImage, media: *item.ImageItem.Media, hexKey: strings.TrimSpace(item.ImageItem.AESKey)})
			}
		case ItemVoice:
			if item.VoiceItem != nil && strings.TrimSpace(item.VoiceItem.Text) == "" && item.VoiceItem.Media.present() {
				out = append(out, MediaRef{Kind: MediaVoice, Name: "voice.silk", media: *item.VoiceItem.Media})
			}
		case ItemFile:
			if item.FileItem != nil && item.FileItem.Media.present() {
				size, _ := strconv.ParseInt(strings.TrimSpace(item.FileItem.Len), 10, 64)
				out = append(out, MediaRef{Kind: MediaFile, Name: strings.TrimSpace(item.FileItem.FileName), Size: size, media: *item.FileItem.Media})
			}
		case ItemVideo:
			if item.VideoItem != nil && item.VideoItem.Media.present() {
				out = append(out, MediaRef{Kind: MediaVideo, Name: "video.mp4", media: *item.VideoItem.Media})
			}
		}
	}
	return out
}

// DownloadMedia fetches and decrypts one media item. The CDN needs no bot token; the URL must still
// be an https URL on a WeChat host (or the client's CDN), so a message cannot point the download
// elsewhere.
func (c *Client) DownloadMedia(ctx context.Context, ref MediaRef) ([]byte, error) {
	target, err := c.mediaURL(ref.media)
	if err != nil {
		return nil, err
	}
	var key []byte
	switch {
	case ref.hexKey != "":
		key, err = hex.DecodeString(ref.hexKey)
		if err == nil && len(key) != aes.BlockSize {
			err = fmt.Errorf("key is %d bytes", len(key))
		}
	case strings.TrimSpace(ref.media.AESKey) != "":
		key, err = ParseAESKey(ref.media.AESKey)
	}
	if err != nil {
		return nil, fmt.Errorf("wechat media key: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, mediaTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, &APIError{HTTPStatus: resp.StatusCode, Op: "cdn download"}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxMediaBytes+aes.BlockSize+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > MaxMediaBytes+aes.BlockSize {
		return nil, fmt.Errorf("wechat media is over %d bytes", MaxMediaBytes)
	}
	if key == nil {
		// Images may come unencrypted when no key is given.
		return raw, nil
	}
	return DecryptECB(raw, key)
}

func (c *Client) mediaURL(media CDNMedia) (string, error) {
	if full := strings.TrimSpace(media.FullURL); full != "" {
		if !c.allowedMediaURL(full) {
			return "", fmt.Errorf("wechat media url is not on a WeChat host")
		}
		return full, nil
	}
	param := strings.TrimSpace(media.EncryptQueryParam)
	if param == "" {
		return "", fmt.Errorf("wechat media has no location")
	}
	return c.cdnBaseURL + "/download?encrypted_query_param=" + url.QueryEscape(param), nil
}

func (c *Client) allowedMediaURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return false
	}
	if cdn, err := url.Parse(c.cdnBaseURL); err == nil && parsed.Scheme == cdn.Scheme && parsed.Host == cdn.Host {
		return true
	}
	host := strings.ToLower(parsed.Hostname())
	return parsed.Scheme == "https" && (host == "qq.com" || strings.HasSuffix(host, ".qq.com"))
}

// Uploaded is a file on the CDN, ready to send.
type Uploaded struct {
	DownloadParam string
	// HexKey is the AES key in hex; messages carry it base64 encoded.
	HexKey         string
	Size           int64
	CiphertextSize int64
}

func (u Uploaded) media() CDNMedia {
	return CDNMedia{EncryptQueryParam: u.DownloadParam, AESKey: base64.StdEncoding.EncodeToString([]byte(u.HexKey)), EncryptType: 1}
}

// UploadMedia encrypts data with a new key and uploads it for toUserID.
func (c *Client) UploadMedia(ctx context.Context, toUserID string, kind MediaKind, data []byte) (Uploaded, error) {
	if len(data) == 0 {
		return Uploaded{}, fmt.Errorf("wechat upload: file is empty")
	}
	if len(data) > MaxMediaBytes {
		return Uploaded{}, fmt.Errorf("wechat upload: file is over %d bytes", MaxMediaBytes)
	}
	mediaType := uploadFile
	switch kind {
	case MediaImage:
		mediaType = uploadImage
	case MediaVideo:
		mediaType = uploadVideo
	}
	key := make([]byte, aes.BlockSize)
	fileKey := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		return Uploaded{}, err
	}
	if _, err := rand.Read(fileKey); err != nil {
		return Uploaded{}, err
	}
	sum := md5.Sum(data)
	ciphertext, err := EncryptECB(data, key)
	if err != nil {
		return Uploaded{}, err
	}
	var resp struct {
		result
		UploadParam   string `json:"upload_param"`
		UploadFullURL string `json:"upload_full_url"`
	}
	body := map[string]any{
		"filekey":       hex.EncodeToString(fileKey),
		"media_type":    mediaType,
		"to_user_id":    toUserID,
		"rawsize":       len(data),
		"rawfilemd5":    hex.EncodeToString(sum[:]),
		"filesize":      len(ciphertext),
		"no_need_thumb": true,
		"aeskey":        hex.EncodeToString(key),
		"base_info":     c.baseInfo(),
	}
	if err := c.post(ctx, "getuploadurl", "/ilink/bot/getuploadurl", body, true, apiTimeout, &resp); err != nil {
		return Uploaded{}, err
	}
	if err := resp.err("getuploadurl"); err != nil {
		return Uploaded{}, err
	}
	target := strings.TrimSpace(resp.UploadFullURL)
	switch {
	case target != "":
		if !c.allowedMediaURL(target) {
			return Uploaded{}, fmt.Errorf("wechat upload url is not on a WeChat host")
		}
	case strings.TrimSpace(resp.UploadParam) != "":
		target = c.cdnBaseURL + "/upload?encrypted_query_param=" + url.QueryEscape(resp.UploadParam) + "&filekey=" + hex.EncodeToString(fileKey)
	default:
		return Uploaded{}, fmt.Errorf("wechat getuploadurl returned no upload url")
	}
	param, err := c.postCiphertext(ctx, target, ciphertext)
	if err != nil {
		return Uploaded{}, err
	}
	return Uploaded{DownloadParam: param, HexKey: hex.EncodeToString(key), Size: int64(len(data)), CiphertextSize: int64(len(ciphertext))}, nil
}

// postCiphertext uploads to the CDN, retrying server errors twice; the CDN answers with the
// download parameter in a header.
func (c *Client) postCiphertext(ctx context.Context, target string, ciphertext []byte) (string, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		param, retry, err := c.postCiphertextOnce(ctx, target, ciphertext)
		if err == nil {
			return param, nil
		}
		lastErr = err
		if !retry || ctx.Err() != nil {
			break
		}
	}
	return "", lastErr
}

func (c *Client) postCiphertextOnce(ctx context.Context, target string, ciphertext []byte) (string, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, mediaTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(ciphertext))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", true, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 == 4 {
		return "", false, &APIError{HTTPStatus: resp.StatusCode, Op: "cdn upload"}
	}
	if resp.StatusCode != http.StatusOK {
		return "", true, &APIError{HTTPStatus: resp.StatusCode, Op: "cdn upload"}
	}
	param := strings.TrimSpace(resp.Header.Get("x-encrypted-param"))
	if param == "" {
		return "", true, fmt.Errorf("wechat cdn upload: no x-encrypted-param in the response")
	}
	return param, false, nil
}

// SendMedia sends an uploaded file as an image, video or file message. name is the file name shown
// for a file.
func (c *Client) SendMedia(ctx context.Context, toUserID, contextToken string, kind MediaKind, name string, up Uploaded) (string, error) {
	media := up.media()
	var item map[string]any
	switch kind {
	case MediaImage:
		item = map[string]any{"type": ItemImage, "image_item": map[string]any{"media": media, "mid_size": up.CiphertextSize}}
	case MediaVideo:
		item = map[string]any{"type": ItemVideo, "video_item": map[string]any{"media": media, "video_size": up.CiphertextSize}}
	default:
		item = map[string]any{"type": ItemFile, "file_item": map[string]any{"media": media, "file_name": name, "len": fmt.Sprint(up.Size)}}
	}
	return c.sendItem(ctx, toUserID, contextToken, item)
}

// ParseAESKey decodes a message's aes_key: base64 of 16 bytes, or of their 32-character hex form.
func ParseAESKey(encoded string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return nil, err
	}
	switch {
	case len(decoded) == aes.BlockSize:
		return decoded, nil
	case len(decoded) == 2*aes.BlockSize:
		key, err := hex.DecodeString(string(decoded))
		if err == nil {
			return key, nil
		}
	}
	return nil, fmt.Errorf("aes_key decodes to %d bytes, not a 16-byte key", len(decoded))
}

var errPadding = errors.New("wechat media: bad padding")

// EncryptECB encrypts with AES-128-ECB and PKCS#7 padding, as the CDN expects.
func EncryptECB(plaintext, key []byte) ([]byte, error) {
	if len(key) != aes.BlockSize {
		return nil, fmt.Errorf("wechat media: key must be 16 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	pad := aes.BlockSize - len(plaintext)%aes.BlockSize
	data := make([]byte, len(plaintext)+pad)
	copy(data, plaintext)
	for i := len(plaintext); i < len(data); i++ {
		data[i] = byte(pad)
	}
	for i := 0; i < len(data); i += aes.BlockSize {
		block.Encrypt(data[i:i+aes.BlockSize], data[i:i+aes.BlockSize])
	}
	return data, nil
}

// DecryptECB reverses EncryptECB, rejecting a length or padding that is not valid.
func DecryptECB(ciphertext, key []byte) ([]byte, error) {
	if len(key) != aes.BlockSize {
		return nil, fmt.Errorf("wechat media: key must be 16 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("wechat media: ciphertext is %d bytes, not whole blocks", len(ciphertext))
	}
	out := make([]byte, len(ciphertext))
	for i := 0; i < len(out); i += aes.BlockSize {
		block.Decrypt(out[i:i+aes.BlockSize], ciphertext[i:i+aes.BlockSize])
	}
	pad := int(out[len(out)-1])
	if pad == 0 || pad > aes.BlockSize {
		return nil, errPadding
	}
	for _, b := range out[len(out)-pad:] {
		if int(b) != pad {
			return nil, errPadding
		}
	}
	return out[:len(out)-pad], nil
}
