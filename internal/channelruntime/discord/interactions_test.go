package discord

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/discordapi"
)

func TestSlashCommandsAreValidDiscordCommands(t *testing.T) {
	seen := map[string]bool{}
	for _, command := range discordSlashCommands() {
		if len(command.Name) == 0 || len(command.Name) > 32 || command.Name != stringsToLower(command.Name) || seen[command.Name] {
			t.Errorf("bad command name %q", command.Name)
		}
		seen[command.Name] = true
		if len(command.Description) == 0 || len(command.Description) > 100 {
			t.Errorf("%s: description length %d", command.Name, len(command.Description))
		}
		if len(command.Contexts) != 2 {
			t.Errorf("%s: contexts %v", command.Name, command.Contexts)
		}
	}
	for _, name := range []string{"models", "think", "stop", "approve", "deny", "pair", "id", "reset"} {
		if !seen[name] {
			t.Errorf("missing /%s", name)
		}
	}
}

func stringsToLower(s string) string {
	out := []rune(s)
	for i, r := range out {
		if r >= 'A' && r <= 'Z' {
			out[i] = r + 32
		}
	}
	return string(out)
}

func TestSlashCommandBecomesAnAddressedMessage(t *testing.T) {
	interaction := discordapi.Interaction{
		ID: "700", Token: "tok", Type: discordapi.InteractionTypeApplicationCommand, GuildID: "100", ChannelID: "200",
		Member: &discordapi.InteractionMember{User: discordapi.User{ID: "5", Username: "ann"}, Nick: "Annie"},
		Data: discordapi.InteractionData{Name: "pair", Options: []discordapi.InteractionOption{
			{Name: "agent", Type: discordapi.CommandOptionUser, Value: json.RawMessage(`"77"`)},
		}},
	}
	msg, ok := discordSlashCommandMessage(interaction, "42", time.Unix(5, 0))
	if !ok || msg.ID != "700" || msg.Content != "/pair <@77>" || msg.Author.ID != "5" || msg.Member.Nick != "Annie" {
		t.Fatalf("message = %+v", msg)
	}
	ingress := newTestIngress(&fakeDiscordAPI{}, t.TempDir())
	inbound, _, publish, err := ingress.Normalize(context.Background(), msg)
	if err != nil || !publish || !discordAddressed(inbound, "42") {
		t.Fatalf("Normalize() = %+v, %v, %v", inbound, publish, err)
	}
	think := discordapi.InteractionData{Name: "think", Options: []discordapi.InteractionOption{{Name: "args", Type: discordapi.CommandOptionString, Value: json.RawMessage(`"plan a trip"`)}}}
	if got := discordSlashCommandText(think); got != "/think plan a trip" {
		t.Fatalf("text = %q", got)
	}
}

func TestInteractionRepliesFillThePlaceholderOnce(t *testing.T) {
	api := &fakeDiscordAPI{}
	replies := newDiscordInteractionReplies(api, testLogger)
	replies.setApplicationID("42")
	replies.add("700", "tok")
	if !replies.known("700") {
		t.Fatal("interaction not known")
	}
	if err := replies.send(context.Background(), "200", "first", "700"); err != nil {
		t.Fatal(err)
	}
	if err := replies.send(context.Background(), "200", "second", "700"); err != nil {
		t.Fatal(err)
	}
	if len(api.responseEdits) != 1 || api.responseEdits[0] != "42/tok/first" {
		t.Fatalf("edits = %v", api.responseEdits)
	}
	// The second reply is a message that refers to the answer, not to the interaction ID.
	if len(api.created) != 1 || api.created[0].Message.MessageReference == nil || api.created[0].Message.MessageReference.MessageID != "8000" {
		t.Fatalf("created = %+v", api.created)
	}
	replies.finish(context.Background(), "700")
	if len(api.responseDeletes) != 0 {
		t.Fatal("an answered placeholder was deleted")
	}
}

func TestInteractionPlaceholderWithoutAnswerIsDeleted(t *testing.T) {
	api := &fakeDiscordAPI{}
	replies := newDiscordInteractionReplies(api, testLogger)
	replies.setApplicationID("42")
	replies.add("700", "tok")
	replies.finish(context.Background(), "700")
	replies.finish(context.Background(), "700")
	if len(api.responseDeletes) != 1 {
		t.Fatalf("deletes = %v", api.responseDeletes)
	}
}

func TestExpiredInteractionFallsBackToAMessage(t *testing.T) {
	api := &fakeDiscordAPI{}
	replies := newDiscordInteractionReplies(api, testLogger)
	now := time.Unix(1000, 0)
	replies.now = func() time.Time { return now }
	replies.setApplicationID("42")
	replies.add("700", "tok")
	now = now.Add(20 * time.Minute)
	if err := replies.send(context.Background(), "200", "late", "700"); err != nil {
		t.Fatal(err)
	}
	if len(api.responseEdits) != 0 || len(api.created) != 1 {
		t.Fatalf("edits=%v created=%d", api.responseEdits, len(api.created))
	}
}
