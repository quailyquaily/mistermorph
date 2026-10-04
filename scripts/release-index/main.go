// Command release-index writes the per-release release.json and merges the
// release into its channel's index.json. The website reads both from R2:
//
//	<channel>/releases/index.json        every release, without notes
//	<channel>/releases/<tag>/release.json one release, with notes and files
//
// Notes live only in each release.json, so the index stays small as releases
// accumulate.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/updatecheck"
)

type githubRelease struct {
	TagName     string `json:"tag_name"`
	Body        string `json:"body"`
	Prerelease  bool   `json:"prerelease"`
	PublishedAt string `json:"published_at"`
}

type r2ObjectList struct {
	Contents []r2Object `json:"Contents"`
}

type r2Object struct {
	Key  string `json:"Key"`
	Size int64  `json:"Size"`
}

type (
	releaseFile   = updatecheck.ReleaseFile
	releaseDetail = updatecheck.Release
	indexEntry    = updatecheck.ReleaseIndexEntry
	releaseIndex  = updatecheck.ReleaseIndex
)

// generatedFiles are written next to the release files but are not downloads.
var generatedFiles = map[string]bool{
	"release.json": true,
	"update.json":  true,
}

func main() {
	if err := run(os.Args[1:], time.Now()); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "release index: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, now time.Time) error {
	var channel, releaseJSONPath, objectListPath, baseURL, existingIndexPath, releaseOutput, indexOutput string

	fs := flag.NewFlagSet("release-index", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.StringVar(&channel, "channel", "", "Release channel (community or pro)")
	fs.StringVar(&releaseJSONPath, "release-json", "", "Path to GitHub release JSON metadata")
	fs.StringVar(&objectListPath, "r2-object-list", "", "Path to an aws s3api list-objects-v2 JSON response for the release prefix")
	fs.StringVar(&baseURL, "download-base-url", "", "Public R2 base URL")
	fs.StringVar(&existingIndexPath, "existing-index", "", "Path to the current index.json; a missing file starts a new index")
	fs.StringVar(&releaseOutput, "release-output", "", "Output path for release.json")
	fs.StringVar(&indexOutput, "index-output", "", "Output path for index.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	for name, value := range map[string]string{
		"-channel":           channel,
		"-release-json":      releaseJSONPath,
		"-r2-object-list":    objectListPath,
		"-download-base-url": baseURL,
		"-release-output":    releaseOutput,
		"-index-output":      indexOutput,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("missing %s", name)
		}
	}
	if strings.TrimSpace(channel) != channel || !isKnownChannel(channel) {
		return fmt.Errorf("unknown channel %q", channel)
	}

	var release githubRelease
	if err := readJSON(releaseJSONPath, &release); err != nil {
		return fmt.Errorf("read release metadata: %w", err)
	}
	var objects r2ObjectList
	if err := readJSON(objectListPath, &objects); err != nil {
		return fmt.Errorf("read R2 object list: %w", err)
	}
	index := releaseIndex{Channel: channel}
	if strings.TrimSpace(existingIndexPath) != "" {
		if err := readJSON(existingIndexPath, &index); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("read existing index: %w", err)
		}
	}
	if index.Channel != channel {
		return fmt.Errorf("existing index is for channel %q, not %q", index.Channel, channel)
	}

	detail, err := buildReleaseDetail(channel, release, objects, baseURL)
	if err != nil {
		return err
	}
	index = mergeIndex(index, detail, now)

	if err := writeJSON(releaseOutput, detail); err != nil {
		return err
	}
	return writeJSON(indexOutput, index)
}

func isKnownChannel(channel string) bool {
	for _, known := range updatecheck.Channels() {
		if channel == known {
			return true
		}
	}
	return false
}

func buildReleaseDetail(channel string, release githubRelease, objects r2ObjectList, baseURL string) (releaseDetail, error) {
	tag := strings.TrimSpace(release.TagName)
	if tag == "" {
		return releaseDetail{}, errors.New("release metadata missing tag_name")
	}
	publishedAt, err := time.Parse(time.RFC3339, strings.TrimSpace(release.PublishedAt))
	if err != nil {
		return releaseDetail{}, fmt.Errorf("parse published_at: %w", err)
	}

	prefix := releasePrefix(channel, tag)
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	var files []releaseFile
	for _, object := range objects.Contents {
		key := strings.TrimLeft(strings.TrimSpace(object.Key), "/")
		name, ok := strings.CutPrefix(key, prefix+"/")
		if !ok || name == "" || strings.Contains(name, "/") || generatedFiles[name] {
			continue
		}
		files = append(files, releaseFile{
			Name: name,
			URL:  baseURL + "/" + path.Join(prefix, name),
			Size: object.Size,
		})
	}
	if len(files) == 0 {
		return releaseDetail{}, fmt.Errorf("no release files under %s/", prefix)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })

	return releaseDetail{
		Channel:     channel,
		Tag:         tag,
		Version:     strings.TrimPrefix(tag, "v"),
		Prerelease:  release.Prerelease || strings.Contains(tag, "-"),
		PublishedAt: publishedAt.UTC().Format(time.RFC3339),
		Notes:       release.Body,
		Files:       files,
	}, nil
}

func releasePrefix(channel string, tag string) string {
	return channel + "/releases/" + tag
}

// mergeIndex adds or replaces the release and keeps the newest version first.
func mergeIndex(index releaseIndex, detail releaseDetail, now time.Time) releaseIndex {
	entry := indexEntry{
		Tag:         detail.Tag,
		Version:     detail.Version,
		Prerelease:  detail.Prerelease,
		PublishedAt: detail.PublishedAt,
	}
	releases := make([]indexEntry, 0, len(index.Releases)+1)
	for _, existing := range index.Releases {
		if existing.Tag != entry.Tag {
			releases = append(releases, existing)
		}
	}
	releases = append(releases, entry)
	sort.SliceStable(releases, func(i, j int) bool {
		if cmp, ok := updatecheck.CompareVersions(releases[i].Version, releases[j].Version); ok && cmp != 0 {
			return cmp > 0
		}
		return releases[i].PublishedAt > releases[j].PublishedAt
	})

	index.Releases = releases
	index.UpdatedAt = now.UTC().Format(time.RFC3339)
	index.Latest = ""
	for _, release := range releases {
		if !release.Prerelease {
			index.Latest = release.Tag
			break
		}
	}
	return index
}

func readJSON(filePath string, out any) error {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

func writeJSON(filePath string, value any) error {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal %s: %w", filePath, err)
	}
	payload = append(payload, '\n')
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}
	if err := os.WriteFile(filePath, payload, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", filePath, err)
	}
	return nil
}
