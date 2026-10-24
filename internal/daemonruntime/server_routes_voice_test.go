package daemonruntime

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/spf13/viper"
)

func voiceTestHandler(t *testing.T, configure func(*viper.Viper)) http.Handler {
	t.Helper()
	stateDir := t.TempDir()
	reader := viper.New()
	reader.Set("config", filepath.Join(stateDir, "config.yaml"))
	reader.Set("file_state_dir", stateDir)
	reader.Set("llm.provider", "openai")
	reader.Set("llm.model", "gpt-test")
	reader.Set("llm.api_key", "config-key")
	if configure != nil {
		configure(reader)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{AuthToken: "token", AgentSettingsReader: reader})
	return mux
}

func voiceRequest(t *testing.T, handler http.Handler, req *http.Request) (int, map[string]any) {
	t.Helper()
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body
}

func voiceUpload(t *testing.T, audio []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	part, err := form.CreateFormFile("audio", "voice.webm")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(audio)
	_ = form.Close()
	req := httptest.NewRequest(http.MethodPost, "/voice/transcribe", &buf)
	req.Header.Set("Content-Type", form.FormDataContentType())
	return req
}

func TestVoiceTranscribeIsOffWithoutARoute(t *testing.T) {
	handler := voiceTestHandler(t, nil)
	code, body := voiceRequest(t, handler, httptest.NewRequest(http.MethodGet, "/voice/transcribe", nil))
	if code != http.StatusOK || body["available"] != false {
		t.Fatalf("GET = %d %v, want available false", code, body)
	}
	if code, _ := voiceRequest(t, handler, voiceUpload(t, []byte("audio"))); code != http.StatusConflict {
		t.Fatalf("POST status = %d, want %d", code, http.StatusConflict)
	}
}

func TestVoiceTranscribeRequiresAuth(t *testing.T) {
	handler := voiceTestHandler(t, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/voice/transcribe", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestVoiceTranscribeUsesTheTranscriptionRoute(t *testing.T) {
	var gotAudio []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err == nil {
			if file, _, err := r.FormFile("file"); err == nil {
				gotAudio, _ = io.ReadAll(file)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"text":"turn on the lights"}`)
	}))
	defer upstream.Close()

	handler := voiceTestHandler(t, func(reader *viper.Viper) {
		reader.Set("llm.profiles", map[string]any{
			"ears": map[string]any{
				"abilities":          []string{"transcription"},
				"inference_provider": "openai_chat_compatible",
				"endpoint":           upstream.URL + "/v1",
				"api_key":            "ears-key",
				"model":              "whisper-1",
			},
		})
		reader.Set("llm.routes", map[string]any{"transcription": "ears"})
	})

	code, body := voiceRequest(t, handler, httptest.NewRequest(http.MethodGet, "/voice/transcribe", nil))
	if code != http.StatusOK || body["available"] != true || body["model"] != "whisper-1" {
		t.Fatalf("GET = %d %v, want available with whisper-1", code, body)
	}
	code, body = voiceRequest(t, handler, voiceUpload(t, []byte("webm audio")))
	if code != http.StatusOK || body["text"] != "turn on the lights" {
		t.Fatalf("POST = %d %v, want the transcript", code, body)
	}
	if string(gotAudio) != "webm audio" {
		t.Fatalf("upstream audio = %q, want the uploaded bytes", gotAudio)
	}
}
