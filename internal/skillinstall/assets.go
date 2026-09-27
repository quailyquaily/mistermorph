package skillinstall

import (
	"bytes"
	"path"
	"strings"
)

// Skills may ship images and fonts beside their text files. Each is accepted only when its bytes
// start with its type's signature, so an executable or archive renamed .png is still refused. They
// are not capped one by one (text files are, at MaxFileBytes); the whole-skill limit covers them.
type assetType struct {
	kind  string // "image" or "font"
	match func([]byte) bool
}

var assetTypes = map[string]assetType{
	".png":  {kind: "image", match: hasPrefix("\x89PNG\r\n\x1a\n")},
	".jpg":  {kind: "image", match: hasPrefix("\xff\xd8\xff")},
	".jpeg": {kind: "image", match: hasPrefix("\xff\xd8\xff")},
	".gif":  {kind: "image", match: hasPrefix("GIF87a", "GIF89a")},
	".webp": {kind: "image", match: func(b []byte) bool { return len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP" }},
	".avif": {kind: "image", match: func(b []byte) bool {
		return len(b) >= 12 && string(b[4:8]) == "ftyp" && (string(b[8:12]) == "avif" || string(b[8:12]) == "avis")
	}},
	".ico":   {kind: "image", match: hasPrefix("\x00\x00\x01\x00")},
	".woff":  {kind: "font", match: hasPrefix("wOFF")},
	".woff2": {kind: "font", match: hasPrefix("wOF2")},
	".ttf":   {kind: "font", match: hasPrefix("\x00\x01\x00\x00", "true")},
	".otf":   {kind: "font", match: hasPrefix("OTTO")},
}

func hasPrefix(signatures ...string) func([]byte) bool {
	return func(b []byte) bool {
		for _, sig := range signatures {
			if bytes.HasPrefix(b, []byte(sig)) {
				return true
			}
		}
		return false
	}
}

// assetTypeFor reports whether a skill file is an image or font by its extension.
func assetTypeFor(rel string) (assetType, bool) {
	t, ok := assetTypes[strings.ToLower(path.Ext(rel))]
	return t, ok
}
