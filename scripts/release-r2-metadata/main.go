package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var desktopAssetNamePattern = regexp.MustCompile(`^MrMorph-(linux|darwin|windows)-([a-z0-9]+)\.(tar\.gz|AppImage|dmg|zip)$`)

type releaseMetadata struct {
	TagName     string         `json:"tag_name"`
	Body        string         `json:"body"`
	PublishedAt string         `json:"published_at"`
	Assets      []releaseAsset `json:"assets"`
}

type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type r2ObjectList struct {
	Contents []r2Object `json:"Contents"`
}

type r2Object struct {
	Key  string `json:"Key"`
	Size int64  `json:"Size"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "build R2 release metadata: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	var releaseJSONPath string
	var artifactsDir string
	var r2ObjectListPath string
	var downloadBaseURL string
	var downloadPrefix string
	var outputPath string

	fs := flag.NewFlagSet("release-r2-metadata", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.StringVar(&releaseJSONPath, "release-json", "", "Path to GitHub release JSON metadata")
	fs.StringVar(&artifactsDir, "artifacts-dir", "", "Directory containing release artifacts")
	fs.StringVar(&r2ObjectListPath, "r2-object-list", "", "Path to an aws s3api list-objects-v2 JSON response")
	fs.StringVar(&downloadBaseURL, "download-base-url", "", "Public R2 base URL")
	fs.StringVar(&downloadPrefix, "download-prefix", "", "R2 object prefix for versioned release files")
	fs.StringVar(&outputPath, "output", "", "Output path for rewritten release JSON metadata")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(releaseJSONPath) == "" {
		return errors.New("missing -release-json")
	}
	if strings.TrimSpace(artifactsDir) == "" && strings.TrimSpace(r2ObjectListPath) == "" {
		return errors.New("missing -artifacts-dir or -r2-object-list")
	}
	if strings.TrimSpace(artifactsDir) != "" && strings.TrimSpace(r2ObjectListPath) != "" {
		return errors.New("-artifacts-dir and -r2-object-list are mutually exclusive")
	}
	if strings.TrimSpace(downloadBaseURL) == "" {
		return errors.New("missing -download-base-url")
	}
	if strings.TrimSpace(outputPath) == "" {
		return errors.New("missing -output")
	}

	release, err := loadReleaseMetadata(releaseJSONPath)
	if err != nil {
		return err
	}
	assets, err := buildAssets(artifactsDir, r2ObjectListPath, downloadBaseURL, downloadPrefix)
	if err != nil {
		return err
	}
	if len(assets) == 0 {
		return errors.New("no desktop release artifacts found")
	}
	release.Assets = assets

	payload, err := marshalReleaseMetadata(release)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}
	if err := os.WriteFile(outputPath, payload, 0o644); err != nil {
		return fmt.Errorf("write release metadata: %w", err)
	}
	return nil
}

func buildAssets(artifactsDir string, r2ObjectListPath string, baseURL string, prefix string) ([]releaseAsset, error) {
	if strings.TrimSpace(r2ObjectListPath) != "" {
		objects, err := loadR2ObjectList(r2ObjectListPath)
		if err != nil {
			return nil, err
		}
		return buildR2AssetsFromObjectList(objects, baseURL, prefix)
	}
	return buildR2Assets(artifactsDir, baseURL, prefix)
}

func loadReleaseMetadata(path string) (releaseMetadata, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return releaseMetadata{}, fmt.Errorf("read release metadata: %w", err)
	}

	var out releaseMetadata
	if err := json.Unmarshal(raw, &out); err != nil {
		return releaseMetadata{}, fmt.Errorf("decode release metadata: %w", err)
	}
	return out, nil
}

func loadR2ObjectList(filePath string) (r2ObjectList, error) {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return r2ObjectList{}, fmt.Errorf("read R2 object list: %w", err)
	}

	var out r2ObjectList
	if err := json.Unmarshal(raw, &out); err != nil {
		return r2ObjectList{}, fmt.Errorf("decode R2 object list: %w", err)
	}
	return out, nil
}

func buildR2Assets(root string, baseURL string, prefix string) ([]releaseAsset, error) {
	var assets []releaseAsset
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}

		name := d.Name()
		if !desktopAssetNamePattern.MatchString(name) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return fmt.Errorf("read artifact info %s: %w", path, err)
		}
		if info.Size() <= 0 {
			return fmt.Errorf("release artifact %s has invalid size %d", name, info.Size())
		}

		assets = append(assets, releaseAsset{
			Name:               name,
			BrowserDownloadURL: buildDownloadURL(baseURL, prefix, name),
			Size:               info.Size(),
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("load release artifacts: %w", err)
	}

	sort.Slice(assets, func(i, j int) bool {
		return assets[i].Name < assets[j].Name
	})
	return assets, nil
}

func buildR2AssetsFromObjectList(objects r2ObjectList, baseURL string, prefix string) ([]releaseAsset, error) {
	var assets []releaseAsset
	for _, object := range objects.Contents {
		name, ok := objectNameForPrefix(object.Key, prefix)
		if !ok || !desktopAssetNamePattern.MatchString(name) {
			continue
		}
		if object.Size <= 0 {
			return nil, fmt.Errorf("release artifact %s has invalid size %d", name, object.Size)
		}

		assets = append(assets, releaseAsset{
			Name:               name,
			BrowserDownloadURL: buildDownloadURL(baseURL, prefix, name),
			Size:               object.Size,
		})
	}

	sort.Slice(assets, func(i, j int) bool {
		return assets[i].Name < assets[j].Name
	})
	return assets, nil
}

func objectNameForPrefix(key string, prefix string) (string, bool) {
	key = strings.TrimLeft(strings.TrimSpace(key), "/")
	prefix = strings.Trim(strings.TrimSpace(prefix), "/")
	if key == "" {
		return "", false
	}
	if prefix != "" {
		prefix += "/"
		if !strings.HasPrefix(key, prefix) {
			return "", false
		}
		key = strings.TrimPrefix(key, prefix)
	}

	name := path.Base(key)
	if name == "." || name == "/" || name == "" {
		return "", false
	}
	return name, true
}

func buildDownloadURL(baseURL string, prefix string, name string) string {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	prefix = strings.Trim(strings.TrimSpace(prefix), "/")
	name = strings.TrimLeft(strings.TrimSpace(name), "/")
	if prefix == "" {
		return baseURL + "/" + name
	}
	return baseURL + "/" + prefix + "/" + name
}

func marshalReleaseMetadata(release releaseMetadata) ([]byte, error) {
	payload, err := json.MarshalIndent(release, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal release metadata: %w", err)
	}
	payload = append(payload, '\n')

	return payload, nil
}
