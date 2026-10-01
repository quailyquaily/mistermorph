// Package wechatlogin is the WeChat QR login shared by `morph wechat login` and Console: it walks
// the login through its states and saves the bot's credentials the way other channel secrets are
// saved (the token in the system keyring, a ${secret:...} reference in config).
package wechatlogin

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/configbootstrap"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/quailyquaily/mistermorph/internal/wechatapi"
)

// Result is a confirmed login: the bot's credentials.
type Result struct {
	BotToken string
	BotID    string
	BaseURL  string
	UserID   string
}

// Step is where a login stands after one poll. Done ends the login, with Result on success.
type Step struct {
	Status  string
	Message string
	Done    bool
	Result  *Result
}

// Session is one login: one QR code, polled until it is confirmed, expires or fails. Polls may
// overlap (Console sends the verification code while a long poll is still waiting).
type Session struct {
	mu     sync.Mutex
	client *wechatapi.Client
	code   string
	image  string
}

type Options struct {
	BaseURL    string
	HTTPClient *http.Client
}

// Start asks for a QR code.
func Start(ctx context.Context, opts Options) (*Session, error) {
	client, err := wechatapi.NewClient("", wechatapi.Options{BaseURL: opts.BaseURL, HTTPClient: opts.HTTPClient})
	if err != nil {
		return nil, err
	}
	code, err := client.GetQRCode(ctx)
	if err != nil {
		return nil, err
	}
	return &Session{client: client, code: code.Code, image: code.Image}, nil
}

// Image is what to show the user to scan: a URL, or image content, as the server sent it.
func (s *Session) Image() string { return s.image }

// Poll waits for the next status (up to the server's long-poll time). verifyCode is the code the
// phone showed, when the previous step asked for one.
func (s *Session) Poll(ctx context.Context, verifyCode string) (Step, error) {
	s.mu.Lock()
	client := s.client
	s.mu.Unlock()
	status, err := client.QRCodeStatus(ctx, s.code, verifyCode)
	if err != nil {
		return Step{}, err
	}
	switch status.Status {
	case wechatapi.QRWait:
		return Step{Status: status.Status, Message: "Waiting for the QR code to be scanned."}, nil
	case wechatapi.QRScanned:
		return Step{Status: status.Status, Message: "Scanned; confirm the login on the phone."}, nil
	case wechatapi.QRNeedVerifyCode:
		return Step{Status: status.Status, Message: "Enter the verification code shown on the phone."}, nil
	case wechatapi.QRRedirect:
		base, err := wechatapi.RedirectBaseURL(status.RedirectHost)
		if err != nil {
			return Step{}, err
		}
		next, err := client.WithBaseURL(base)
		if err != nil {
			return Step{}, err
		}
		s.mu.Lock()
		s.client = next
		s.mu.Unlock()
		return Step{Status: wechatapi.QRScanned, Message: "Scanned; confirm the login on the phone."}, nil
	case wechatapi.QRExpired:
		return Step{Status: status.Status, Message: "The QR code expired; start again for a new one.", Done: true}, nil
	case wechatapi.QRVerifyCodeBlocked:
		return Step{Status: status.Status, Message: "Too many wrong verification codes; start again.", Done: true}, nil
	case wechatapi.QRAlreadyBound:
		return Step{Status: status.Status, Message: "This WeChat bot is already connected to this agent.", Done: true}, nil
	case wechatapi.QRConfirmed:
		if strings.TrimSpace(status.BotToken) == "" || strings.TrimSpace(status.BotID) == "" {
			return Step{}, fmt.Errorf("wechat login confirmed without a bot token or bot id")
		}
		base := strings.TrimSpace(status.BaseURL)
		if base == "" {
			base = client.BaseURL()
		}
		return Step{Status: status.Status, Message: "Connected.", Done: true, Result: &Result{
			BotToken: strings.TrimSpace(status.BotToken), BotID: strings.TrimSpace(status.BotID), BaseURL: base, UserID: strings.TrimSpace(status.UserID),
		}}, nil
	default:
		return Step{Status: status.Status, Message: "Waiting."}, nil
	}
}

// ErrKeyringUnavailable means the system keyring cannot store the token; it is not written to the
// config file in plain text instead.
var ErrKeyringUnavailable = errors.New("the system keyring is not available")

// Save stores the token in the keyring and writes wechat.bot_token (as a ${secret:...}
// reference), wechat.bot_id and wechat.base_url to the config file. A token the previous login
// left in the keyring is deleted.
func Save(ctx context.Context, configPath string, store secref.OSStore, result Result) error {
	if err := secref.CheckOSStore(ctx, store); err != nil {
		return fmt.Errorf("%w: %v", ErrKeyringUnavailable, err)
	}
	id, err := secref.NewOSSecretID()
	if err != nil {
		return err
	}
	if err := store.Put(ctx, id, "wechat.bot_token", []byte(result.BotToken)); err != nil {
		return err
	}
	previous, err := writeConfig(configPath, map[string]string{
		"bot_token": secref.OSSecretRef(id), "bot_id": result.BotID, "base_url": result.BaseURL,
	})
	if err != nil {
		secref.DeleteOSSecrets(ctx, store, []string{id})
		return err
	}
	deletePreviousSecret(ctx, store, previous, id)
	return nil
}

// Unbind removes the bot's credentials from config and the keyring.
func Unbind(ctx context.Context, configPath string, store secref.OSStore) error {
	previous, err := writeConfig(configPath, map[string]string{"bot_token": "", "bot_id": "", "base_url": ""})
	if err != nil {
		return err
	}
	deletePreviousSecret(ctx, store, previous, "")
	return nil
}

func deletePreviousSecret(ctx context.Context, store secref.OSStore, previous, keep string) {
	ref, ok := secref.ParseSingleRef(strings.TrimSpace(previous))
	if !ok || ref.Kind != secref.RefKindOS || ref.SecretID == keep {
		return
	}
	secref.DeleteOSSecrets(ctx, store, []string{ref.SecretID})
}

// writeConfig sets keys under wechat in the config file (an empty value removes the key) and
// returns the previous wechat.bot_token.
func writeConfig(configPath string, values map[string]string) (string, error) {
	configPath = strings.TrimSpace(configPath)
	if configPath == "" {
		return "", fmt.Errorf("config path is required")
	}
	data, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	doc, err := configbootstrap.LoadDocumentBytes(data)
	if err != nil {
		return "", err
	}
	root, err := configbootstrap.DocumentMapping(doc)
	if err != nil {
		return "", err
	}
	node := configbootstrap.EnsureMappingValue(root, "wechat")
	previous := ""
	if existing := configbootstrap.FindMappingValue(node, "bot_token"); existing != nil {
		previous = existing.Value
	}
	for _, key := range []string{"bot_token", "bot_id", "base_url"} {
		if value, ok := values[key]; ok {
			configbootstrap.SetOrDeleteMappingScalar(node, key, strings.TrimSpace(value))
		}
	}
	serialized, err := configbootstrap.MarshalDocument(doc)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return "", err
	}
	return previous, fsstore.WriteTextAtomic(configPath, string(serialized), fsstore.FileOptions{DirPerm: 0o755, FilePerm: 0o600})
}
