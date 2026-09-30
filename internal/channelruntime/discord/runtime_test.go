package discord

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	discordbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/discord"
	"github.com/quailyquaily/mistermorph/internal/discordapi"
	discordtools "github.com/quailyquaily/mistermorph/tools/discord"
)

var testLogger = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestNormalizeRunOptionsDefaultsToStrict(t *testing.T) {
	opts := normalizeRunOptions(RunOptions{GroupTriggerMode: "loud", AllowedUserIDs: []string{" 1 ", "1", ""}})
	if opts.GroupTriggerMode != groupTriggerStrict || opts.ServerListen != DefaultServerListen || opts.BaseURL != discordapi.DefaultAPIBaseURL {
		t.Fatalf("options = %+v", opts)
	}
	if len(opts.AllowedUserIDs) != 1 || opts.AddressingConfidenceThreshold != 0.6 {
		t.Fatalf("options = %+v", opts)
	}
	if gatewayIntents(groupTriggerStrict)&discordapi.IntentMessageContent != 0 {
		t.Fatal("strict mode must not ask for the privileged Message Content intent")
	}
	if gatewayIntents(groupTriggerSmart)&discordapi.IntentMessageContent == 0 {
		t.Fatal("smart mode needs the Message Content intent")
	}
}

func TestDiscordAllowlist(t *testing.T) {
	if _, err := newDiscordAllowlist(nil, []string{"general"}, nil); err == nil {
		t.Fatal("a channel name was accepted as an ID")
	}
	open, err := newDiscordAllowlist(nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !open.dmAllowed("5", false, false) || open.dmAllowed("5", true, false) || !open.dmAllowed("5", true, true) {
		t.Fatal("an empty user list allows people, and bots only when paired")
	}
	if !open.serverAllowed("100", discordapi.Channel{ID: "200"}) {
		t.Fatal("empty server lists allow everything")
	}
	listed, err := newDiscordAllowlist([]string{"100"}, []string{"200"}, []string{"5"})
	if err != nil {
		t.Fatal(err)
	}
	thread := discordapi.Channel{ID: "300", ParentID: "200", Type: discordapi.ChannelTypePublicThread}
	for name, tc := range map[string]struct {
		guild   string
		channel discordapi.Channel
		want    bool
	}{
		"listed channel":            {"100", discordapi.Channel{ID: "200"}, true},
		"thread of a listed parent": {"100", thread, true},
		"other channel":             {"100", discordapi.Channel{ID: "201"}, false},
		"other server":              {"101", discordapi.Channel{ID: "200"}, false},
	} {
		if got := listed.serverAllowed(tc.guild, tc.channel); got != tc.want {
			t.Errorf("%s: serverAllowed = %v, want %v", name, got, tc.want)
		}
	}
	if !listed.dmAllowed("5", false, false) || listed.dmAllowed("6", false, false) {
		t.Fatal("DM user allowlist not applied")
	}
}

func newTestIngress(api *fakeDiscordAPI, cacheDir string) *discordIngress {
	ingress := newDiscordIngress(api, "42", cacheDir, testLogger)
	ingress.rememberGuild(discordapi.Guild{ID: "100", Name: "Lab", Channels: []discordapi.Channel{{ID: "200", Name: "general"}}})
	return ingress
}

func TestIngressNormalizesAServerMention(t *testing.T) {
	api := &fakeDiscordAPI{downloads: map[string][]byte{"https://cdn.discordapp.com/a.png": []byte("PNG")}}
	cacheDir := t.TempDir()
	ingress := newTestIngress(api, cacheDir)
	msg := discordapi.Message{
		ID: "300", ChannelID: "200", GuildID: "100", Content: "<@42> look at\nthis <@7>", Timestamp: time.Unix(10, 0),
		Author: discordapi.User{ID: "5", Username: "ann", GlobalName: "Ann"}, Member: &discordapi.Member{Nick: "Annie"},
		Mentions: []discordapi.User{{ID: "42"}, {ID: "7"}},
		Attachments: []discordapi.Attachment{
			{ID: "501", Filename: "a.png", ContentType: "image/png", Size: 3, URL: "https://cdn.discordapp.com/a.png"},
			{ID: "502", Filename: "notes.pdf", ContentType: "application/pdf", Size: 2048},
		},
	}
	inbound, channel, publish, err := ingress.Normalize(context.Background(), msg)
	if err != nil || !publish {
		t.Fatalf("Normalize() = %v, %v", publish, err)
	}
	if inbound.ChatType != discordbus.ChatTypeGroup || inbound.DisplayName != "Annie" || !discordAddressed(inbound, "42") {
		t.Fatalf("inbound = %+v", inbound)
	}
	if inbound.Text != "look at\nthis <@7>\n[attachment: notes.pdf (2.0 KB)]" {
		t.Fatalf("text = %q", inbound.Text)
	}
	if len(inbound.ImageAttachments) != 1 {
		t.Fatalf("images = %+v", inbound.ImageAttachments)
	}
	if raw, err := os.ReadFile(inbound.ImageAttachments[0].Path); err != nil || string(raw) != "PNG" {
		t.Fatalf("image file = %q, %v", raw, err)
	}
	if got := ingress.chatName(inbound, channel); got != "Lab #general" {
		t.Fatalf("chat name = %q", got)
	}
}

func TestIngressMarksARepliedBotMessageAsAddressed(t *testing.T) {
	ingress := newTestIngress(&fakeDiscordAPI{}, t.TempDir())
	inbound, _, publish, err := ingress.Normalize(context.Background(), discordapi.Message{
		ID: "301", ChannelID: "200", GuildID: "100", Content: "and then?", Type: discordapi.MessageTypeReply,
		Author:            discordapi.User{ID: "5", Username: "ann"},
		MessageReference:  &discordapi.MessageReference{MessageID: "299", ChannelID: "200"},
		ReferencedMessage: &discordapi.Message{ID: "299", Author: discordapi.User{ID: "42"}},
	})
	if err != nil || !publish || !discordAddressed(inbound, "42") || inbound.ReplyToMessageID != "299" {
		t.Fatalf("Normalize() = %+v, %v, %v", inbound, publish, err)
	}
}

func TestIngressSkipsWhatItDoesNotHandle(t *testing.T) {
	ingress := newTestIngress(&fakeDiscordAPI{}, t.TempDir())
	ingress.authorize = func(_ context.Context, inbound discordbus.InboundMessage, _ discordapi.Channel) (bool, error) {
		return inbound.UserID != "9", nil
	}
	for name, msg := range map[string]discordapi.Message{
		"own message":        {ID: "1", ChannelID: "200", GuildID: "100", Content: "hi", Author: discordapi.User{ID: "42"}},
		"webhook":            {ID: "2", ChannelID: "200", GuildID: "100", Content: "hi", Author: discordapi.User{ID: "5"}, WebhookID: "8"},
		"system message":     {ID: "3", ChannelID: "200", GuildID: "100", Content: "joined", Type: 7, Author: discordapi.User{ID: "5"}},
		"another server bot": {ID: "4", ChannelID: "200", GuildID: "100", Content: "<@42> hi", Author: discordapi.User{ID: "6", Bot: true}},
		"not allowed":        {ID: "5", ChannelID: "600", Content: "hi", Author: discordapi.User{ID: "9"}},
		"only a mention":     {ID: "6", ChannelID: "200", GuildID: "100", Content: "<@42>", Author: discordapi.User{ID: "5"}},
	} {
		if _, _, publish, err := ingress.Normalize(context.Background(), msg); publish || err != nil {
			t.Errorf("%s: publish=%v err=%v", name, publish, err)
		}
	}
}

func TestStrictTriggerAcceptsOnlyAddressedMessages(t *testing.T) {
	opts := discordTriggerOptions{Mode: groupTriggerStrict}
	addressed := discordbus.InboundMessage{ChatType: discordbus.ChatTypeGroup, MentionUserIDs: []string{"7", "42"}}
	if _, ok, err := decideDiscordGroupTrigger(context.Background(), opts, addressed, "42", nil, nil); !ok || err != nil {
		t.Fatalf("addressed message rejected: %v", err)
	}
	other := discordbus.InboundMessage{ChatType: discordbus.ChatTypeGroup, MentionUserIDs: []string{"7"}}
	if _, ok, err := decideDiscordGroupTrigger(context.Background(), opts, other, "42", nil, nil); ok || err != nil {
		t.Fatalf("unaddressed message accepted: %v", err)
	}
}

func TestApprovalCustomIDs(t *testing.T) {
	buttons := discordApprovalButtons("apr_1")
	if len(buttons) != 1 || len(buttons[0].Components) != 2 {
		t.Fatalf("buttons = %+v", buttons)
	}
	for _, button := range buttons[0].Components {
		id, approved, ok := parseDiscordApprovalCustomID(button.CustomID)
		if !ok || id != "apr_1" || approved != (button.Label == "Approve") {
			t.Fatalf("custom id %q parsed as %q %v %v", button.CustomID, id, approved, ok)
		}
	}
	for _, raw := range []string{"", "morph:approve:", "morph:maybe:apr_1", "other:approve:apr_1"} {
		if _, _, ok := parseDiscordApprovalCustomID(raw); ok {
			t.Errorf("%q parsed", raw)
		}
	}
	text := discordApprovalRequestText(guard.ApprovalRecord{ID: "apr_1", ToolName: "bash", Reasons: []string{"writes files"}}, true)
	if !strings.Contains(text, "`/approve apr_1`") || !strings.Contains(text, "mentioning me") || !strings.Contains(text, "`bash`") {
		t.Fatalf("request text = %q", text)
	}
	outcome := discordApprovalOutcomeText(text, false, "5", nil)
	if !strings.HasSuffix(outcome, "❌ Denied by <@5>") {
		t.Fatalf("outcome = %q", outcome)
	}
	if got := discordApprovalOutcomeText(text, true, "5", errors.New("Approval expired")); !strings.HasSuffix(got, "⚠️ Approval expired") {
		t.Fatalf("expired outcome = %q", got)
	}
}

func TestPlanProgressIsOneEditedMessage(t *testing.T) {
	api := &fakeDiscordAPI{}
	progress := &discordPlanProgress{api: api, channelID: "200", replyTo: "300", logger: testLogger}
	plan := &agent.Plan{Steps: agent.PlanSteps{
		{Step: "collect data", Status: agent.PlanStatusInProgress},
		{Step: "summarize", Status: agent.PlanStatusPending},
	}}
	progress.update(context.Background(), plan)
	progress.update(context.Background(), plan)
	plan.Steps[0].Status = agent.PlanStatusCompleted
	plan.Steps[1].Status = agent.PlanStatusInProgress
	progress.update(context.Background(), plan)
	if len(api.created) != 1 || len(api.edits) != 1 {
		t.Fatalf("created=%d edits=%d", len(api.created), len(api.edits))
	}
	if got := api.created[0].Message.Content; got != "**Plan**\n▶️ collect data\n⬜ summarize" {
		t.Fatalf("first progress = %q", got)
	}
	if api.created[0].Message.MessageReference == nil || api.created[0].Message.MessageReference.MessageID != "300" {
		t.Fatal("progress message should reply to the triggering message")
	}
	if got := *api.edits[0].Edit.Content; got != "**Plan**\n✅ collect data\n▶️ summarize" {
		t.Fatalf("edited progress = %q", got)
	}
}

func TestTurnHistoryPutsStepMessagesBeforeTheReply(t *testing.T) {
	job := discordJob{ChannelID: "200", ChatType: discordbus.ChatTypeGroup, MessageID: "300", UserID: "5", Text: "do it"}
	result := discordTaskResult{
		Context:  &agent.Context{Plan: &agent.Plan{Steps: agent.PlanSteps{{Step: "a", Status: agent.PlanStatusCompleted, Note: "Found 3 files."}}}},
		Reaction: &discordtools.Reaction{Emoji: "👍"},
	}
	items := discordTurnHistory(job, "Morph", result, "Done.", time.Unix(20, 0))
	var texts []string
	for _, item := range items {
		texts = append(texts, item.Text)
	}
	if strings.Join(texts, "|") != "do it|[reacted: 👍]|Found 3 files.|Done." {
		t.Fatalf("history = %q", texts)
	}
}

func TestSendDiscordTextSplitsAndRepliesOnce(t *testing.T) {
	api := &fakeDiscordAPI{}
	text := strings.Repeat("a", 1500) + "\n\n" + strings.Repeat("b", 1500)
	sent, err := sendDiscordText(context.Background(), api, "200", text, "300")
	if err != nil || len(sent) != 2 {
		t.Fatalf("sent = %d, %v", len(sent), err)
	}
	if api.created[0].Message.MessageReference == nil || api.created[1].Message.MessageReference != nil {
		t.Fatal("only the first part replies")
	}
	for _, created := range api.created {
		if created.Message.AllowedMentions == nil || len(created.Message.AllowedMentions.Parse) != 0 {
			t.Fatal("messages must not ping anyone")
		}
	}
}

func TestKeyedQueueKeepsOrderPerKey(t *testing.T) {
	queue := newKeyedQueue()
	var mu sync.Mutex
	var got []int
	for i := 0; i < 20; i++ {
		i := i
		queue.push("a", func() {
			time.Sleep(time.Millisecond)
			mu.Lock()
			got = append(got, i)
			mu.Unlock()
		})
	}
	queue.wait()
	for i, v := range got {
		if v != i {
			t.Fatalf("order = %v", got)
		}
	}
	if len(got) != 20 {
		t.Fatalf("ran %d", len(got))
	}
}

func TestPublishDiscordBusOutboundAndWaitReturnsDeliveryError(t *testing.T) {
	bus, err := busruntime.StartInproc(busruntime.BootstrapOptions{MaxInFlight: 2, Logger: testLogger, Component: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	receipts := newDiscordDeliveryReceipts()
	deliveryErr := errors.New("delivery failed")
	if err := bus.Subscribe(busruntime.TopicChatMessage, func(_ context.Context, message busruntime.BusMessage) error {
		receipts.complete(message.ID, deliveryErr)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := publishDiscordBusOutboundAndWait(context.Background(), bus, receipts, "200", "hello", "300", "test:delivery"); !errors.Is(err, deliveryErr) {
		t.Fatalf("error = %v", err)
	}
}

func TestPairTargetUserID(t *testing.T) {
	for raw, want := range map[string]string{"<@123>": "123", "<@!123>": "123", "discord_user:123": "123", " 123 ": "123"} {
		if got, err := discordPairTargetUserID(raw); err != nil || got != want {
			t.Errorf("%q = %q, %v", raw, got, err)
		}
	}
	if _, err := discordPairTargetUserID("@agent"); err == nil {
		t.Fatal("a name was accepted")
	}
}
