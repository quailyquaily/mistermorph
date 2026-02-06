package runcmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
)

type promptInspector struct {
	mu           sync.Mutex
	file         *os.File
	startedAt    time.Time
	task         string
	requestCount int
}

func newPromptInspector(task string) (*promptInspector, error) {
	startedAt := time.Now()
	if err := os.MkdirAll("dump", 0o755); err != nil {
		return nil, fmt.Errorf("create dump dir: %w", err)
	}
	filename := fmt.Sprintf("prompt_%s.md", startedAt.Format("20060102_1504"))
	path := filepath.Join("dump", filename)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open prompt dump file: %w", err)
	}
	inspector := &promptInspector{
		file:      file,
		startedAt: startedAt,
		task:      task,
	}
	if err := inspector.writeHeader(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return inspector, nil
}

func (p *promptInspector) Close() error {
	if p == nil || p.file == nil {
		return nil
	}
	return p.file.Close()
}

func (p *promptInspector) Dump(messages []llm.Message) error {
	if p == nil || p.file == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	p.requestCount++
	var b strings.Builder
	fmt.Fprintf(&b, "\n## Request #%d\n\n", p.requestCount)
	for i, msg := range messages {
		fmt.Fprintf(&b, "### Message #%d-%d\n\n", p.requestCount, i+1)
		b.WriteString("```\n")
		fmt.Fprintf(&b, "role: %s\n\n", msg.Role)
		if strings.TrimSpace(msg.ToolCallID) != "" {
			fmt.Fprintf(&b, "tool_call_id: %s\n\n", msg.ToolCallID)
		}
		if len(msg.ToolCalls) > 0 {
			toolCallsJSON, err := json.MarshalIndent(msg.ToolCalls, "", "  ")
			if err != nil {
				fmt.Fprintf(&b, "tool_calls: <error: %s>\n\n", err.Error())
			} else {
				fmt.Fprintf(&b, "tool_calls: %s\n\n", string(toolCallsJSON))
			}
		}
		fmt.Fprintf(&b, "content: %s\n", msg.Content)
		b.WriteString("```\n\n")
	}

	if _, err := p.file.WriteString(b.String()); err != nil {
		return err
	}
	return p.file.Sync()
}

func (p *promptInspector) writeHeader() error {
	header := fmt.Sprintf(
		"---\ntask: %s\ndatetime: %s\n---\n\n",
		strconv.Quote(p.task),
		strconv.Quote(p.startedAt.Format(time.RFC3339)),
	)
	if _, err := p.file.WriteString(header); err != nil {
		return err
	}
	return p.file.Sync()
}

type inspectClient struct {
	base      llm.Client
	inspector *promptInspector
}

func (c *inspectClient) Chat(ctx context.Context, req llm.Request) (llm.Result, error) {
	if c == nil || c.base == nil {
		return llm.Result{}, fmt.Errorf("inspect client is not initialized")
	}
	if c.inspector != nil {
		if err := c.inspector.Dump(req.Messages); err != nil {
			return llm.Result{}, err
		}
	}
	return c.base.Chat(ctx, req)
}

type requestInspector struct {
	mu        sync.Mutex
	file      *os.File
	startedAt time.Time
	task      string
	count     int
}

func newRequestInspector(task string) (*requestInspector, error) {
	startedAt := time.Now()
	if err := os.MkdirAll("dump", 0o755); err != nil {
		return nil, fmt.Errorf("create dump dir: %w", err)
	}
	filename := fmt.Sprintf("request_%s.md", startedAt.Format("20060102_1504"))
	path := filepath.Join("dump", filename)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open request dump file: %w", err)
	}
	inspector := &requestInspector{
		file:      file,
		startedAt: startedAt,
		task:      task,
	}
	if err := inspector.writeHeader(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return inspector, nil
}

func (r *requestInspector) Close() error {
	if r == nil || r.file == nil {
		return nil
	}
	return r.file.Close()
}

func (r *requestInspector) Dump(label, payload string) {
	if r == nil || r.file == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	r.count++
	var b strings.Builder
	fmt.Fprintf(&b, "\n## Event #%d\n\n", r.count)
	fmt.Fprintf(&b, "### %s\n\n", label)
	b.WriteString("```\n")
	b.WriteString(payload)
	if !strings.HasSuffix(payload, "\n") {
		b.WriteString("\n")
	}
	b.WriteString("```\n\n")

	_, _ = r.file.WriteString(b.String())
	_ = r.file.Sync()
}

func (r *requestInspector) writeHeader() error {
	header := fmt.Sprintf(
		"---\ntask: %s\ndatetime: %s\n---\n\n",
		strconv.Quote(r.task),
		strconv.Quote(r.startedAt.Format(time.RFC3339)),
	)
	if _, err := r.file.WriteString(header); err != nil {
		return err
	}
	return r.file.Sync()
}
