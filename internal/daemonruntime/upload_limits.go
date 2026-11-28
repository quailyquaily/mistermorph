package daemonruntime

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// The budgets of POST /files/upload, the files a user attaches (the Console's composer: picked,
// dropped and pasted files) and any other client of the runtime API. Each file is checked on its
// own and the whole multipart request as one: a request's parts (several files, fields, framing)
// share its budget. The extra MiB of the request is room for the framing and ordinary fields of a
// largest file, not more metadata. The Console's proxy (cmd/mistermorph/consolecmd) enforces the
// same numbers in front of the runtime. Files the agent sends (console_attachments.go, send_file)
// have budgets of their own.
const (
	FileUploadMaxFileBytes    int64 = 128 << 20 // 134,217,728 bytes
	FileUploadMaxRequestBytes int64 = 129 << 20 // 135,266,304 bytes
	// Multipart parts above this are written to temporary files instead of held in memory.
	fileUploadMemoryBytes int64 = 8 << 20
	// A file the agent sends to the Console (send_file), stored for the chat.
	consoleAttachmentMaxBytes int64 = 64 << 20
)

// Codes of upload refusals (`code` beside `error` in the JSON body), shared with the Console's
// proxy so that a client can say which limit a refusal is about.
const (
	UploadCodeRequestTooLarge = "upload_request_too_large"
	UploadCodeFileTooLarge    = "upload_file_too_large"
	UploadCodeBusy            = "upload_busy"
)

// UploadRequestTooLargeMessage is the refusal of a request over FileUploadMaxRequestBytes.
func UploadRequestTooLargeMessage() string {
	return fmt.Sprintf("upload request exceeds %d MiB (%d bytes)", FileUploadMaxRequestBytes>>20, FileUploadMaxRequestBytes)
}

// UploadFileTooLargeMessage is the refusal of a file over FileUploadMaxFileBytes.
func UploadFileTooLargeMessage(name string) string {
	return fmt.Sprintf("file %q exceeds %d MiB (%d bytes)", name, FileUploadMaxFileBytes>>20, FileUploadMaxFileBytes)
}

// WriteUploadRefusal writes an upload refusal as JSON: `error` (with the limit in MiB and bytes),
// `code` and, for a refusal over a size, `limit_bytes`. A request that was too large closes the
// connection, as http.MaxBytesReader asks.
func WriteUploadRefusal(w http.ResponseWriter, status int, code, message string, limitBytes int64) {
	payload := map[string]any{"error": message, "code": code}
	if limitBytes > 0 {
		payload["limit_bytes"] = limitBytes
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
