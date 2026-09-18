package chatcmd

import (
	"context"
	"fmt"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRemoteURLSecurity(t *testing.T) {
	for _, raw := range []string{"http://example.com/runtime", "https://user:pass@example.com/runtime", "https://example.com/runtime?token=secret", "ftp://localhost/runtime"} {
		if _, err := newRemoteClient(raw, "secret"); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}
func TestRemoteWorkspacePagination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("missing auth")
		}
		switch r.URL.Path {
		case "/nested/runtime/topics":
			if r.URL.Query().Get("cursor") == "" {
				fmt.Fprint(w, `{"items":[{"id":"other"}],"next_cursor":"next","has_next":true}`)
			} else {
				fmt.Fprint(w, `{"items":[{"id":"match"},{"id":"child"}]}`)
			}
		case "/nested/runtime/workspace":
			dir := "/other"
			if r.URL.Query().Get("topic_id") == "match" {
				dir = "/repo"
			}
			if r.URL.Query().Get("topic_id") == "child" {
				dir = "/repo/child"
			}
			fmt.Fprintf(w, `{"workspace_dir":%q}`, dir)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c, err := newRemoteClient(srv.URL+"/nested/runtime", "secret")
	if err != nil {
		t.Fatal(err)
	}
	p, err := c.topics(context.Background(), "/repo", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Items) != 1 || p.Items[0].ID != "match" || p.HasNext {
		t.Fatalf("page: %+v", p)
	}
}

func TestRemoteConnectAndRedirectSecurity(t *testing.T) {
	for _, tc := range []struct {
		mode   string
		status int
		want   string
	}{{"telegram", 200, "not a Console"}, {"console", 401, "authentication"}, {"console", 404, "not found"}, {"console", 503, "503"}, {"console", 200, ""}} {
		t.Run(fmt.Sprintf("%s-%d", tc.mode, tc.status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/health" {
					fmt.Fprintf(w, `{"mode":%q}`, tc.mode)
					return
				}
				w.WriteHeader(tc.status)
				fmt.Fprint(w, `{"items":[]}`)
			}))
			defer srv.Close()
			c, _ := newRemoteClient(srv.URL, "secret")
			err := c.connect(context.Background())
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.want) || strings.Contains(err.Error(), "secret") {
				t.Fatalf("error: %v", err)
			}
		})
	}
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer source.Close()
	c, _ := newRemoteClient(source.URL, "secret")
	if c.connect(context.Background()) == nil || hits != 0 {
		t.Fatal("followed authenticated redirect")
	}
}

func TestRemoteDefaultScopeReadOnly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/workspace" || !strings.HasPrefix(r.URL.Query().Get("topic_id"), "tui-workspace-probe-") {
			t.Fatalf("unexpected default resolution: %s %s", r.Method, r.URL)
		}
		fmt.Fprint(w, `{"workspace_dir":"/server/default"}`)
	}))
	defer srv.Close()
	c, _ := newRemoteClient(srv.URL, "secret")
	dir, err := c.scope(context.Background(), "", "")
	if err != nil || dir != "/server/default" {
		t.Fatalf("%q %v", dir, err)
	}
}

// Use production routing and storage rather than an invented JSON contract.
func TestRemoteTwoClientsProductionRoutes(t *testing.T) {
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	topic, err := store.CreateTopic("shared")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Upsert(taskdomain.TaskInfo{ID: "first", TopicID: topic.ID, Task: "from web", Status: taskdomain.TaskDone, CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	handler := daemonruntime.NewHandler(daemonruntime.RoutesOptions{
		Mode: "console", AuthToken: "secret", HealthEnabled: true,
		TaskTopic: daemonruntime.TaskTopicRoutes{TaskReader: store, TopicReader: store, TopicDeleter: store},
		Workspace: daemonruntime.WorkspaceRoutes{Get: func(_ context.Context, id string) (daemonruntime.WorkspaceResolution, error) {
			return daemonruntime.WorkspaceResolution{WorkspaceDir: "/server", Source: "default"}, nil
		}},
	})
	srv := httptest.NewServer(handler)
	defer srv.Close()
	a, _ := newRemoteClient(srv.URL, "secret")
	b, _ := newRemoteClient(srv.URL, "secret")
	ctx := context.Background()
	if err := a.connect(ctx); err != nil {
		t.Fatal(err)
	}
	p, err := a.topics(ctx, "/server", "")
	if err != nil || len(p.Items) != 1 || p.Items[0].ID != topic.ID {
		t.Fatalf("topics: %+v %v", p, err)
	}
	history, err := b.history(ctx, topic.ID, "")
	if err != nil || len(history.Items) != 1 || history.Items[0].Task != "from web" {
		t.Fatalf("history: %+v %v", history, err)
	}
	if err := store.SetTopicTitle(topic.ID, "changed by web"); err != nil {
		t.Fatal(err)
	}
	var current taskdomain.TopicInfo
	if err := a.request(ctx, "GET", topicPath(topic.ID), nil, &current); err != nil || current.Title != "changed by web" {
		t.Fatalf("topic: %+v %v", current, err)
	}
	if err := b.request(ctx, "DELETE", topicPath(topic.ID), nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := a.request(ctx, "GET", topicPath(topic.ID), nil, &current); err == nil {
		t.Fatal("deleted topic still available")
	}
}

func TestRemoteWorkspaceMissingFieldIsNotUnbound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{}`) }))
	defer srv.Close()
	c, _ := newRemoteClient(srv.URL, "secret")
	if _, err := c.workspace(context.Background(), "a"); err == nil {
		t.Fatal("malformed workspace silently became unbound")
	}
}
