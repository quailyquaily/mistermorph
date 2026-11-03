package consolecmd

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func attachmentFixture(t *testing.T) (*consoleSendFileTool, daemonruntime.ConsoleFileStoreOptions) {
	t.Helper()
	dir := t.TempDir()
	opts := daemonruntime.ConsoleFileStoreOptions{RootDir: filepath.Join(dir, "tasks"), JournalDir: filepath.Join(dir, "journal"), Persist: true}
	store, err := daemonruntime.NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Upsert(daemonruntime.TaskInfo{ID: "task", TopicID: "topic", Status: daemonruntime.TaskDone}); err != nil {
		t.Fatal(err)
	}
	return &consoleSendFileTool{store: store, taskID: "task", topicID: "topic", workspaceDir: t.TempDir(), cacheDir: t.TempDir()}, opts
}

func TestConsoleSendFileDiscoveryAndDelivery(t *testing.T) {
	for _, query := range []string{"send_file", "send a file", "share document", "image attachment"} {
		t.Run(query, func(t *testing.T) {
			tool, _ := attachmentFixture(t)
			if err := os.WriteFile(filepath.Join(tool.workspaceDir, "report.txt"), []byte("report"), 0o600); err != nil {
				t.Fatal(err)
			}
			reg := tools.NewRegistry()
			if err := reg.Register(tool); err != nil {
				t.Fatal(err)
			}
			option, closeSearch, err := taskruntime.ToolSearchOption(reg, nil, toolsutil.ToolSearchConfig{Enabled: true}, nil, nil)
			if err != nil || option == nil {
				t.Fatalf("search option: %v", err)
			}
			defer closeSearch()
			step := 0
			client := topicNamingClientFunc(func(_ context.Context, req llm.Request) (llm.Result, error) {
				defer func() { step++ }()
				if step == 0 {
					for _, schema := range req.Tools {
						if schema.Name == "send_file" {
							t.Fatal("send_file must be deferred")
						}
					}
					return llm.Result{ToolCalls: []llm.ToolCall{{ID: "search", Name: "tool_search", Arguments: map[string]any{"query": query}}}}, nil
				}
				if step == 1 {
					found := false
					for _, schema := range req.Tools {
						if schema.Name == "send_file" {
							found = true
						}
					}
					if !found {
						t.Fatalf("search %q did not expose send_file", query)
					}
					var schema map[string]any
					if err := json.Unmarshal([]byte(tool.ParameterSchema()), &schema); err != nil {
						t.Fatal(err)
					}
					props := schema["properties"].(map[string]any)
					if props["path"] == nil || props["dir_name"] == nil || len(schema["required"].([]any)) != 2 {
						t.Fatalf("unusable schema: %v", schema)
					}
					return llm.Result{ToolCalls: []llm.ToolCall{{ID: "send", Name: "send_file", Arguments: map[string]any{"dir_name": "workspace_dir", "path": "report.txt"}}}}, nil
				}
				return llm.Result{Text: `{"type":"final","output":"sent"}`}, nil
			})
			engine := agent.New(client, reg, agent.Config{MaxSteps: 4}, agent.DefaultPromptSpec(), option)
			if _, _, err := engine.Run(context.Background(), "send the report", agent.RunOptions{}); err != nil {
				t.Fatal(err)
			}
			task, _ := tool.store.Get("task")
			if len(task.Attachments) != 1 || task.Attachments[0].Name != "report.txt" {
				t.Fatalf("delivery: %+v", task)
			}
		})
	}
}

