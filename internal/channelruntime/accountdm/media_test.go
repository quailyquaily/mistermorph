package accountdm

import (
	"strings"
	"testing"
)

func TestMediaTextAddsVoiceTranscripts(t *testing.T) {
	in := Inbound{Media: []Media{{Kind: "audio"}}}
	saved := savedMedia{Transcripts: []string{"call me back"}, Note: "Attachments saved to file_cache_dir:\n- audio message"}
	got := mediaText("", saved, in)
	if !strings.HasPrefix(got, "User sent a voice message.") {
		t.Fatalf("mediaText() = %q, want it to start with the voice message line", got)
	}
	if !strings.Contains(got, "Voice message transcript:\ncall me back") || !strings.Contains(got, "Attachments saved") {
		t.Fatalf("mediaText() = %q, want the transcript and the attachment note", got)
	}

	withCaption := mediaText("listen", saved, in)
	if !strings.HasPrefix(withCaption, "listen\n\nVoice message transcript:") {
		t.Fatalf("mediaText() = %q, want the caption first", withCaption)
	}

	untranscribed := mediaText("", savedMedia{}, in)
	if untranscribed != "User sent an audio message." {
		t.Fatalf("mediaText() = %q, want the plain audio line", untranscribed)
	}
}
