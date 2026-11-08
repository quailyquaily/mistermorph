package builtin

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/quailyquaily/mistermorph/contacts"
)

func TestContactsListFiltersByStatusKindAndChannel(t *testing.T) {
	ctx := context.Background()
	// A contacts folder nested below the state folder (contacts.dir_name: address/people) is kept
	// in the state folder's agent.db.
	state := t.TempDir()
	dir := filepath.Join(state, "address", "people")
	store := contacts.NewStoreInStateDir(state, dir)
	for _, c := range []contacts.Contact{
		{ContactID: "tg:1", Kind: contacts.KindHuman, Channel: contacts.ChannelTelegram, ContactNickname: "Ann", TGUserID: 1},
		{ContactID: "mm:inst_a", Kind: contacts.KindAgent, Channel: contacts.ChannelAgentLink, ContactNickname: "Bot"},
		{ContactID: "slack:T1:U2", Kind: contacts.KindHuman, Channel: contacts.ChannelSlack, SlackTeamID: "T1", SlackUserID: "U2"},
	} {
		if err := store.PutContact(ctx, c); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.SetContactStatus(ctx, "slack:T1:U2", contacts.StatusInactive); err != nil {
		t.Fatal(err)
	}
	tool := NewContactsListTool(state, dir)
	run := func(params map[string]any) []string {
		t.Helper()
		out, err := tool.Execute(ctx, params)
		if err != nil {
			t.Fatalf("Execute(%v): %v", params, err)
		}
		var payload struct {
			Contacts []struct {
				ContactID string `json:"contact_id"`
				Status    string `json:"status"`
			} `json:"contacts"`
		}
		if err := json.Unmarshal([]byte(out), &payload); err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, c := range payload.Contacts {
			ids = append(ids, c.ContactID+"/"+c.Status)
		}
		return ids
	}
	if got := run(map[string]any{}); len(got) != 2 || got[0] != "mm:inst_a/active" || got[1] != "tg:1/active" {
		t.Fatalf("active = %v", got)
	}
	if got := run(map[string]any{"status": "inactive"}); len(got) != 1 || got[0] != "slack:T1:U2/inactive" {
		t.Fatalf("inactive = %v", got)
	}
	if got := run(map[string]any{"status": "all", "kind": "agent"}); len(got) != 1 || got[0] != "mm:inst_a/active" {
		t.Fatalf("agents = %v", got)
	}
	if got := run(map[string]any{"status": "all", "channel": "telegram"}); len(got) != 1 || got[0] != "tg:1/active" {
		t.Fatalf("telegram = %v", got)
	}
	if got := run(map[string]any{"status": "all", "limit": float64(1)}); len(got) != 1 {
		t.Fatalf("limit = %v", got)
	}
	if _, err := tool.Execute(ctx, map[string]any{"kind": "robot"}); err == nil {
		t.Fatal("bad kind accepted")
	}
	available, err := AgentSendAvailableInStateDir(ctx, state, dir)
	if err != nil || !available {
		t.Fatalf("AgentSendAvailableInStateDir = %v, %v", available, err)
	}
}

// AgentSendAvailable, for a contacts folder directly in its state folder, keeps working as before.
func TestAgentSendAvailableBesideTheContactsFolder(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "contacts")
	if available, err := AgentSendAvailable(ctx, dir); err != nil || available {
		t.Fatalf("AgentSendAvailable with no contacts = %v, %v", available, err)
	}
	if err := contacts.NewStore(dir).PutContact(ctx, contacts.Contact{ContactID: "mm:inst_a", Kind: contacts.KindAgent,
		Channel: contacts.ChannelAgentLink}); err != nil {
		t.Fatal(err)
	}
	if available, err := AgentSendAvailable(ctx, dir); err != nil || !available {
		t.Fatalf("AgentSendAvailable = %v, %v", available, err)
	}
	if available, err := AgentSendAvailable(ctx, " "); err != nil || available {
		t.Fatalf("AgentSendAvailable without a folder = %v, %v", available, err)
	}
}
