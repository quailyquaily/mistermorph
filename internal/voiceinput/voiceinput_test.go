package voiceinput

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
)

type fakeTranscriber struct {
	text string
	got  llm.TranscriptionRequest
}

func (f *fakeTranscriber) Transcribe(_ context.Context, req llm.TranscriptionRequest) (llm.TranscriptionResult, error) {
	f.got = req
	return llm.TranscriptionResult{Text: f.text}, nil
}

func TestTranscribable(t *testing.T) {
	cases := []struct {
		mimeType, filename string
		want               bool
	}{
		{"audio/ogg; codecs=opus", "", true},
		{"audio/mpeg", "", true},
		{"video/webm", "", true},
		{"", "voice.m4a", true},
		{"application/octet-stream", "voice.ogg", true},
		{"audio/silk", "voice.silk", false},
		{"image/png", "", false},
		{"", "notes.txt", false},
	}
	for _, tc := range cases {
		if got := Transcribable(tc.mimeType, tc.filename); got != tc.want {
			t.Errorf("Transcribable(%q, %q) = %v, want %v", tc.mimeType, tc.filename, got, tc.want)
		}
	}
}

func TestTranscribeFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "voice.ogg")
	if err := os.WriteFile(path, []byte("OggS"), 0o600); err != nil {
		t.Fatal(err)
	}
	client := &fakeTranscriber{text: "  hi  "}
	got, err := TranscribeFile(context.Background(), client, path, "audio/ogg", SceneChannel)
	if err != nil || got != "hi" {
		t.Fatalf("TranscribeFile() = %q, %v; want hi", got, err)
	}
	if client.got.Audio.Filename != "voice.ogg" || client.got.Scene != SceneChannel || string(client.got.Audio.Data) != "OggS" {
		t.Fatalf("request = %#v", client.got)
	}
	if got, err := TranscribeFile(context.Background(), nil, path, "audio/ogg", SceneChannel); got != "" || err != nil {
		t.Fatalf("nil client = %q, %v; want no transcript and no error", got, err)
	}
}

func TestTranscribeRejectsOversizedAudio(t *testing.T) {
	_, err := Transcribe(context.Background(), &fakeTranscriber{}, llm.AudioInput{Data: make([]byte, MaxBytes+1)}, SceneChannel)
	if err == nil || !strings.Contains(err.Error(), "limit") {
		t.Fatalf("Transcribe() error = %v, want a size limit error", err)
	}
}

func TestNewClientIsNilWithoutARoute(t *testing.T) {
	client, err := NewClient(llmutil.RuntimeValues{Provider: "openai", Model: "gpt-5.5"}, "", nil)
	if client != nil || err != nil {
		t.Fatalf("NewClient() = %v, %v; want nil, nil", client, err)
	}
}

func TestNote(t *testing.T) {
	if got := Note(" hello "); got != "Voice message transcript:\nhello" {
		t.Fatalf("Note() = %q", got)
	}
	if got := Note(""); !strings.Contains(got, "no speech") {
		t.Fatalf("Note(\"\") = %q", got)
	}
}
