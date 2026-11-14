package updatecheck

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/testhttp"
)

const (
	apkSum   = "1111111111111111111111111111111111111111111111111111111111111111"
	linuxSum = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
	armSum   = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
	macSum   = "sha256:4444444444444444444444444444444444444444444444444444444444444444"
	winSum   = "sha256:5555555555555555555555555555555555555555555555555555555555555555"
)

// releaseFeed answers <channel>/releases/<tag>/release.json for the releases
// in files (tag → file names), with each file's URL below the release and the
// APK's .sha256 holding apkSum. Requests are recorded.
type releaseFeed struct {
	files    map[string][]string
	manifest *Manifest
	fail     bool
	requests []string
}

func (f *releaseFeed) serve(t *testing.T) string {
	t.Helper()
	var base string
	base = testhttp.WithDefaultTransport(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests = append(f.requests, r.URL.Path)
		if f.fail {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		if f.manifest != nil && strings.HasSuffix(r.URL.Path, "/latest/update.json") {
			_ = json.NewEncoder(w).Encode(f.manifest)
			return
		}
		if strings.HasSuffix(r.URL.Path, ".apk.sha256") {
			_, _ = fmt.Fprintf(w, "%s  %s\n", apkSum, AndroidAssetName)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) != 4 || parts[1] != "releases" || parts[3] != "release.json" {
			http.NotFound(w, r)
			return
		}
		names, ok := f.files[parts[2]]
		if !ok {
			http.NotFound(w, r)
			return
		}
		release := Release{Channel: parts[0], Tag: parts[2], Version: strings.TrimPrefix(parts[2], "v")}
		for _, name := range names {
			release.Files = append(release.Files, ReleaseFile{Name: name, URL: base + "/" + parts[0] + "/releases/" + parts[2] + "/" + name, Size: 42})
		}
		_ = json.NewEncoder(w).Encode(release)
	}))
	return base
}

// desktopManifest is a release's update.json as release-update-manifest
// writes it for release.yml's desktop builds and the Windows signing run.
func desktopManifest() Manifest {
	return Manifest{
		Version: "1.4.0",
		Platforms: map[string]Platform{
			"linux-amd64":   {URL: "https://dl.example/v1.4.0/MrMorph-linux-amd64.tar.gz", Size: 10, Checksum: linuxSum},
			"linux-arm64":   {URL: "https://dl.example/v1.4.0/MrMorph-linux-arm64.tar.gz", Size: 11, Checksum: armSum},
			"macos-arm64":   {URL: "https://dl.example/v1.4.0/MrMorph-darwin-arm64.tar.gz", Size: 12, Checksum: macSum},
			"windows-amd64": {URL: "https://dl.example/v1.4.0/MrMorph-windows-amd64.zip", Size: 13, Checksum: winSum},
		},
	}
}

