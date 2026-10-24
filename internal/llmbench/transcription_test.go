package llmbench

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
)

type transcriberStub struct {
	text  string
	err   error
	calls int
	req   llm.TranscriptionRequest
}

func (s *transcriberStub) Transcribe(_ context.Context, req llm.TranscriptionRequest) (llm.TranscriptionResult, error) {
	s.calls++
	s.req = req
	return llm.TranscriptionResult{Text: s.text}, s.err
}

func TestBenchmarkIDsFollowAbilities(t *testing.T) {
	chat := []string{BenchmarkTextReply, BenchmarkJSONResponse, BenchmarkToolCalling, BenchmarkEvaluate}
	cases := []struct {
		name string
		meta ProfileMetadata
		want []string
	}{
		{name: "no abilities means text", meta: ProfileMetadata{}, want: chat},
		{name: "text", meta: ProfileMetadata{Abilities: []string{"text"}}, want: chat},
		{name: "transcription only", meta: ProfileMetadata{Abilities: []string{"transcription"}}, want: []string{BenchmarkTranscription}},
		{name: "text and transcription", meta: ProfileMetadata{Abilities: []string{"text", "transcription"}}, want: append(slices.Clone(chat), BenchmarkTranscription)},
		{name: "decision only", meta: ProfileMetadata{Abilities: []string{"decision"}, EvaluateOnly: true}, want: []string{BenchmarkEvaluate}},
		{name: "decision and transcription", meta: ProfileMetadata{Abilities: []string{"decision", "transcription"}, EvaluateOnly: true}, want: []string{BenchmarkEvaluate, BenchmarkTranscription}},
		{name: "image only", meta: ProfileMetadata{Abilities: []string{"image"}}, want: chat},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := BenchmarkIDs(tc.meta); !slices.Equal(got, tc.want) {
				t.Fatalf("BenchmarkIDs() = %v, want %v", got, tc.want)
			}
			if BenchmarkCount(tc.meta) != len(tc.want) {
				t.Fatalf("BenchmarkCount() = %d, want %d", BenchmarkCount(tc.meta), len(tc.want))
			}
			wantChat := !slices.Equal(tc.want, []string{BenchmarkTranscription})
			if NeedsChat(tc.meta) != wantChat || NeedsTranscription(tc.meta) != slices.Contains(tc.want, BenchmarkTranscription) {
				t.Fatalf("NeedsChat = %v, NeedsTranscription = %v", NeedsChat(tc.meta), NeedsTranscription(tc.meta))
			}
		})
	}
}

func TestRunTranscriptionBenchmark(t *testing.T) {
	cases := []struct {
		name     string
		client   *transcriberStub
		buildErr error
		wantOK   bool
		wantErr  string
	}{
		{name: "heard", client: &transcriberStub{text: "The quick brown fox jumps over the lazy dog."}, wantOK: true},
		{name: "heard imperfectly", client: &transcriberStub{text: "the quick brown fox jump over a lazy dog"}, wantOK: true},
		{name: "something else", client: &transcriberStub{text: "Thank you for watching."}, wantErr: "does not match"},
		{name: "nothing", client: &transcriberStub{text: "  "}, wantErr: "empty"},
		{name: "request failed", client: &transcriberStub{err: errors.New("status 401: bad key")}, wantErr: "bad key"},
		{name: "no client", buildErr: errors.New(`provider "anthropic" does not support transcription`), wantErr: "does not support transcription"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var client llm.TranscriptionClient
			if tc.client != nil {
				client = tc.client
			}
			got := RunTranscriptionBenchmark(context.Background(), client, tc.buildErr, "whisper-1")
			if got.ID != BenchmarkTranscription || got.OK != tc.wantOK || !strings.Contains(got.Error, tc.wantErr) {
				t.Fatalf("result = %+v", got)
			}
			if tc.client != nil {
				if tc.client.req.Model != "whisper-1" || len(tc.client.req.Audio.Data) == 0 || tc.client.req.Audio.Filename != "benchmark.mp3" {
					t.Fatalf("request = %+v", tc.client.req)
				}
			}
		})
	}
}

func TestRunTranscriptionOnlyProfileNeedsNoChatClient(t *testing.T) {
	transcriber := &transcriberStub{text: "The quick brown fox jumps over the lazy dog."}
	result := Run(context.Background(), Clients{Transcription: transcriber}, ProfileMetadata{Model: "whisper-1", Abilities: []string{"transcription"}})
	if len(result.Benchmarks) != 1 || result.Benchmarks[0].ID != BenchmarkTranscription || !result.OK() || transcriber.calls != 1 {
		t.Fatalf("result = %+v", result)
	}
}
