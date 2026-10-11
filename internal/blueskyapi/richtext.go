package blueskyapi

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// Facet marks a byte range of a post or message as a link or a mention.
type Facet struct {
	Index    ByteSlice        `json:"index"`
	Features []map[string]any `json:"features"`
}

// ByteSlice is a range of UTF-8 bytes, end exclusive.
type ByteSlice struct {
	ByteStart int `json:"byteStart"`
	ByteEnd   int `json:"byteEnd"`
}

var (
	linkPattern    = regexp.MustCompile(`https?://[^\s<>()\[\]"']+`)
	mentionPattern = regexp.MustCompile(`(?:^|[\s(])(@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+))`)
)

// Facets finds the links and mentions in text. A mention whose handle does not resolve stays text.
func (c *Client) Facets(ctx context.Context, text string) []Facet {
	var facets []Facet
	for _, loc := range linkPattern.FindAllStringIndex(text, -1) {
		start, end := loc[0], loc[1]
		// A sentence's closing punctuation is not part of the link.
		for end > start && strings.ContainsRune(".,;:!?", rune(text[end-1])) {
			end--
		}
		facets = append(facets, Facet{
			Index:    ByteSlice{ByteStart: start, ByteEnd: end},
			Features: []map[string]any{{"$type": "app.bsky.richtext.facet#link", "uri": text[start:end]}},
		})
	}
	for _, loc := range mentionPattern.FindAllStringSubmatchIndex(text, -1) {
		start, end := loc[2], loc[3]
		handle := text[loc[4]:loc[5]]
		did, err := c.ResolveHandle(ctx, handle)
		if err != nil || did == "" {
			continue
		}
		facets = append(facets, Facet{
			Index:    ByteSlice{ByteStart: start, ByteEnd: end},
			Features: []map[string]any{{"$type": "app.bsky.richtext.facet#mention", "did": did}},
		})
	}
	return facets
}

// ResolveHandle returns the DID of a handle.
func (c *Client) ResolveHandle(ctx context.Context, handle string) (string, error) {
	var out struct {
		DID string `json:"did"`
	}
	err := c.xrpc(ctx, http.MethodGet, "com.atproto.identity.resolveHandle", url.Values{"handle": {strings.TrimPrefix(handle, "@")}}, nil, &out, "")
	return out.DID, err
}
