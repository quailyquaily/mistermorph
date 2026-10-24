package daemonruntime

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/voiceinput"
	"github.com/quailyquaily/mistermorph/llm"
)

// voiceTranscribeMemoryBytes is how much of an upload ParseMultipartForm keeps in memory.
const voiceTranscribeMemoryBytes = 8 << 20

// registerVoiceRoutes serves /voice/transcribe, which turns Console voice input into text with the
// model llm.routes.transcription points at. GET reports whether the route is set; POST takes a
// multipart "audio" file (and an optional "language") and returns {"text": ...}.
func (routes *routeRegistration) registerVoiceRoutes() {
	mux := routes.mux
	authToken := routes.authToken
	settingsReader := routes.settingsReader
	journalDir := routes.paths.LLMUsageJournalDir

	mux.HandleFunc("/voice/transcribe", func(w http.ResponseWriter, r *http.Request) {
		if !checkAuth(r, authToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodGet:
			writeVoiceJSON(w, http.StatusOK, voiceTranscriptionStatus(settingsReader))
		case http.MethodPost:
			handleVoiceTranscribe(w, r, settingsReader, journalDir)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

type voiceTranscriptionStatusPayload struct {
	Available bool   `json:"available"`
	Profile   string `json:"profile,omitempty"`
	Model     string `json:"model,omitempty"`
	// Error says why a set route cannot be used.
	Error string `json:"error,omitempty"`
}

func voiceTranscriptionStatus(reader llmutil.ConfigReader) voiceTranscriptionStatusPayload {
	if reader == nil {
		return voiceTranscriptionStatusPayload{}
	}
	values, err := llmutil.RuntimeValuesFromReader(reader)
	if err != nil {
		return voiceTranscriptionStatusPayload{Error: err.Error()}
	}
	routeValues, err := llmutil.TranscriptionRouteValues(values)
	if errors.Is(err, llmutil.ErrTranscriptionRouteUnset) {
		return voiceTranscriptionStatusPayload{}
	}
	profile := strings.TrimSpace(values.Routes.Transcription.Profile)
	if err != nil {
		return voiceTranscriptionStatusPayload{Profile: profile, Error: err.Error()}
	}
	if _, err := llmutil.ResolveTranscriptionClientMetadata(routeValues); err != nil {
		return voiceTranscriptionStatusPayload{Profile: profile, Error: err.Error()}
	}
	return voiceTranscriptionStatusPayload{Available: true, Profile: profile, Model: strings.TrimSpace(routeValues.Model)}
}

func handleVoiceTranscribe(w http.ResponseWriter, r *http.Request, reader llmutil.ConfigReader, journalDir string) {
	if reader == nil {
		http.Error(w, "transcription is unavailable", http.StatusServiceUnavailable)
		return
	}
	values, err := llmutil.RuntimeValuesFromReader(reader)
	if err != nil {
		http.Error(w, strings.TrimSpace(err.Error()), http.StatusInternalServerError)
		return
	}
	client, err := voiceinput.NewClient(values, journalDir, slog.Default())
	if err != nil {
		http.Error(w, strings.TrimSpace(err.Error()), http.StatusServiceUnavailable)
		return
	}
	if client == nil {
		http.Error(w, llmutil.ErrTranscriptionRouteUnset.Error(), http.StatusConflict)
		return
	}
	if closer, ok := client.(io.Closer); ok {
		defer closer.Close()
	}

	r.Body = http.MaxBytesReader(w, r.Body, voiceinput.MaxBytes+1<<20)
	if err := r.ParseMultipartForm(voiceTranscribeMemoryBytes); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			http.Error(w, "audio exceeds 25 MB", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "invalid multipart form", http.StatusBadRequest)
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("audio")
	if err != nil {
		http.Error(w, "audio is required", http.StatusBadRequest)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, voiceinput.MaxBytes+1))
	if err != nil {
		http.Error(w, "audio could not be read", http.StatusBadRequest)
		return
	}
	if len(data) > voiceinput.MaxBytes {
		http.Error(w, "audio exceeds 25 MB", http.StatusRequestEntityTooLarge)
		return
	}
	res, err := client.Transcribe(r.Context(), llm.TranscriptionRequest{
		Audio: llm.AudioInput{
			Filename: header.Filename,
			MIMEType: header.Header.Get("Content-Type"),
			Data:     data,
		},
		Language: strings.TrimSpace(r.FormValue("language")),
		Scene:    voiceinput.SceneConsole,
	})
	if err != nil {
		http.Error(w, "transcription failed: "+strings.TrimSpace(err.Error()), http.StatusBadGateway)
		return
	}
	writeVoiceJSON(w, http.StatusOK, map[string]any{
		"text":     strings.TrimSpace(res.Text),
		"language": res.Language,
	})
}

func writeVoiceJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
