package llmstats

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// appendWhileReading appends records with one cache detail each until the returned stop is
// called, which reports the writer's error.
func appendWhileReading(t *testing.T, s *UsageStore) func() {
	t.Helper()
	stop := make(chan struct{})
	errs := make(chan error, 1)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				errs <- nil
				return
			default:
			}
			model := "model-a"
			if i%2 == 1 {
				model = "model-b"
			}
			if err := s.Append(RequestRecord{TS: time.Now().UTC().Format(time.RFC3339Nano), Provider: "openai", Model: model,
				APIHost: "example.test", Operation: "chat", InputTokens: 1, TotalTokens: 1,
				CacheDetails: map[string]int64{"hit": 1}}); err != nil {
				errs <- err
				return
			}
		}
	}()
	return func() {
		close(stop)
		wg.Wait()
		if err := <-errs; err != nil {
			t.Errorf("writer: %v", err)
		}
	}
}

// One usage response is one snapshot: the overall totals, the totals by model, by host and model,
// and the cache details agree even while calls are being recorded.
func TestUsageIsOneSnapshot(t *testing.T) {
	ctx := context.Background()
	s, err := OpenUsageStore(ctx, filepath.Join(t.TempDir(), "usage.db"), UsageStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	stop := appendWhileReading(t, s)
	defer stop()

	for i := 0; i < 300; i++ {
		p, err := s.Usage(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var models, hosts int64
		for _, m := range p.Models {
			models += m.Requests
		}
		for _, h := range p.APIHosts {
			hosts += h.Requests
		}
		if models != p.Summary.Requests || hosts != p.Summary.Requests {
			t.Fatalf("requests: overall %d, by model %d, by host %d", p.Summary.Requests, models, hosts)
		}
		if got := p.Summary.CacheDetails["hit"]; got != p.Summary.Requests {
			t.Fatalf("overall requests %d with %d cache hits, one per request", p.Summary.Requests, got)
		}
	}
}

// One daily response is one snapshot too: each day's totals and cache details agree.
func TestDailyIsOneSnapshot(t *testing.T) {
	ctx := context.Background()
	s, err := OpenUsageStore(ctx, filepath.Join(t.TempDir(), "usage.db"), UsageStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	stop := appendWhileReading(t, s)
	defer stop()

	for i := 0; i < 300; i++ {
		d, err := s.Daily(ctx, 2, time.UTC)
		if err != nil {
			t.Fatal(err)
		}
		for _, day := range d.Days {
			for _, m := range day.Models {
				if got := m.CacheDetails["hit"]; got != m.Requests {
					t.Fatalf("%s %s: %d requests with %d cache hits, one per request", day.Date, m.Model, m.Requests, got)
				}
			}
		}
	}
}

// An empty store, and a canceled request, still answer as before.
func TestUsageQueriesOfNothing(t *testing.T) {
	ctx := context.Background()
	s, err := OpenUsageStore(ctx, filepath.Join(t.TempDir(), "usage.db"), UsageStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p, err := s.Usage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if p.Summary.Requests != 0 || len(p.Models) != 0 || len(p.APIHosts) != 0 {
		t.Fatalf("usage of an empty store = %+v", p)
	}
	d, err := s.Daily(ctx, 3, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Days) != 3 || d.Summary.Requests != 0 {
		t.Fatalf("daily of an empty store = %+v", d)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.Usage(canceled); err == nil {
		t.Fatal("Usage with a canceled context succeeded")
	}
	if _, err := s.Daily(canceled, 3, time.UTC); err == nil {
		t.Fatal("Daily with a canceled context succeeded")
	}
	var closed *UsageStore
	if _, err := closed.Usage(ctx); err == nil {
		t.Fatal("Usage of no store succeeded")
	}
}
