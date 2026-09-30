package discordapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestSetGlobalCommandsReplacesTheList(t *testing.T) {
	client, _, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/v10/applications/42/commands" || r.Header.Get("Authorization") != "Bot bot-token" {
			t.Errorf("request = %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		var body []map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body) != 1 || body[0]["name"] != "models" {
			t.Errorf("body = %v, %v", body, err)
		}
		_, _ = io.WriteString(w, `[]`)
	})
	err := client.SetGlobalCommands(context.Background(), "42", []ApplicationCommand{{
		Name: "models", Description: "Inspect or change the model", Contexts: []int{InteractionContextGuild, InteractionContextBotDM},
		Options: []ApplicationCommandOption{{Type: CommandOptionString, Name: "args", Description: "Arguments"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestInteractionResponseEditAndDeleteUseTheTokenOnly(t *testing.T) {
	var methods []string
	client, _, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v10/webhooks/42/tok-en/messages/@original" || r.Header.Get("Authorization") != "" {
			t.Errorf("request = %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		methods = append(methods, r.Method)
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		_, _ = io.WriteString(w, `{"id":"900","channel_id":"200","content":"done"}`)
	})
	content := "done"
	message, err := client.EditInteractionResponse(context.Background(), "42", "tok-en", MessageEdit{Content: &content})
	if err != nil || message.ID != "900" {
		t.Fatalf("EditInteractionResponse = %+v, %v", message, err)
	}
	if err := client.DeleteInteractionResponse(context.Background(), "42", "tok-en"); err != nil {
		t.Fatal(err)
	}
	if len(methods) != 2 || methods[0] != http.MethodPatch || methods[1] != http.MethodDelete {
		t.Fatalf("methods = %v", methods)
	}
}

func TestInteractionOptionStringValue(t *testing.T) {
	for raw, want := range map[string]string{`"gpt-5"`: "gpt-5", `"123"`: "123", `42`: "42", `true`: "true", ``: "", `null`: ""} {
		if got := (InteractionOption{Value: json.RawMessage(raw)}).StringValue(); got != want {
			t.Errorf("StringValue(%s) = %q, want %q", raw, got, want)
		}
	}
}
