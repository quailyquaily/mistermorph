package uniai

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
)

func TestTranscribeSendsAudioToOpenAI(t *testing.T) {
	var gotPath, gotModel, gotLanguage, gotFilename, gotAuth string
	var gotAudio []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("ParseMultipartForm() error = %v", err)
		}
		gotModel = r.FormValue("model")
		gotLanguage = r.FormValue("language")
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Errorf("FormFile() error = %v", err)
		} else {
			gotFilename = header.Filename
			gotAudio, _ = io.ReadAll(file)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"text":" hello there ","usage":{"type":"tokens","input_tokens":12,"input_token_details":{"audio_tokens":10,"text_tokens":2},"output_tokens":3,"total_tokens":15}}`)
	}))
	defer srv.Close()

	client, err := New(Config{Provider: "openai", Endpoint: srv.URL, APIKey: "test-key", Model: "gpt-4o-mini-transcribe"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	res, err := client.Transcribe(context.Background(), llm.TranscriptionRequest{
		Audio:    llm.AudioInput{Filename: "voice.ogg", MIMEType: "audio/ogg", Data: []byte("OggS fake audio")},
		Language: "en",
	})
	if err != nil {
		t.Fatalf("Transcribe() error = %v", err)
	}
	if res.Text != "hello there" {
		t.Fatalf("Text = %q, want trimmed transcript", res.Text)
	}
	if res.Usage.InputTokens != 12 || res.Usage.OutputTokens != 3 || res.Usage.Cache.Details["input_audio_tokens"] != 10 {
		t.Fatalf("Usage = %#v, want the reported token usage", res.Usage)
	}
	if !strings.HasSuffix(gotPath, "/audio/transcriptions") {
		t.Fatalf("path = %q, want /audio/transcriptions", gotPath)
	}
	if gotAuth != "Bearer test-key" || gotModel != "gpt-4o-mini-transcribe" || gotLanguage != "en" {
		t.Fatalf("auth/model/language = %q/%q/%q", gotAuth, gotModel, gotLanguage)
	}
	if gotFilename != "voice.ogg" || string(gotAudio) != "OggS fake audio" {
		t.Fatalf("file = %q (%q), want voice.ogg with the audio bytes", gotFilename, gotAudio)
	}
}

func TestTranscribeRejectsEmptyAudio(t *testing.T) {
	client, err := New(Config{Provider: "openai", APIKey: "k", Model: "whisper-1"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := client.Transcribe(context.Background(), llm.TranscriptionRequest{}); err == nil {
		t.Fatal("Transcribe() error = nil, want an empty-audio error")
	}
}
