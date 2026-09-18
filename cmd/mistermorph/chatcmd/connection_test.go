package chatcmd

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/tools"
)

func TestChatRuntimeConnection(t *testing.T) {
	for _, tt := range []struct {
		name, envToken                string
		args                          []string
		wantURL, wantToken, wantError string
		local                         bool
	}{
		{name: "default without configured token", local: true},
		{name: "remote environment does not replace local credentials", envToken: "remote-token", local: true},
		{name: "topic without URL", args: []string{"--topic", "topic-1"}, local: true},
		{name: "explicit remote", args: []string{"--runtime-url", "https://morph.example.com/nested/runtime"}, envToken: "remote-token", wantURL: "https://morph.example.com/nested/runtime", wantToken: "remote-token"},
		{name: "explicit URL never inherits local secret", args: []string{"--runtime-url", "https://morph.example.com/runtime"}, wantError: runtimeTokenEnv},
		{name: "empty explicit URL", args: []string{"--runtime-url", ""}, wantError: "must not be empty"},
		{name: "local model override", args: []string{"--model", "local"}, local: true},
		{name: "local workspace override", args: []string{"--workspace", "/work/project"}, local: true},
		{name: "standalone", args: []string{"--standalone", "--model", "local"}, local: true},
		{name: "standalone topic", args: []string{"--standalone", "--topic", "topic-1"}, local: true},
		{name: "standalone URL", args: []string{"--standalone", "--runtime-url", "http://localhost/runtime"}, wantError: "--standalone"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(runtimeTokenEnv, tt.envToken)
			cmd := New(Dependencies{})
			if err := cmd.ParseFlags(tt.args); err != nil {
				t.Fatal(err)
			}
			client, err := chatRuntimeClient(cmd)
			if tt.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantError) {
					t.Fatalf("error = %v, want %q", err, tt.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tt.local {
				if client != nil {
					t.Fatal("standalone created a runtime client")
				}
				return
			}
			if client == nil || client.base != tt.wantURL || client.token != tt.wantToken {
				t.Fatalf("client = %+v, want URL %q and selected token", client, tt.wantURL)
			}
		})
	}
}

func TestExplicitRemoteChatConnectsWithoutBuildingLocalSession(t *testing.T) {
	t.Setenv(runtimeTokenEnv, "automatic-token")
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer automatic-token" {
			t.Error("default chat did not authenticate with discovered token")
		}
		if r.URL.Path == "/nested/runtime/health" {
			fmt.Fprint(w, `{"mode":"console"}`)
			return
		}
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	localBuilt := false
	cmd := New(Dependencies{RegistryFromViper: func() *tools.Registry {
		localBuilt = true
		return tools.NewRegistry()
	}})
	cmd.SetArgs([]string{"--runtime-url", server.URL + "/nested/runtime"})
	cmd.SilenceErrors, cmd.SilenceUsage = true, true
	err := cmd.Execute()
	var remoteErr *remoteHTTPError
	if !errors.As(err, &remoteErr) || remoteErr.status != http.StatusServiceUnavailable {
		t.Fatalf("error = %v, want runtime unavailable", err)
	}
	if localBuilt || strings.Join(paths, ",") != "/nested/runtime/health,/nested/runtime/topics" {
		t.Fatalf("local session = %v, requests = %v", localBuilt, paths)
	}
}

func TestDefaultChatDoesNotConnectToConsole(t *testing.T) {
	t.Setenv(runtimeTokenEnv, "remote-token")
	client, err := chatRuntimeClient(New(Dependencies{}))
	if client != nil || err != nil {
		t.Fatalf("default chat should execute locally: client=%v error=%v", client, err)
	}
}
