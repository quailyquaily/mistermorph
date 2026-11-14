package updatecheck

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

// The download a person gets from the Console's Updates card is for the machine
// the Console runs on (a browser, the phone app), which is not necessarily the
// machine the server runs on. A DownloadTarget names that machine, and
// SelectDownload finds its file in a release without ever falling back to
// another platform's file.

// Download statuses.
const (
	// DownloadAvailable: one file fits the target (Download.URL).
	DownloadAvailable = "available"
	// DownloadChoose: the target's OS is known but not its architecture, so
	// the person picks one of Download.Options.
	DownloadChoose = "choose"
	// DownloadUnavailable: nothing to offer (Download.Reason says why).
	DownloadUnavailable = "unavailable"
)

// Reasons a download is unavailable.
const (
	// DownloadUnknownPlatform: the client could not tell which OS it runs on.
	DownloadUnknownPlatform = "unknown_platform"
	// DownloadNotPublished: the release has no file for the target.
	DownloadNotPublished = "not_published"
	// DownloadUnreachable: the release's file list could not be read.
	DownloadUnreachable = "unreachable"
)

// AndroidAssetName is the phone app's file in a release (release.yml's
// android-app job). It is a single APK for phones' arm64-v8a and armeabi-v7a.
const AndroidAssetName = "MrMorph-android.apk"

// androidArches are the GOARCH names of the ABIs in AndroidAssetName.
var androidArches = map[string]bool{"arm64": true, "arm": true}

// DownloadTarget is the machine a download is for, as the client reports it.
type DownloadTarget struct {
	// OS is a GOOS name ("linux", "darwin", "windows", "android", "ios");
	// "macos" is taken as "darwin". Empty or anything else is unknown.
	OS string
	// Arch is a GOARCH name, or empty when the client cannot tell.
	Arch string
}

// Download is the file for a DownloadTarget in a release.
type Download struct {
	Status string `json:"status"`
	// Reason is set when Status is DownloadUnavailable.
	Reason string `json:"reason,omitempty"`
	OS     string `json:"os"`
	Arch   string `json:"arch,omitempty"`
	DownloadFile
	// Options are the files to pick from when Status is DownloadChoose.
	Options []DownloadFile `json:"options,omitempty"`
}

// DownloadFile is one downloadable file of a release.
type DownloadFile struct {
	// Platform is the file's update manifest key ("linux-amd64",
	// "macos-arm64") or "android".
	Platform string `json:"platform,omitempty"`
	OS       string `json:"os,omitempty"`
	Arch     string `json:"arch,omitempty"`
	Name     string `json:"name,omitempty"`
	URL      string `json:"url,omitempty"`
	Size     int64  `json:"size,omitempty"`
	Checksum string `json:"checksum,omitempty"`
}

// NormalizeDownloadOS returns the GOOS name of a client OS, or "" when it is
// not one Mister Morph names.
func NormalizeDownloadOS(os string) string {
	switch os = strings.ToLower(strings.TrimSpace(os)); os {
	case "macos", "darwin":
		return "darwin"
	case "linux", "windows", "android", "ios":
		return os
	}
	return ""
}

// ParsePlatformKey splits an update manifest key ("macos-arm64") into its
// GOOS and GOARCH; it is PlatformKey's inverse.
func ParsePlatformKey(key string) (goos string, goarch string, ok bool) {
	goos, goarch, ok = strings.Cut(strings.TrimSpace(key), "-")
	if !ok || goos == "" || goarch == "" {
		return "", "", false
	}
	if goos == "macos" {
		goos = "darwin"
	}
	return goos, goarch, true
}

