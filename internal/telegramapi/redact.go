package telegramapi

import (
	"errors"
	"net/http"
	"net/url"
	"regexp"
)

// botTokenPath matches the bot token segment of a Bot API URL: /bot<token>/method and
// /file/bot<token>/path.
var botTokenPath = regexp.MustCompile(`/bot[^/?#]+`)

// Do sends req with client. The Bot API carries the token in the URL path, and net/http puts the
// whole URL in its errors, so the token is masked in the returned error before it reaches a log.
func Do(client *http.Client, req *http.Request) (*http.Response, error) {
	resp, err := client.Do(req)
	return resp, RedactError(err)
}

// RedactError masks a bot token in the URL of a *url.Error inside err. Other errors are returned
// unchanged.
func RedactError(err error) error {
	var urlErr *url.Error
	if err == nil || !errors.As(err, &urlErr) {
		return err
	}
	redacted := RedactURL(urlErr.URL)
	if redacted == urlErr.URL {
		return err
	}
	if err == error(urlErr) {
		return &url.Error{Op: urlErr.Op, URL: redacted, Err: urlErr.Err}
	}
	// The *url.Error is wrapped; keep the outer error's text without the token.
	return &redactedError{msg: botTokenPath.ReplaceAllString(err.Error(), "/bot<redacted>"), err: &url.Error{Op: urlErr.Op, URL: redacted, Err: urlErr.Err}}
}

// RedactURL masks the bot token in a Bot API URL.
func RedactURL(raw string) string {
	return botTokenPath.ReplaceAllString(raw, "/bot<redacted>")
}

type redactedError struct {
	msg string
	err error
}

func (e *redactedError) Error() string { return e.msg }
func (e *redactedError) Unwrap() error { return e.err }
