package updatecheck

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/testhttp"
)

func TestFetchReleaseResolvesLatestAndTags(t *testing.T) {
	serverURL := testhttp.WithDefaultTransport(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/pro/releases/index.json":
			_ = json.NewEncoder(w).Encode(ReleaseIndex{Channel: "pro", Latest: "v1.2.0"})
		case "/pro/releases/v1.2.0/release.json", "/pro/releases/v1.1.0/release.json":
			tag := r.URL.Path[len("/pro/releases/") : len(r.URL.Path)-len("/release.json")]
			_ = json.NewEncoder(w).Encode(Release{Channel: "pro", Tag: tag, Files: []ReleaseFile{{Name: "a.tar.gz"}}})
		default:
			http.NotFound(w, r)
		}
	}))

	for _, tc := range []struct{ tag, want string }{
		{"", "v1.2.0"},
		{"latest", "v1.2.0"},
		{"1.1.0", "v1.1.0"},
		{"v1.1.0", "v1.1.0"},
	} {
		got, err := FetchRelease(context.Background(), serverURL, "pro", tc.tag, "")
		if err != nil {
			t.Fatalf("FetchRelease(%q) error = %v", tc.tag, err)
		}
		if got.Tag != tc.want || len(got.Files) != 1 {
			t.Fatalf("FetchRelease(%q) = %#v, want tag %s", tc.tag, got, tc.want)
		}
	}

	if _, err := FetchRelease(context.Background(), serverURL, "community", "", ""); err == nil {
		t.Fatal("FetchRelease() error = nil, want error for a missing index")
	}
}