func TestSelectDownload(t *testing.T) {
	feed := &releaseFeed{files: map[string][]string{
		"v1.4.0": {"MrMorph-android.apk", "MrMorph-android.apk.sha256", "MrMorph-linux-amd64.AppImage", "MrMorph-linux-amd64.tar.gz"},
	}}
	base := feed.serve(t)
	apkURL := base + "/community/releases/v1.4.0/MrMorph-android.apk"
	linux := DownloadFile{Platform: "linux-amd64", OS: "linux", Arch: "amd64", Name: "MrMorph-linux-amd64.tar.gz", URL: "https://dl.example/v1.4.0/MrMorph-linux-amd64.tar.gz", Size: 10, Checksum: linuxSum}
	linuxARM := DownloadFile{Platform: "linux-arm64", OS: "linux", Arch: "arm64", Name: "MrMorph-linux-arm64.tar.gz", URL: "https://dl.example/v1.4.0/MrMorph-linux-arm64.tar.gz", Size: 11, Checksum: armSum}
	mac := DownloadFile{Platform: "macos-arm64", OS: "darwin", Arch: "arm64", Name: "MrMorph-darwin-arm64.tar.gz", URL: "https://dl.example/v1.4.0/MrMorph-darwin-arm64.tar.gz", Size: 12, Checksum: macSum}
	windows := DownloadFile{Platform: "windows-amd64", OS: "windows", Arch: "amd64", Name: "MrMorph-windows-amd64.zip", URL: "https://dl.example/v1.4.0/MrMorph-windows-amd64.zip", Size: 13, Checksum: winSum}
	apk := DownloadFile{Platform: "android", OS: "android", Name: AndroidAssetName, URL: apkURL, Size: 42, Checksum: "sha256:" + apkSum}

	cases := []struct {
		name   string
		target DownloadTarget
		want   Download
	}{
		{"android takes the APK, not a desktop file", DownloadTarget{OS: "android"}, Download{Status: DownloadAvailable, OS: "android", DownloadFile: apk}},
		{"android on a phone ABI", DownloadTarget{OS: "Android", Arch: "arm64"}, Download{Status: DownloadAvailable, OS: "android", Arch: "arm64", DownloadFile: apk}},
		{"android on an ABI the APK lacks", DownloadTarget{OS: "android", Arch: "amd64"}, Download{Status: DownloadUnavailable, Reason: DownloadNotPublished, OS: "android", Arch: "amd64"}},
		{"linux amd64", DownloadTarget{OS: "linux", Arch: "amd64"}, Download{Status: DownloadAvailable, OS: "linux", Arch: "amd64", DownloadFile: linux}},
		{"linux arm64 keeps its architecture", DownloadTarget{OS: "linux", Arch: "arm64"}, Download{Status: DownloadAvailable, OS: "linux", Arch: "arm64", DownloadFile: linuxARM}},
		{"linux without an architecture asks", DownloadTarget{OS: "linux"}, Download{Status: DownloadChoose, OS: "linux", Options: []DownloadFile{linux, linuxARM}}},
		{"linux on an unpublished architecture", DownloadTarget{OS: "linux", Arch: "riscv64"}, Download{Status: DownloadUnavailable, Reason: DownloadNotPublished, OS: "linux", Arch: "riscv64"}},
		{"macos by name", DownloadTarget{OS: "macos", Arch: "arm64"}, Download{Status: DownloadAvailable, OS: "darwin", Arch: "arm64", DownloadFile: mac}},
		{"an Intel Mac gets no Apple silicon build", DownloadTarget{OS: "darwin", Arch: "amd64"}, Download{Status: DownloadUnavailable, Reason: DownloadNotPublished, OS: "darwin", Arch: "amd64"}},
		{"a Mac of unknown architecture asks", DownloadTarget{OS: "darwin"}, Download{Status: DownloadChoose, OS: "darwin", Options: []DownloadFile{mac}}},
		{"windows amd64", DownloadTarget{OS: "windows", Arch: "amd64"}, Download{Status: DownloadAvailable, OS: "windows", Arch: "amd64", DownloadFile: windows}},
		{"windows arm64 is not published", DownloadTarget{OS: "windows", Arch: "arm64"}, Download{Status: DownloadUnavailable, Reason: DownloadNotPublished, OS: "windows", Arch: "arm64"}},
		{"ios has no app", DownloadTarget{OS: "ios"}, Download{Status: DownloadUnavailable, Reason: DownloadNotPublished, OS: "ios"}},
		{"an unknown OS", DownloadTarget{}, Download{Status: DownloadUnavailable, Reason: DownloadUnknownPlatform}},
		{"an OS Mister Morph does not name", DownloadTarget{OS: "freebsd", Arch: "amd64"}, Download{Status: DownloadUnavailable, Reason: DownloadUnknownPlatform, Arch: "amd64"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SelectDownload(context.Background(), desktopManifest(), tc.target, base, "community", "")
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("SelectDownload(%+v) =\n%#v\nwant\n%#v", tc.target, got, tc.want)
			}
		})
	}
}

func TestSelectDownloadAndroidWithoutTheAPK(t *testing.T) {
	// A release whose Android build failed (or had no keystore) has only desktop files.
	feed := &releaseFeed{files: map[string][]string{"v1.4.0": {"MrMorph-linux-amd64.tar.gz"}}}
	base := feed.serve(t)
	got := SelectDownload(context.Background(), desktopManifest(), DownloadTarget{OS: "android"}, base, "pro", "")
	want := Download{Status: DownloadUnavailable, Reason: DownloadNotPublished, OS: "android"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SelectDownload() = %#v, want %#v", got, want)
	}
	if !reflect.DeepEqual(feed.requests, []string{"/pro/releases/v1.4.0/release.json"}) {
		t.Fatalf("requests = %v, want the pro release of the manifest's version", feed.requests)
	}

	// No release.json for the version at all.
	feed.files = map[string][]string{}
	got = SelectDownload(context.Background(), desktopManifest(), DownloadTarget{OS: "android"}, base, "pro", "")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SelectDownload() without release.json = %#v, want %#v", got, want)
	}

	// The feed is down: unreachable, not "not published".
	feed.fail = true
	got = SelectDownload(context.Background(), desktopManifest(), DownloadTarget{OS: "android"}, base, "pro", "")
	want = Download{Status: DownloadUnavailable, Reason: DownloadUnreachable, OS: "android"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SelectDownload() with the feed down = %#v, want %#v", got, want)
	}
}

