package telegramapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

const testToken = "7710474371:AAF-secret_token"

func TestRedactError(t *testing.T) {
	reset := errors.New("read: connection reset by peer")
	cases := []struct {
		name string
		err  error
		want string
	}{
		{
			name: "method url",
			err:  &url.Error{Op: "Get", URL: "https://api.telegram.org/bot" + testToken + "/getUpdates?timeout=30", Err: reset},
			want: `Get "https://api.telegram.org/bot<redacted>/getUpdates?timeout=30": read: connection reset by peer`,
		},
		{
			name: "file url",
			err:  &url.Error{Op: "Get", URL: "https://api.telegram.org/file/bot" + testToken + "/photos/a.jpg", Err: reset},
			want: `Get "https://api.telegram.org/file/bot<redacted>/photos/a.jpg": read: connection reset by peer`,
		},
		{
			name: "wrapped",
			err:  fmt.Errorf("send: %w", &url.Error{Op: "Post", URL: "https://api.telegram.org/bot" + testToken + "/sendMessage", Err: reset}),
			want: `send: Post "https://api.telegram.org/bot<redacted>/sendMessage": read: connection reset by peer`,
		},
		{
			name: "no token",
			err:  &url.Error{Op: "Get", URL: "https://slack.com/api/users.info", Err: reset},
			want: `Get "https://slack.com/api/users.info": read: connection reset by peer`,
		},
		{
			name: "plain error",
			err:  reset,
			want: "read: connection reset by peer",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RedactError(tc.err)
			if got.Error() != tc.want {
				t.Fatalf("RedactError() = %q, want %q", got.Error(), tc.want)
			}
			if !errors.Is(got, reset) {
				t.Fatalf("RedactError() lost the cause: %v", got)
			}
		})
	}
	if RedactError(nil) != nil {
		t.Fatal("RedactError(nil) != nil")
	}
}

func TestDoRedactsTransportError(t *testing.T) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://127.0.0.1:1/bot"+testToken+"/getMe", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Do(&http.Client{}, req)
	if err == nil {
		t.Fatal("Do() succeeded, want a connection error")
	}
	if strings.Contains(err.Error(), testToken) {
		t.Fatalf("Do() error contains the token: %v", err)
	}
}
