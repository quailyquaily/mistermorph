//go:build wailsdesktop

package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestNormalizeExternalBrowserURL(t *testing.T) {
	cases := []struct {
		name    string
		rawURL  string
		want    string
		wantErr bool
	}{
		{
			name:   "https",
			rawURL: " https://example.com/path?q=a~b(1)! ",
			want:   "https://example.com/path?q=a~b(1)!",
		},
		{
			name:   "http",
			rawURL: "http://example.com",
			want:   "http://example.com",
		},
		{
			name:    "missing host",
			rawURL:  "https:///path",
			wantErr: true,
		},
		{
			name:    "unsupported scheme",
			rawURL:  "file:///tmp/example",
			wantErr: true,
		},
		{
			name:    "control character",
			rawURL:  "https://example.com/\npath",
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeExternalBrowserURL(tc.rawURL)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("normalizeExternalBrowserURL() error = nil, want error")
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeExternalBrowserURL() error = %v", err)
			}
			if got != tc.want {
				t.Fatalf("normalizeExternalBrowserURL() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestReportFrontendReadyWritesOnce(t *testing.T) {
	var out bytes.Buffer
	app := NewApp("http://127.0.0.1:19080/", "", time.Now().Add(-time.Second), &out)

	app.ReportFrontendReady()
	app.ReportFrontendReady()

	got := out.String()
	if count := strings.Count(got, "desktop_startup_frontend_ready"); count != 1 {
		t.Fatalf("frontend ready metric count = %d, want 1 in %q", count, got)
	}
	for _, want := range []string{
		"duration_ms=",
		"desktop_go_alloc_bytes=",
		"desktop_go_sys_bytes=",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("frontend ready metric missing %q in %q", want, got)
		}
	}
}
