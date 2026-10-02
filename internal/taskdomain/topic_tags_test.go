package taskdomain

import (
	"strings"
	"testing"
)

func TestNormalizeTopicTags(t *testing.T) {
	got, err := NormalizeTopicTags([]string{"  Deep   work ", "deep work", "", "研究", "Ideas"})
	if err != nil || strings.Join(got, "|") != "Deep work|研究|Ideas" {
		t.Fatalf("NormalizeTopicTags = %q, %v", got, err)
	}
	if got, err := NormalizeTopicTags([]string{"Work", " PINNED ", "pinned"}); err != nil || strings.Join(got, "|") != "Work|pinned" {
		t.Fatalf("pinned tag = %q, %v", got, err)
	}
	if _, err := NormalizeTopicTags([]string{"1", "2", "3", "4", "5", "pinned"}); err != nil {
		t.Fatalf("five tags and the pin rejected: %v", err)
	}
	if _, err := NormalizeTopicTags([]string{"1", "2", "3", "4", "5", "6"}); err == nil {
		t.Fatal("six tags accepted")
	}
	if got, err := NormalizeTopicTags([]string{" ", ""}); err != nil || got != nil {
		t.Fatalf("blank tags = %q, %v", got, err)
	}
	if _, err := NormalizeTopicTags([]string{strings.Repeat("字", MaxTopicTagLength+1)}); err == nil {
		t.Fatal("over-long tag accepted")
	}
	if _, err := NormalizeTopicTags([]string{strings.Repeat("字", MaxTopicTagLength)}); err != nil {
		t.Fatalf("tag at the limit rejected: %v", err)
	}
}
