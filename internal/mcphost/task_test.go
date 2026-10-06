package mcphost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/quailyquaily/mistermorph/tools"
)

type testMCPServer struct {
	url      string
	requests *atomic.Int64
}

// newTestMCPServer serves an MCP server with the given tools over streamable HTTP. It counts the
// HTTP requests it receives, so a test can tell whether the server was contacted.
func newTestMCPServer(t *testing.T, toolNames ...string) testMCPServer {
	t.Helper()
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "1.0"}, nil)
	for _, name := range toolNames {
		mcp.AddTool(server, &mcp.Tool{Name: name, Description: "test tool " + name}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, struct{}, error) {
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}}, struct{}{}, nil
		})
	}
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	requests := &atomic.Int64{}
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(httpServer.Close)
	return testMCPServer{url: httpServer.URL, requests: requests}
}

func httpServerConfig(name, url string) ServerConfig {
	return ServerConfig{Name: name, Enable: true, Type: "http", URL: url}
}

func toolNames(reg *tools.Registry) []string {
	var names []string
	for _, tool := range reg.All() {
		names = append(names, tool.Name())
	}
	return names
}

func TestConnectRecordsServerStatus(t *testing.T) {
	live := newTestMCPServer(t, "search")
	onDemand := newTestMCPServer(t, "get_issue")
	onDemandCfg := httpServerConfig("github-work", onDemand.url)
	onDemandCfg.OnDemand = true
	disabled := httpServerConfig("off", live.url)
	disabled.Enable = false
	configs := []ServerConfig{
		httpServerConfig("live", live.url),
		onDemandCfg,
		disabled,
		{Name: "bad name", Enable: true, Type: "http", URL: live.url},
		httpServerConfig("dup", live.url),
		httpServerConfig("DUP", live.url),
		httpServerConfig("down", "http://127.0.0.1:1/mcp"),
	}
	host, err := Connect(context.Background(), configs, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()

	want := map[string]ServerState{
		"live": ServerConnected, "github-work": ServerOnDemand, "off": ServerDisabled,
		"bad name": ServerInvalid, "dup": ServerInvalid, "DUP": ServerInvalid, "down": ServerFailed,
	}
	for _, status := range host.Servers() {
		if status.State != want[status.Config.Name] {
			t.Errorf("%s: state = %s, want %s (err %v)", status.Config.Name, status.State, want[status.Config.Name], status.Err)
		}
	}
	if onDemand.requests.Load() != 0 {
		t.Fatalf("on-demand server was contacted at startup")
	}
	if got := len(host.Tools()); got != 1 {
		t.Fatalf("startup tools = %d, want only the live server's", got)
	}
}

func TestReferencedServers(t *testing.T) {
	configs := []ServerConfig{
		{Name: "github-work", Enable: true},
		{Name: "github-", Enable: true},
		{Name: "github", Enable: true},
		{Name: "jira", Enable: false},
	}
	tests := []struct {
		text     string
		consumed map[string]bool
		want     []string
	}{
		{text: "$mcp_github-work, please", want: []string{"github-work"}},
		{text: "see $mcp_github-work.", want: []string{"github-work"}},
		{text: "$MCP_GITHUB-WORK and $mcp_github-work again", want: []string{"github-work"}},
		{text: "$mcp_github- what's new", want: []string{"github-"}},
		{text: "$mcp_jira is off", want: nil},
		{text: "$mcp_unknown and price$mcp_github", want: nil},
		{text: "$mcp_github-work", consumed: map[string]bool{"mcp_github-work": true}, want: nil},
		{text: "$mcp_github and $mcp_github-work", want: []string{"github", "github-work"}},
	}
	for _, tt := range tests {
		t.Run(tt.text, func(t *testing.T) {
			var got []string
			for _, cfg := range ReferencedServers(tt.text, configs, tt.consumed) {
				got = append(got, cfg.Name)
			}
			if strings.Join(got, ",") != strings.Join(tt.want, ",") {
				t.Fatalf("ReferencedServers(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}

	onlyBare := []ServerConfig{{Name: "github", Enable: true}}
	if got := ReferencedServers("$mcp_github- what's new", onlyBare, nil); len(got) != 1 || got[0].Name != "github" {
		t.Fatalf("trailing hyphen without an exact server = %v, want github", got)
	}
}

func TestLoadReferenced(t *testing.T) {
	server := newTestMCPServer(t, "search_repositories", "get_issue", "delete_repo")
	cfg := httpServerConfig("github-work", server.url)
	cfg.OnDemand = true
	cfg.AllowedTools = []string{"search_repositories", "get_issue"}
	statuses := []ServerStatus{{Config: cfg, State: ServerOnDemand}}

	reg := tools.NewRegistry()
	host, err := LoadReferenced(context.Background(), "$mcp_github-work find the bug", statuses, nil, reg, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(toolNames(reg), ",")
	if !strings.Contains(got, "mcp_github-work__get_issue") || !strings.Contains(got, "mcp_github-work__search_repositories") || strings.Contains(got, "delete_repo") {
		t.Fatalf("registered tools = %s, want only the allowed ones", got)
	}
	if err := host.Close(); err != nil {
		t.Fatal(err)
	}

	untouched := tools.NewRegistry()
	before := server.requests.Load()
	host, err = LoadReferenced(context.Background(), "no reference here", statuses, nil, untouched, nil)
	if err != nil || host != nil || len(untouched.All()) != 0 || server.requests.Load() != before {
		t.Fatalf("unreferenced: host = %v, err = %v, tools = %v", host, err, toolNames(untouched))
	}
}

func TestLoadReferencedSkipsServersAlreadyConnected(t *testing.T) {
	server := newTestMCPServer(t, "search")
	statuses := []ServerStatus{{Config: httpServerConfig("live", server.url), State: ServerConnected}}
	host, err := LoadReferenced(context.Background(), "$mcp_live", statuses, nil, tools.NewRegistry(), nil)
	if err != nil || host != nil || server.requests.Load() != 0 {
		t.Fatalf("host = %v, err = %v, requests = %d; want no task connection", host, err, server.requests.Load())
	}
}

func TestLoadReferencedRetriesServerThatFailedAtStartup(t *testing.T) {
	server := newTestMCPServer(t, "search")
	statuses := []ServerStatus{{Config: httpServerConfig("flaky", server.url), State: ServerFailed}}
	reg := tools.NewRegistry()
	host, err := LoadReferenced(context.Background(), "$mcp_flaky", statuses, nil, reg, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	if _, ok := reg.Get("mcp_flaky__search"); !ok {
		t.Fatalf("tools = %v, want mcp_flaky__search", toolNames(reg))
	}
}

func TestLoadReferencedFailures(t *testing.T) {
	good := newTestMCPServer(t, "search")
	empty := newTestMCPServer(t)
	// A server that never answers: its handlers block until the test ends.
	stalled := make(chan struct{})
	hanging := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-stalled:
		}
	}))
	t.Cleanup(func() {
		close(stalled)
		hanging.Close()
	})

	onDemand := func(name, url string) ServerStatus {
		cfg := httpServerConfig(name, url)
		cfg.OnDemand = true
		return ServerStatus{Config: cfg, State: ServerOnDemand}
	}
	tests := []struct {
		name    string
		status  ServerStatus
		wantErr string
	}{
		{name: "invalid", status: ServerStatus{Config: ServerConfig{Name: "dup", Enable: true}, State: ServerInvalid, Err: errDuplicate}, wantErr: `mcp server "dup": invalid configuration`},
		{name: "connect", status: onDemand("down", "http://127.0.0.1:1/mcp"), wantErr: `mcp server "down": connect`},
		{name: "no tools", status: onDemand("empty", empty.url), wantErr: `mcp server "empty": no allowed tools`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// The good server connects first; a later failure must close it again.
			statuses := []ServerStatus{onDemand("good", good.url), tt.status}
			reg := tools.NewRegistry()
			host, err := LoadReferenced(context.Background(), "$mcp_good $mcp_"+tt.status.Config.Name, statuses, nil, reg, nil)
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("err = %v, want %q", err, tt.wantErr)
			}
			if host != nil || len(reg.All()) != 0 {
				t.Fatalf("host = %v, tools = %v; want nothing left behind", host, toolNames(reg))
			}
		})
	}

	t.Run("timeout", func(t *testing.T) {
		cfg := httpServerConfig("stalled", hanging.URL)
		started := time.Now()
		_, err := ConnectServers(context.Background(), []ServerConfig{cfg}, 200*time.Millisecond, nil)
		if err == nil || !strings.Contains(err.Error(), `mcp server "stalled"`) {
			t.Fatalf("err = %v, want a failure naming the server", err)
		}
		if elapsed := time.Since(started); elapsed > 5*time.Second {
			t.Fatalf("stalled server held preparation for %s", elapsed)
		}
	})

	t.Run("cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := ConnectServers(ctx, []ServerConfig{httpServerConfig("good", good.url)}, time.Minute, nil)
		if err == nil {
			t.Fatal("canceled context connected anyway")
		}
	})
}

func TestLoadReferencedIsolatesTasks(t *testing.T) {
	server := newTestMCPServer(t, "search")
	cfg := httpServerConfig("github-work", server.url)
	cfg.OnDemand = true
	statuses := []ServerStatus{{Config: cfg, State: ServerOnDemand}}
	base := tools.NewRegistry()

	withRef, without := base.Clone(), base.Clone()
	host, err := LoadReferenced(context.Background(), "$mcp_github-work", statuses, nil, withRef, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	if _, err := LoadReferenced(context.Background(), "plain task", statuses, nil, without, nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := without.Get("mcp_github-work__search"); ok {
		t.Fatal("a task without the reference got the server's tools")
	}
	if _, ok := base.Get("mcp_github-work__search"); ok {
		t.Fatal("task-loaded tools leaked into the base registry")
	}
}

var errDuplicate = errorString("mcp server name \"dup\" is duplicated")

type errorString string

func (e errorString) Error() string { return string(e) }

func TestParseServersReadsOnDemand(t *testing.T) {
	servers := ParseServers([]any{
		map[string]any{"name": "lazy", "on_demand": true},
		map[string]any{"name": "eager"},
	})
	if len(servers) != 2 || !servers[0].OnDemand || servers[1].OnDemand || !servers[1].Enable {
		t.Fatalf("servers = %+v, want on_demand read and defaulting to false", servers)
	}
}
