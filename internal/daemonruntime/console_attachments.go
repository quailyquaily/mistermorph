package daemonruntime

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

// AddAttachment commits content before publishing metadata in the task journal.
func (s *ConsoleFileStore) AddAttachment(taskID, topicID, name string, source io.Reader) (taskdomain.FileAttachment, error) {
	var attachment taskdomain.FileAttachment
	if s == nil {
		return attachment, fmt.Errorf("attachment store is unavailable")
	}
	unlock, err := s.lockShared()
	if err != nil {
		return attachment, err
	}
	defer unlock()
	task, ok := s.items[taskID]
	topic, topicOK := s.topics[topicID]
	if !ok || task.TopicID != topicID || !topicOK || topicDeleted(topic) {
		return attachment, fmt.Errorf("attachment conversation is unavailable")
	}
	if s.rootDir == "" || s.rootDir == "." {
		return attachment, fmt.Errorf("attachment storage is not configured")
	}
	dir := filepath.Join(s.rootDir, "attachments")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return attachment, fmt.Errorf("create attachment storage: %w", err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return attachment, err
	}
	defer root.Close()
	id := uuid.NewString()
	file, err := root.OpenFile(id, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return attachment, err
	}
	committed := false
	defer func() {
		file.Close()
		if !committed {
			_ = root.Remove(id)
		}
	}()
	size, err := io.Copy(file, io.LimitReader(source, fileUploadMaxBytes+1))
	if err != nil {
		return attachment, fmt.Errorf("read attachment: %w", err)
	}
	if size == 0 {
		return attachment, fmt.Errorf("file is empty")
	}
	if size > fileUploadMaxBytes {
		return attachment, fmt.Errorf("file exceeds the 64 MiB limit")
	}
	var head [512]byte
	n, err := file.ReadAt(head[:], 0)
	if err != nil && err != io.EOF {
		return attachment, err
	}
	contentType := "application/octet-stream"
	switch detected := http.DetectContentType(head[:n]); detected {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		contentType = detected
	}
	if err := file.Sync(); err != nil {
		return attachment, err
	}
	if err := file.Close(); err != nil {
		return attachment, err
	}
	// Persist the directory entry before the journal can reference it.
	directory, err := root.Open(".")
	if err != nil {
		return attachment, err
	}
	err = directory.Sync()
	_ = directory.Close()
	if err != nil {
		return attachment, err
	}
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." {
		name = "attachment"
	}
	attachment = taskdomain.FileAttachment{ID: id, Name: name, SizeBytes: size, ContentType: contentType}
	task.Attachments = append(append([]taskdomain.FileAttachment(nil), task.Attachments...), attachment)
	cursor, err := s.appendTaskEventLocked(task, nil, time.Now().UTC(), s.triggerForTaskLocked(taskID, TaskTrigger{}), taskdomain.JournalTypeTaskUpdate)
	if err != nil {
		return taskdomain.FileAttachment{}, fmt.Errorf("persist attachment: %w", err)
	}
	s.items[taskID] = task
	s.projectionCursor = cursor
	committed = true
	return attachment, nil
}

// ServeAttachment only resolves IDs present in the requested conversation's history.
// Its caller must enforce the same authentication as conversation history.
func (s *ConsoleFileStore) ServeAttachment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if s == nil {
		http.Error(w, "attachment store unavailable", http.StatusServiceUnavailable)
		return
	}
	unlock, err := s.lockShared()
	if err != nil {
		http.Error(w, "attachment store unavailable", http.StatusServiceUnavailable)
		return
	}
	query := r.URL.Query()
	topicID, taskID, id := query.Get("topic_id"), query.Get("task_id"), query.Get("id")
	task, ok := s.items[taskID]
	topic, topicOK := s.topics[topicID]
	var attachment taskdomain.FileAttachment
	if ok && task.TopicID == topicID && topicOK && !topicDeleted(topic) {
		for _, item := range task.Attachments {
			if item.ID == id {
				attachment = item
				break
			}
		}
	}
	dir := filepath.Join(s.rootDir, "attachments")
	unlock()
	// A slow download must not hold the task journal's write lock.
	if attachment.ID == "" {
		http.NotFound(w, r)
		return
	}
	if _, err := uuid.Parse(id); err != nil {
		http.NotFound(w, r)
		return
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	file, err := root.Open(id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	contentType := "application/octet-stream"
	disposition := attachmentContentDisposition(attachment.Name)
	if query.Get("preview") == "1" {
		switch attachment.ContentType {
		case "image/png", "image/jpeg", "image/gif", "image/webp":
			contentType = attachment.ContentType
			disposition = "inline"
		default:
			http.Error(w, "file type has no preview; download it instead", http.StatusBadRequest)
			return
		}
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, attachment.Name, info.ModTime(), file)
}
