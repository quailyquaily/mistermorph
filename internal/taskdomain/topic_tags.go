package taskdomain

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Topic tag limits: a tag is a short label, and a topic carries a few. The pinned tag does not
// count toward MaxTopicTags.
const (
	MaxTopicTags      = 5
	MaxTopicTagLength = 32
)

// PinnedTopicTag is the reserved tag that pins a topic to the top of its list. It is stored in
// this spelling whatever case it was given in.
const PinnedTopicTag = "pinned"

// NormalizeTopicTags trims each tag and folds its inner whitespace to single spaces, drops empty
// ones, and keeps the first spelling of tags that differ only in case, in the given order. The
// pinned tag is stored as PinnedTopicTag.
func NormalizeTopicTags(raw []string) ([]string, error) {
	out := make([]string, 0, len(raw))
	seen := make(map[string]bool, len(raw))
	for _, item := range raw {
		tag := strings.Join(strings.Fields(item), " ")
		if tag == "" {
			continue
		}
		if utf8.RuneCountInString(tag) > MaxTopicTagLength {
			return nil, fmt.Errorf("tag %q is longer than %d characters", tag, MaxTopicTagLength)
		}
		key := strings.ToLower(tag)
		if key == PinnedTopicTag {
			tag = PinnedTopicTag
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, tag)
	}
	ordinary := len(out)
	if seen[PinnedTopicTag] {
		ordinary--
	}
	if ordinary > MaxTopicTags {
		return nil, fmt.Errorf("a topic can have at most %d tags", MaxTopicTags)
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}
