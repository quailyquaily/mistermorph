package todo

import (
	"strings"
	"testing"
)

func TestValidateRequiredReferenceMentions_FirstPersonMissing(t *testing.T) {
	snap := ContactSnapshot{
		ReachableIDs: []string{"tg:1001"},
	}
	err := ValidateRequiredReferenceMentions("今晚20点提醒我看球赛", snap)
	if err == nil {
		t.Fatalf("expected missing_reference_id error")
	}
	msg := strings.ToLower(err.Error())
	if !strings.Contains(msg, "missing_reference_id") {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(err.Error(), "我") {
		t.Fatalf("missing mention detail in error: %v", err)
	}
}

func TestValidateRequiredReferenceMentions_FirstPersonWithReference(t *testing.T) {
	snap := ContactSnapshot{
		ReachableIDs: []string{"tg:1001"},
	}
	if err := ValidateRequiredReferenceMentions("今晚20点提醒我 (tg:1001) 看球赛", snap); err != nil {
		t.Fatalf("ValidateRequiredReferenceMentions() error = %v", err)
	}
}

func TestValidateRequiredReferenceMentions_EnglishFirstPersonMissing(t *testing.T) {
	snap := ContactSnapshot{
		ReachableIDs: []string{"tg:1001"},
	}
	err := ValidateRequiredReferenceMentions("Remind me to watch the game at 8pm", snap)
	if err == nil {
		t.Fatalf("expected missing_reference_id error")
	}
	msg := strings.ToLower(err.Error())
	if !strings.Contains(msg, "missing_reference_id") || !strings.Contains(msg, "me") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestAnnotateFirstPersonReference(t *testing.T) {
	out, changed, err := AnnotateFirstPersonReference("今晚20点提醒我看球赛", "tg:1001")
	if err != nil {
		t.Fatalf("AnnotateFirstPersonReference() error = %v", err)
	}
	if !changed {
		t.Fatalf("expected changed=true")
	}
	if out != "今晚20点提醒我 (tg:1001) 看球赛" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestAnnotateFirstPersonReference_NoChangeWhenAlreadyAnnotated(t *testing.T) {
	in := "今晚20点提醒我 (tg:1001) 看球赛"
	out, changed, err := AnnotateFirstPersonReference(in, "tg:1001")
	if err != nil {
		t.Fatalf("AnnotateFirstPersonReference() error = %v", err)
	}
	if changed {
		t.Fatalf("expected changed=false")
	}
	if out != in {
		t.Fatalf("unexpected output: %q", out)
	}
}
