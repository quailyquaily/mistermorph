package daemonruntime

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/personastore"
)

const personaBodyLimit = 4 << 20

func writePersonaJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// handlePersonaFileDetail serves identity.yaml, soul.md and HEARTBEAT.md, which are rows of
// agent.db, rendered in the shapes the files had; a save parses the text back into the rows. They
// stay for one release, for clients that still edit the files.
func handlePersonaFileDetail(w http.ResponseWriter, r *http.Request, spec stateFileSpec) {
	ctx := r.Context()
	store, err := personastore.ForStateDir(ctx, spec.StateDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	switch r.Method {
	case http.MethodGet:
		content := ""
		switch spec.Kind {
		case stateFileIdentity, stateFileSoul:
			id, ok, err := store.Identity(ctx)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if !ok || (spec.Kind == stateFileSoul && strings.TrimSpace(id.Soul) == "") {
				http.Error(w, "file not found", http.StatusNotFound)
				return
			}
			if spec.Kind == stateFileIdentity {
				content = personastore.RenderIdentityYAML(id)
			} else {
				content = personastore.RenderSoul(id.Soul)
			}
		case stateFileHeartbeat:
			items, err := store.Workflows(ctx)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			content = personastore.RenderChecklist(items)
		}
		writePersonaJSON(w, http.StatusOK, map[string]any{"name": spec.Name, "content": content})
	case http.MethodPut:
		var req struct {
			Content string `json:"content"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, personaBodyLimit)).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		switch spec.Kind {
		case stateFileIdentity:
			parsed, err := personastore.ParseIdentityYAML(req.Content)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			_, err = store.PatchIdentity(ctx, personastore.IdentityPatch{Name: &parsed.Name, NameAlts: &parsed.NameAlts,
				Creature: &parsed.Creature, Vibe: &parsed.Vibe, Emoji: &parsed.Emoji, Extra: &parsed.Extra}, personastore.ByConsole)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		case stateFileSoul:
			soul := personastore.ParseSoul(req.Content)
			if _, err := store.PatchIdentity(ctx, personastore.IdentityPatch{Soul: &soul}, personastore.ByConsole); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		case stateFileHeartbeat:
			existing, err := store.Workflows(ctx)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			parsed := personastore.MatchWorkflowIDs(personastore.ParseChecklist(req.Content), existing)
			if _, err := store.ReplaceWorkflows(ctx, parsed); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
		writePersonaJSON(w, http.StatusOK, map[string]any{"ok": true, "name": spec.Name})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handlePersonaIdentity is /persona/identity: GET returns the identity, its soul included; PUT
// changes the fields the body names and leaves the others.
func handlePersonaIdentity(w http.ResponseWriter, r *http.Request, stateDir string) {
	ctx := r.Context()
	store, err := personastore.ForStateDir(ctx, stateDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	switch r.Method {
	case http.MethodGet:
		id, ok, err := store.Identity(ctx)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !ok {
			id = personastore.Identity{NameAlts: []string{}, Extra: personastore.Extra{}}
		}
		writePersonaJSON(w, http.StatusOK, map[string]any{"exists": ok, "identity": id})
	case http.MethodPut, http.MethodPatch:
		var patch personastore.IdentityPatch
		dec := json.NewDecoder(io.LimitReader(r.Body, personaBodyLimit))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&patch); err != nil {
			http.Error(w, "invalid json body: "+err.Error(), http.StatusBadRequest)
			return
		}
		id, err := store.PatchIdentity(ctx, patch, personastore.ByConsole)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writePersonaJSON(w, http.StatusOK, map[string]any{"exists": true, "identity": id})
	default:
		w.Header().Set("Allow", "GET, PUT, PATCH")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

type workflowInput struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Instructions string `json:"instructions"`
	Enabled      *bool  `json:"enabled"`
}

func (in workflowInput) workflow() personastore.Workflow {
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	return personastore.Workflow{ID: in.ID, Title: in.Title, Instructions: in.Instructions, Enabled: enabled}
}

func writeWorkflows(w http.ResponseWriter, items []personastore.Workflow) {
	text, empty := personastore.HeartbeatTask(items)
	writePersonaJSON(w, http.StatusOK, map[string]any{"items": items, "task": text, "task_empty": empty})
}

// handleHeartbeatWorkflows is /heartbeat/workflows: GET lists the workflows in order with the
// task a tick would run; PUT {"items": [...]} replaces the list in that order (an item with an id
// keeps its row); POST adds one, at "position" when given.
func handleHeartbeatWorkflows(w http.ResponseWriter, r *http.Request, stateDir string) {
	ctx := r.Context()
	store, err := personastore.ForStateDir(ctx, stateDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	switch r.Method {
	case http.MethodGet:
		items, err := store.Workflows(ctx)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeWorkflows(w, items)
	case http.MethodPut:
		var req struct {
			Items []workflowInput `json:"items"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, personaBodyLimit)).Decode(&req); err != nil {
			http.Error(w, "invalid json body", http.StatusBadRequest)
			return
		}
		list := make([]personastore.Workflow, 0, len(req.Items))
		for _, item := range req.Items {
			list = append(list, item.workflow())
		}
		items, err := store.ReplaceWorkflows(ctx, list)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeWorkflows(w, items)
	case http.MethodPost:
		var req struct {
			workflowInput
			Position *int `json:"position"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, personaBodyLimit)).Decode(&req); err != nil {
			http.Error(w, "invalid json body", http.StatusBadRequest)
			return
		}
		position := -1
		if req.Position != nil {
			position = *req.Position
		}
		item, err := store.AddWorkflow(ctx, req.workflow(), position)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writePersonaJSON(w, http.StatusCreated, map[string]any{"item": item})
	default:
		w.Header().Set("Allow", "GET, PUT, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleHeartbeatWorkflow is /heartbeat/workflows/{id}: GET, PATCH (title, instructions, enabled,
// position) and DELETE.
func handleHeartbeatWorkflow(w http.ResponseWriter, r *http.Request, stateDir, id string) {
	ctx := r.Context()
	if id == "" || strings.Contains(id, "/") {
		http.Error(w, "invalid workflow id", http.StatusBadRequest)
		return
	}
	store, err := personastore.ForStateDir(ctx, stateDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	notFound := func(err error) bool {
		if errors.Is(err, personastore.ErrWorkflowNotFound) {
			http.Error(w, err.Error(), http.StatusNotFound)
			return true
		}
		return false
	}
	switch r.Method {
	case http.MethodGet:
		item, err := store.Workflow(ctx, id)
		if notFound(err) {
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writePersonaJSON(w, http.StatusOK, map[string]any{"item": item})
	case http.MethodPatch, http.MethodPut:
		var patch personastore.WorkflowPatch
		dec := json.NewDecoder(io.LimitReader(r.Body, personaBodyLimit))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&patch); err != nil {
			http.Error(w, "invalid json body: "+err.Error(), http.StatusBadRequest)
			return
		}
		item, err := store.UpdateWorkflow(ctx, id, patch)
		if notFound(err) {
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writePersonaJSON(w, http.StatusOK, map[string]any{"item": item})
	case http.MethodDelete:
		if err := store.DeleteWorkflow(ctx, id); notFound(err) {
			return
		} else if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, PATCH, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