func TestConsoleSendFilePersistenceAndAccess(t *testing.T) {
	tool, opts := attachmentFixture(t)
	tool.hub = newConsoleStreamHub()
	frames, unsubscribe := tool.hub.Subscribe("task")
	defer unsubscribe()
	// A real PNG signature determines previewability, independently of the filename.
	content := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 32)...)
	path := filepath.Join(tool.cacheDir, "image.dat")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := tool.Execute(context.Background(), map[string]any{"dir_name": "file_cache_dir", "path": "image.dat"})
	if err != nil || strings.Contains(result, tool.cacheDir) {
		t.Fatalf("send: %s, %v", result, err)
	}
	select {
	case frame := <-frames:
		if len(frame.Attachments) != 1 {
			t.Fatal("missing streamed attachment")
		}
	default:
		t.Fatal("no attachment frame")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	reloaded, err := daemonruntime.NewConsoleFileStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	task, _ := reloaded.Get("task")
	if len(task.Attachments) != 1 {
		t.Fatalf("reload: %+v", task)
	}
	attachment := task.Attachments[0]
	query := url.Values{"topic_id": {"topic"}, "task_id": {"task"}, "id": {attachment.ID}}
	for _, preview := range []string{"", "1"} {
		query.Set("preview", preview)
		rec := httptest.NewRecorder()
		reloaded.ServeAttachment(rec, httptest.NewRequest("GET", "/attachments?"+query.Encode(), nil))
		if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), content) {
			t.Fatalf("download after reload: %d %s", rec.Code, rec.Body.String())
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") {
			t.Fatal("missing safe headers")
		}
		if preview == "1" && rec.Header().Get("Content-Type") != "image/png" {
			t.Fatal("missing raster preview")
		}
	}
	for key, value := range map[string]string{"topic_id": "other", "task_id": "other", "id": "../../secret"} {
		changed, _ := url.ParseQuery(query.Encode())
		changed.Set(key, value)
		rec := httptest.NewRecorder()
		reloaded.ServeAttachment(rec, httptest.NewRequest("GET", "/attachments?"+changed.Encode(), nil))
		if rec.Code != 404 {
			t.Fatalf("%s: status %d", key, rec.Code)
		}
	}
	srv := &server{cfg: serveConfig{password: "test-password"}, sessions: newSessionStore(""), localRuntime: &consoleLocalRuntime{store: reloaded}}
	rec := httptest.NewRecorder()
	srv.withAuth(srv.handleReceivedAttachment)(rec, httptest.NewRequest("GET", "/attachments?"+query.Encode(), nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated download: %d", rec.Code)
	}
	if _, err := reloaded.DeleteTopic("topic"); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	reloaded.ServeAttachment(rec, httptest.NewRequest("GET", "/attachments?"+query.Encode(), nil))
	if rec.Code != 404 {
		t.Fatalf("deleted conversation: %d", rec.Code)
	}
}

func TestConsoleSendFileRejectsInvalidInput(t *testing.T) {
	for _, test := range []string{"empty", "missing", "directory", "unreadable", "traversal", "symlink", "absolute", "wrong-topic", "unknown-param", "delivery", "oversize"} {
		t.Run(test, func(t *testing.T) {
			tool, _ := attachmentFixture(t)
			path := filepath.Join(tool.workspaceDir, "file")
			if err := os.WriteFile(path, []byte("data"), 0o600); err != nil {
				t.Fatal(err)
			}
			params := map[string]any{"dir_name": "workspace_dir", "path": "file"}
			switch test {
			case "empty":
				if err := os.Truncate(path, 0); err != nil {
					t.Fatal(err)
				}
			case "missing":
				params["path"] = "absent"
			case "directory":
				params["path"] = "."
			case "unreadable":
				if err := os.Chmod(path, 0); err != nil {
					t.Fatal(err)
				}
			case "traversal":
				params["path"] = "../file"
			case "symlink":
				if err := os.Symlink(filepath.Join(tool.cacheDir, "outside"), filepath.Join(tool.workspaceDir, "link")); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(tool.cacheDir, "outside"), []byte("secret"), 0o600); err != nil {
					t.Fatal(err)
				}
				params["path"] = "link"
			case "absolute":
				params["path"] = path
			case "wrong-topic":
				tool.topicID = "other"
			case "unknown-param":
				params["topic_id"] = "other"
			case "delivery":
				tool.store = nil
			case "oversize":
				if err := os.Truncate(path, (64<<20)+1); err != nil {
					t.Fatal(err)
				}
			}
			result, err := tool.Execute(context.Background(), params)
			if err == nil || result != "" {
				t.Fatalf("expected explicit error, got %q, %v", result, err)
			}
			if tool.store != nil {
				task, _ := tool.store.Get("task")
				if len(task.Attachments) != 0 {
					t.Fatal("failed delivery published an attachment")
				}
			}
		})
	}
}

