package skillinstall

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestStoreIndexFetchValidateAndCache(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_ = json.NewEncoder(w).Encode(StoreIndex{Version: 1, Repo: "quailyquaily/morph-skill-store", Skills: []StoreSkill{
			{ID: "zeta", Name: "Zeta", Version: "1.0.0", Path: "skills/zeta", Commit: testCommit, Files: map[string]string{"SKILL.md": "aa"}},
			{ID: "alpha", Name: "alpha", Version: "0.2.0", Path: "skills/alpha", Commit: testCommit, Files: map[string]string{"SKILL.md": "bb", "run.sh": "cc"}},
			{ID: "Bad ID", Name: "bad", Path: "skills/bad", Commit: testCommit, Files: map[string]string{"SKILL.md": "dd"}},
			{ID: "nocommit", Name: "x", Path: "skills/x", Commit: "main", Files: map[string]string{"SKILL.md": "ee"}},
			{ID: "noskill", Name: "y", Path: "skills/y", Commit: testCommit, Files: map[string]string{"README.md": "ff"}},
			{ID: "escape", Name: "z", Path: "../etc", Commit: testCommit, Files: map[string]string{"SKILL.md": "gg"}},
		}})
	}))
	defer server.Close()
	store := NewStore(server.Client())

	index, _, err := store.Index(context.Background(), server.URL)
	if err != nil {
		t.Fatalf("Index() error = %v", err)
	}
	var ids []string
	for _, skill := range index.Skills {
		ids = append(ids, skill.ID)
	}
	if strings.Join(ids, ",") != "alpha,zeta" {
		t.Fatalf("ids = %v, want valid entries sorted by name", ids)
	}
	alpha, ok := index.Find("ALPHA")
	if !ok || alpha.Link(index.Repo) != "https://github.com/quailyquaily/morph-skill-store/tree/"+testCommit+"/skills/alpha" {
		t.Fatalf("Find/Link = %+v", alpha)
	}
	exp := alpha.Expectation()
	if exp.Source.Commit != testCommit || exp.Source.StoreID != "alpha" || exp.Source.Version != "0.2.0" || len(exp.Files) != 2 {
		t.Fatalf("expectation = %+v", exp)
	}
	if _, _, err := store.Index(context.Background(), server.URL); err != nil || hits.Load() != 1 {
		t.Fatalf("second Index() hits = %d, err = %v, want cached", hits.Load(), err)
	}
}

func TestStoreIndexUnavailable(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	if _, _, err := NewStore(server.Client()).Index(context.Background(), server.URL); !errors.Is(err, ErrStoreUnavailable) {
		t.Fatalf("Index(404) error = %v", err)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"repo":"not a repo"}`)) }))
	defer bad.Close()
	if _, _, err := NewStore(bad.Client()).Index(context.Background(), bad.URL); !errors.Is(err, ErrStoreUnavailable) {
		t.Fatalf("Index(bad repo) error = %v", err)
	}
}