// SelectDownload finds target's file in the release whose update manifest is
// manifest. Desktop systems take the manifest's files; Android takes
// AndroidAssetName from the release's file list (release.json in channel at
// baseURL). A file for another OS or architecture is never offered.
func SelectDownload(ctx context.Context, manifest Manifest, target DownloadTarget, baseURL string, channel string, userAgent string) Download {
	goos := NormalizeDownloadOS(target.OS)
	goarch := strings.ToLower(strings.TrimSpace(target.Arch))
	out := Download{OS: goos, Arch: goarch}
	unavailable := func(reason string) Download {
		out.Status = DownloadUnavailable
		out.Reason = reason
		return out
	}
	switch goos {
	case "":
		return unavailable(DownloadUnknownPlatform)
	case "ios":
		return unavailable(DownloadNotPublished)
	case "android":
		if goarch != "" && !androidArches[goarch] {
			return unavailable(DownloadNotPublished)
		}
		file, err := androidDownload(ctx, manifest, baseURL, channel, userAgent)
		if errors.Is(err, errNoAndroidAsset) {
			return unavailable(DownloadNotPublished)
		}
		if err != nil {
			return unavailable(DownloadUnreachable)
		}
		out.Status = DownloadAvailable
		out.DownloadFile = file
		return out
	}

	var options []DownloadFile
	for key, platform := range manifest.Platforms {
		keyOS, keyArch, ok := ParsePlatformKey(key)
		if !ok || keyOS != goos || strings.TrimSpace(platform.URL) == "" {
			continue
		}
		if goarch != "" && keyArch != goarch {
			continue
		}
		options = append(options, DownloadFile{
			Platform: key,
			OS:       keyOS,
			Arch:     keyArch,
			Name:     AssetName(platform.URL, manifest.Version, key),
			URL:      strings.TrimSpace(platform.URL),
			Size:     platform.Size,
			Checksum: strings.TrimSpace(platform.Checksum),
		})
	}
	if len(options) == 0 {
		return unavailable(DownloadNotPublished)
	}
	if goarch != "" {
		out.Status = DownloadAvailable
		out.DownloadFile = options[0]
		return out
	}
	sort.Slice(options, func(i, j int) bool { return options[i].Platform < options[j].Platform })
	out.Status = DownloadChoose
	out.Options = options
	return out
}

var errNoAndroidAsset = errors.New("release has no Android app")

// androidDownload finds the APK in the manifest version's release, with the
// checksum from its .sha256 file when that can be read.
func androidDownload(ctx context.Context, manifest Manifest, baseURL string, channel string, userAgent string) (DownloadFile, error) {
	version := NormalizeVersion(manifest.Version)
	if version == "" {
		return DownloadFile{}, errNoAndroidAsset
	}
	release, err := FetchRelease(ctx, baseURL, channel, version, userAgent)
	if err != nil {
		var status httpStatusError
		if errors.As(err, &status) && status.code == http.StatusNotFound {
			return DownloadFile{}, errNoAndroidAsset
		}
		return DownloadFile{}, err
	}
	var apk, sum *ReleaseFile
	for i := range release.Files {
		switch strings.TrimSpace(release.Files[i].Name) {
		case AndroidAssetName:
			apk = &release.Files[i]
		case AndroidAssetName + ".sha256":
			sum = &release.Files[i]
		}
	}
	if apk == nil || strings.TrimSpace(apk.URL) == "" {
		return DownloadFile{}, errNoAndroidAsset
	}
	file := DownloadFile{
		Platform: "android",
		OS:       "android",
		Name:     AndroidAssetName,
		URL:      strings.TrimSpace(apk.URL),
		Size:     apk.Size,
	}
	if sum != nil {
		// The checksum is shown for checking by hand; without it the file is still the right one.
		if checksum, err := fetchChecksumFile(ctx, sum.URL, userAgent); err == nil {
			file.Checksum = checksum
		}
	}
	return file, nil
}

// fetchChecksumFile reads a `shasum -a 256` line and returns "sha256:<hex>".
func fetchChecksumFile(ctx context.Context, rawURL string, userAgent string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSpace(rawURL), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", normalizedUserAgent(userAgent))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", httpStatusError{code: resp.StatusCode}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", err
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return "", fmt.Errorf("empty checksum file")
	}
	if _, err := ParseSHA256Checksum(fields[0]); err != nil {
		return "", err
	}
	return "sha256:" + strings.ToLower(fields[0]), nil
}
