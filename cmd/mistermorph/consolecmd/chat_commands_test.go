package consolecmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

func TestSharedChatProjectGuideCommands(t *testing.T) {
	a, b, provider, dir := newSharedTopicsAcceptance(t)
	init := a.submit("", "/INIT", dir)
	a.wait(init.ID, daemonruntime.TaskDone)
	path := filepath.Join(dir, "AGENTS.md")
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "acceptance-answer\n" {
		t.Fatalf("/init did not write its workspace guide: %q %v", data, err)
	}
	calls := len(provider.snapshot())
	read := b.submit(init.TopicID, "/init", "")
	result := b.wait(read.ID, daemonruntime.TaskDone)
	if !strings.Contains(chathistory.TaskReplyText(result), "acceptance-answer") || len(provider.snapshot()) != calls {
		t.Fatal("/init did not read the existing guide")
	}
	if err := os.WriteFile(path, []byte("old guide"), 0600); err != nil {
		t.Fatal(err)
	}
	update := a.submit(init.TopicID, "/update ignored-argument", "")
	a.wait(update.ID, daemonruntime.TaskDone)
	data, err = os.ReadFile(path)
	if err != nil || string(data) != "acceptance-answer\n" {
		t.Fatalf("/update did not replace the guide: %q %v", data, err)
	}
}

func TestSharedChatResetClearsContextAcrossClients(t *testing.T) {
	a, b, provider, _ := newSharedTopicsAcceptance(t)
	first := a.submit("", "before-reset-marker", "")
	a.wait(first.ID, daemonruntime.TaskDone)
	compact := a.submit(first.TopicID, "/ctx compact", "")
	a.wait(compact.ID, daemonruntime.TaskDone)
	reset := b.submit(first.TopicID, "/RESET", "")
	result := b.wait(reset.ID, daemonruntime.TaskDone)
	if !strings.Contains(chathistory.TaskReplyText(result), "Session reset") {
		t.Fatalf("reset was not handled: %+v", result)
	}
	next := b.submit(first.TopicID, "after-reset-marker", "")
	b.wait(next.ID, daemonruntime.TaskDone)
	requests := provider.snapshot()
	raw, _ := json.Marshal(requests[len(requests)-1].Messages)
	if strings.Contains(string(raw), "before-reset-marker") || strings.Contains(string(raw), "acceptance-checkpoint-summary") {
		t.Fatalf("reset restored stale context: %s", raw)
	}
	var old daemonruntime.TaskInfo
	a.ok("GET", "/tasks/"+first.ID, nil, &old)
	if old.Task != "before-reset-marker" {
		t.Fatal("reset deleted shared display history")
	}
}
