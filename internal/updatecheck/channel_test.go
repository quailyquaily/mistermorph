package updatecheck

import "testing"

func TestResolveManifestURL(t *testing.T) {
	got, err := ResolveManifestURL(Options{Channel: ChannelPro})
	if err != nil || got != "https://downloads.mistermorph.com/pro/latest/update.json" {
		t.Fatalf("ResolveManifestURL(pro) = %q, %v", got, err)
	}
	got, err = ResolveManifestURL(Options{Channel: ChannelPro, ManifestURL: " https://example.test/u.json "})
	if err != nil || got != "https://example.test/u.json" {
		t.Fatalf("ResolveManifestURL(override) = %q, %v", got, err)
	}
	if _, err := ResolveManifestURL(Options{Channel: "nightly"}); err == nil {
		t.Fatal("ResolveManifestURL(nightly) error = nil")
	}
}
