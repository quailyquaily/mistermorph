package guard

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

type JSONLAuditSink struct {
	path     string
	lockPath string
	writer   *fsstore.JSONLWriter

	mu sync.Mutex
}

func NewJSONLAuditSink(path string, rotateMaxBytes int64, lockRoot string) (*JSONLAuditSink, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("missing jsonl path")
	}
	if strings.TrimSpace(lockRoot) == "" {
		lockRoot = filepath.Join(filepath.Dir(path), ".fslocks")
	}
	lockPath, err := fsstore.BuildLockPath(lockRoot, "audit.guard_audit_jsonl")
	if err != nil {
		return nil, err
	}
	writer, err := fsstore.NewJSONLWriter(path, fsstore.JSONLOptions{
		RotateMaxBytes: rotateMaxBytes,
		FlushEachWrite: true,
	})
	if err != nil {
		return nil, err
	}
	return &JSONLAuditSink{
		path:     path,
		lockPath: lockPath,
		writer:   writer,
	}, nil
}

func (s *JSONLAuditSink) Emit(ctx context.Context, e AuditEvent) error {
	if s == nil || s.writer == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	return fsstore.WithLock(ctx, s.lockPath, func() error {
		return s.writer.AppendJSON(e)
	})
}

func (s *JSONLAuditSink) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.writer == nil {
		return nil
	}
	err := s.writer.Close()
	s.writer = nil
	return err
}
