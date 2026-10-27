package daemonruntime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/domainjournal"
	"github.com/quailyquaily/mistermorph/internal/memories"
)

// registerMemoryRoutes serves memories and journal search to the Console. The Console is the
// owner's, so these routes hear everything: every memory, whatever its visibility, and every
// journal event.
func (routes *routeRegistration) registerMemoryRoutes() {
	mux := routes.mux
	authToken := routes.authToken
	paths := routes.paths

	mux.HandleFunc("/memories", func(w http.ResponseWriter, r *http.Request) {
		if !checkAuth(r, authToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if strings.TrimSpace(paths.MemoryDBPath) == "" {
			http.Error(w, "memories are unavailable", http.StatusServiceUnavailable)
			return
		}
		store, err := memories.Open(r.Context(), paths.MemoryDBPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer func() { _ = store.Close() }()

		switch r.Method {
		case http.MethodGet:
			query := r.URL.Query()
			subject := strings.TrimSpace(query.Get("subject"))
			text := strings.TrimSpace(query.Get("q"))
			var items []memories.Memory
			if subject == "" && text == "" {
				items, err = store.List(r.Context())
			} else {
				items, _, err = store.SearchAsOwner(r.Context(), memories.SearchOptions{Query: text, Subject: subject, Limit: 1000})
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if items == nil {
				items = []memories.Memory{}
			}
			writeJSON(w, map[string]any{"items": items})
		case http.MethodPut:
			var payload struct {
				ID string `json:"id"`
				memories.Edit
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				http.Error(w, "invalid json body", http.StatusBadRequest)
				return
			}
			item, ok, err := store.EditAsOwner(r.Context(), payload.ID, payload.Edit)
			var ruleErr *memories.RuleError
			switch {
			case errors.As(err, &ruleErr):
				http.Error(w, err.Error(), http.StatusBadRequest)
			case err != nil:
				http.Error(w, err.Error(), http.StatusInternalServerError)
			case !ok:
				http.Error(w, "memory not found", http.StatusNotFound)
			default:
				writeJSON(w, map[string]any{"item": item})
			}
		case http.MethodDelete:
			id := strings.TrimSpace(r.URL.Query().Get("id"))
			if id == "" {
				http.Error(w, "id is required", http.StatusBadRequest)
				return
			}
			deleted, err := store.ForgetAsOwner(r.Context(), id)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if !deleted {
				http.Error(w, "memory not found", http.StatusNotFound)
				return
			}
			writeJSON(w, map[string]any{"deleted": true, "id": id})
		default:
			w.Header().Set("Allow", "GET, PUT, DELETE")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/journal/search", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !checkAuth(r, authToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		query := r.URL.Query()
		since, err := parseJournalSearchTime(query.Get("since"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		until, err := parseJournalSearchTime(query.Get("until"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		limit, _ := strconv.Atoi(strings.TrimSpace(query.Get("limit")))
		journal, err := domainjournal.New(domainjournal.JournalOptions{Dir: paths.JournalDir})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer func() { _ = journal.Close() }()
		hits, more, err := journal.Search(domainjournal.SearchOptions{
			Query:        query.Get("q"),
			AllAudiences: true,
			Since:        since,
			Until:        until,
			Domain:       query.Get("domain"),
			Limit:        limit,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		type eventView struct {
			Seq      int64               `json:"seq"`
			ID       string              `json:"id"`
			Time     string              `json:"time"`
			Domain   string              `json:"domain"`
			Type     string              `json:"type"`
			Trace    domainjournal.Trace `json:"trace"`
			Audience string              `json:"audience,omitempty"`
			Text     string              `json:"text"`
		}
		events := make([]eventView, 0, len(hits))
		for _, hit := range hits {
			events = append(events, eventView{
				Seq: hit.Ref.Seq, ID: hit.ID, Time: hit.Time, Domain: hit.Domain, Type: hit.Type, Trace: hit.Trace,
				Audience: hit.Audience, Text: hit.Text,
			})
		}
		writeJSON(w, map[string]any{"events": events, "has_more": more})
	})
}

func deleteContactMemories(ctx context.Context, memoryDBPath, contactID string) (int64, error) {
	subject := audience.Contact(contactID).String()
	if strings.TrimSpace(memoryDBPath) == "" || subject == "" {
		return 0, nil
	}
	store, err := memories.Open(ctx, memoryDBPath)
	if err != nil {
		return 0, err
	}
	defer func() { _ = store.Close() }()
	return store.DeleteSubject(ctx, subject)
}

func parseJournalSearchTime(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02", raw); err == nil {
		return t, nil
	}
	return time.Time{}, BadRequest("time must be RFC 3339 or YYYY-MM-DD")
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