func TestConsoleSendFileActiveTypesDownloadOnly(t *testing.T) {
	for _, name := range []string{"page.html", "drawing.svg", "fake.png", "report.pdf"} {
		t.Run(name, func(t *testing.T) {
			tool, _ := attachmentFixture(t)
			if err := os.WriteFile(filepath.Join(tool.workspaceDir, name), []byte("<svg onload=\"alert(1)\"/>"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := tool.Execute(context.Background(), map[string]any{"dir_name": "workspace_dir", "path": name}); err != nil {
				t.Fatal(err)
			}
			task, _ := tool.store.Get("task")
			a := task.Attachments[0]
			if a.ContentType != "application/octet-stream" {
				t.Fatalf("unsafe type: %s", a.ContentType)
			}
			query := url.Values{"topic_id": {"topic"}, "task_id": {"task"}, "id": {a.ID}}
			rec := httptest.NewRecorder()
			tool.store.ServeAttachment(rec, httptest.NewRequest("GET", "/attachments?"+query.Encode(), nil))
			if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Disposition"), "attachment;") {
				t.Fatal("no download fallback")
			}
			query.Set("preview", "1")
			rec = httptest.NewRecorder()
			tool.store.ServeAttachment(rec, httptest.NewRequest("GET", "/attachments?"+query.Encode(), nil))
			if rec.Code != 400 {
				t.Fatal("active content was previewed")
			}
		})
	}
}

func TestConsoleRuntimeRegistersSendFileAndRetainsItOnCompletion(t *testing.T) {
	rt, job, _ := newConsoleProgressPersistenceRuntime(t, []consoleProgressPersistenceLLMStep{
		{result: llm.Result{ToolCalls: []llm.ToolCall{{ID: "send", Name: "send_file", Arguments: map[string]any{"dir_name": "workspace_dir", "path": "report.txt"}}}}},
		{result: llm.Result{Text: `{"type":"final","output":"sent"}`}},
	}, "work", false)
	job.WorkspaceDir = t.TempDir()
	if err := os.WriteFile(filepath.Join(job.WorkspaceDir, "report.txt"), []byte("report"), 0o600); err != nil {
		t.Fatal(err)
	}
	rt.handleTaskJob(context.Background(), job.ConversationKey, job)
	task, ok := rt.store.Get(job.TaskID)
	if !ok || task.Status != daemonruntime.TaskDone || len(task.Attachments) != 1 {
		t.Fatalf("runtime attachment delivery: %+v", task)
	}
}

func TestConsoleSendFileRefusesDeniedPaths(t *testing.T) {
	for _, dirName := range []string{"workspace_dir", "file_cache_dir"} {
		for _, test := range []struct{ name, path string }{
			{"basename", "private.txt"},
			{"nested", "sub/private.txt"},
			{"full-path suffix", "keys/id_ed25519"},
			{"symlink to denied", "innocent.txt"},
		} {
			t.Run(dirName+"/"+test.name, func(t *testing.T) {
				tool, _ := attachmentFixture(t)
				tool.denyPaths = []string{"private.txt", "keys/id_ed25519"}
				dir := tool.workspaceDir
				if dirName == "file_cache_dir" {
					dir = tool.cacheDir
				}
				for _, name := range []string{"private.txt", "sub/private.txt", "keys/id_ed25519"} {
					if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(dir, name), []byte("secret"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				if err := os.Symlink("private.txt", filepath.Join(dir, "innocent.txt")); err != nil {
					t.Fatal(err)
				}
				_, err := tool.Execute(context.Background(), map[string]any{"dir_name": dirName, "path": test.path})
				if err == nil || !strings.Contains(err.Error(), "deny_paths") {
					t.Fatalf("Execute(%q) error = %v, want a deny_paths refusal", test.path, err)
				}
				if task, _ := tool.store.Get("task"); len(task.Attachments) != 0 {
					t.Fatalf("denied file was stored: %+v", task.Attachments)
				}
			})
		}
	}
	tool, _ := attachmentFixture(t)
	tool.denyPaths = []string{"private.txt"}
	if err := os.WriteFile(filepath.Join(tool.workspaceDir, "report.txt"), []byte("report"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := tool.Execute(context.Background(), map[string]any{"dir_name": "workspace_dir", "path": "report.txt"}); err != nil {
		t.Fatalf("allowed file: %v", err)
	}
}

func TestConsoleRuntimeSendFileAppliesReadFileDenyPaths(t *testing.T) {
	rt, job, _ := newConsoleProgressPersistenceRuntime(t, []consoleProgressPersistenceLLMStep{
		{result: llm.Result{ToolCalls: []llm.ToolCall{{ID: "send", Name: "send_file", Arguments: map[string]any{"dir_name": "workspace_dir", "path": "config.yaml"}}}}},
		{result: llm.Result{Text: `{"type":"final","output":"refused"}`}},
	}, "work", false)
	job.WorkspaceDir = t.TempDir()
	// The default deny list; the fixture's config does not load defaults.
	job.Generation.reader.Set("tools.read_file.deny_paths", []string{"config.yaml"})
	if err := os.WriteFile(filepath.Join(job.WorkspaceDir, "config.yaml"), []byte("api_key: secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	rt.handleTaskJob(context.Background(), job.ConversationKey, job)
	task, ok := rt.store.Get(job.TaskID)
	if !ok || len(task.Attachments) != 0 {
		t.Fatalf("runtime delivered a denied file: %+v", task)
	}
}