func TestCheckDownloadKeepsTheUpdaterPlatform(t *testing.T) {
	manifest := desktopManifest()
	feed := &releaseFeed{files: map[string][]string{"v1.4.0": {"MrMorph-android.apk", "MrMorph-android.apk.sha256"}}, manifest: &manifest}
	base := feed.serve(t)
	manifestURL := base + "/community/latest/update.json"

	// A Linux server checked from an Android phone: the updater's platform
	// stays the server's, the download is the APK.
	result, err := Check(context.Background(), Options{
		Channel: "community", CurrentVersion: "1.3.0", ManifestURL: manifestURL, ReleaseBaseURL: base,
		GOOS: "linux", GOARCH: "amd64", Download: &DownloadTarget{OS: "android"},
	})
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if result.Platform != "linux-amd64" || result.AssetURL != manifest.Platforms["linux-amd64"].URL || result.Checksum != linuxSum {
		t.Fatalf("updater platform = %q %q %q, want the server's linux-amd64 file", result.Platform, result.AssetURL, result.Checksum)
	}
	if result.Download == nil || result.Download.Status != DownloadAvailable || result.Download.Name != AndroidAssetName || result.Download.Checksum != "sha256:"+apkSum {
		t.Fatalf("Download = %#v, want the APK", result.Download)
	}

	// A server on a platform without a build still answers a client's check
	// (no asset of its own), but never with another platform's file.
	result, err = Check(context.Background(), Options{
		Channel: "community", CurrentVersion: "1.3.0", ManifestURL: manifestURL, ReleaseBaseURL: base,
		GOOS: "freebsd", GOARCH: "amd64", Download: &DownloadTarget{OS: "android"},
	})
	if err != nil {
		t.Fatalf("Check() for a freebsd server error = %v", err)
	}
	if result.AssetURL != "" || result.Checksum != "" || !result.UpdateAvailable || result.Download.Status != DownloadAvailable {
		t.Fatalf("result = %#v, want an update without a server asset, and the APK", result)
	}

	// Without a client target, or when downloading for itself, a missing platform is still an error.
	for _, opts := range []Options{
		{Channel: "community", CurrentVersion: "1.3.0", ManifestURL: manifestURL, GOOS: "freebsd", GOARCH: "amd64"},
		{Channel: "community", CurrentVersion: "1.3.0", ManifestURL: manifestURL, GOOS: "freebsd", GOARCH: "amd64", AutoDownload: true, CacheDir: t.TempDir(), Download: &DownloadTarget{OS: "android"}},
	} {
		if _, err := Check(context.Background(), opts); err == nil || !strings.Contains(err.Error(), `no platform "freebsd-amd64"`) {
			t.Fatalf("Check(%+v) error = %v, want no platform", opts, err)
		}
	}

	// Without a client target the answer has no download, as before.
	result, err = Check(context.Background(), Options{Channel: "community", CurrentVersion: "1.3.0", ManifestURL: manifestURL, GOOS: "linux", GOARCH: "amd64"})
	if err != nil || result.Download != nil {
		t.Fatalf("Check() without a target = %#v, %v; want no download", result.Download, err)
	}
}

func TestParsePlatformKey(t *testing.T) {
	for key, want := range map[string][2]string{
		"macos-arm64":   {"darwin", "arm64"},
		"linux-amd64":   {"linux", "amd64"},
		"windows-arm64": {"windows", "arm64"},
	} {
		goos, goarch, ok := ParsePlatformKey(key)
		if !ok || goos != want[0] || goarch != want[1] {
			t.Fatalf("ParsePlatformKey(%q) = %q %q %v", key, goos, goarch, ok)
		}
		if PlatformKey(goos, goarch) != key {
			t.Fatalf("PlatformKey(%q, %q) != %q", goos, goarch, key)
		}
	}
	for _, key := range []string{"", "android", "linux-", "-amd64"} {
		if _, _, ok := ParsePlatformKey(key); ok {
			t.Fatalf("ParsePlatformKey(%q) ok, want not", key)
		}
	}
}
