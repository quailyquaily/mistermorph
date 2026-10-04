package updatecheck

import (
	"fmt"
	"strings"
)

// Release channels published to the downloads bucket. Each channel keeps its
// files under its own top-level prefix, e.g. community/latest/update.json.
const (
	ChannelCommunity = "community"
	ChannelPro       = "pro"
)

const DefaultBaseURL = "https://downloads.mistermorph.com"

// Channels lists every release channel in display order.
func Channels() []string {
	return []string{ChannelCommunity, ChannelPro}
}

// BuildChannel is the channel this binary was built for. It is set by the
// build tags in channel_community.go and channel_pro.go.
func BuildChannel() string {
	return buildChannel
}

// NormalizeChannel lowercases and trims a channel name. An empty value means
// the build channel.
func NormalizeChannel(channel string) (string, error) {
	channel = strings.ToLower(strings.TrimSpace(channel))
	if channel == "" {
		return buildChannel, nil
	}
	for _, known := range Channels() {
		if channel == known {
			return channel, nil
		}
	}
	return "", fmt.Errorf("unknown release channel %q (want one of %s)", channel, strings.Join(Channels(), ", "))
}

// ManifestURL returns the latest update manifest URL for a channel.
func ManifestURL(baseURL string, channel string) string {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return baseURL + "/" + channel + "/latest/update.json"
}
