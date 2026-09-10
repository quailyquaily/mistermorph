package mixin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/internal/mixinapi"
)

func TestPlainHumanMessageGetsSelfAppCard(t *testing.T) {
	for _, category := range []string{"PLAIN_TEXT", "PLAIN_POST", "PLAIN_IMAGE", "PLAIN_AUDIO", "PLAIN_DATA", "PLAIN_VIDEO", "PLAIN_STICKER", " plain_text "} {
		t.Run(category, func(t *testing.T) {
			bot := mixinapi.User{UserID: testBotID, FullName: "Morph", AvatarURL: "https://example.test/bot.png"}
			api := &fakeMixinAPI{users: map[string]mixinapi.User{testUserID: {UserID: testUserID}}}
			ingress := newMixinIngress(api, bot, "", nil)
			message := mixinapi.MessageView{
				ConversationID: testConversationID, UserID: testUserID,
				MessageID: "55555555-5555-5555-5555-555555555555", Category: category,
				DataBase64: "ignored-not-base64",
			}
			for range 2 {
				handled, err := ingress.HandlePlainMessage(context.Background(), message)
				if err != nil || !handled {
					t.Fatalf("HandlePlainMessage() = %v, %v", handled, err)
				}
			}
			if len(api.sent) != 2 {
				t.Fatalf("sent = %#v", api.sent)
			}
			reply := api.sent[0]
			if reply.Category != "APP_CARD" || reply.ConversationID != message.ConversationID || reply.RecipientID != testUserID {
				t.Fatalf("reply target/category = %#v", reply)
			}
			if _, err := uuid.Parse(reply.MessageID); err != nil || reply.MessageID == message.MessageID || reply.MessageID != api.sent[1].MessageID {
				t.Fatalf("reply message_id is invalid or unstable: %q", reply.MessageID)
			}
			raw, err := base64.RawURLEncoding.DecodeString(reply.DataBase64)
			if err != nil {
				t.Fatal(err)
			}
			var card map[string]string
			if err := json.Unmarshal(raw, &card); err != nil {
				t.Fatal(err)
			}
			if card["app_id"] != testBotID || card["title"] != bot.FullName || card["icon_url"] != bot.AvatarURL ||
				card["action"] != "mixin://apps/"+testBotID || card["description"] == "" {
				t.Fatalf("card = %s", raw)
			}
			if api.readConversationCalls != 0 || api.readAttachmentCalls != 0 {
				t.Fatal("plain message should not load conversation or attachments")
			}
		})
	}
}

func TestPlainMessageIgnoresBotsAndNonMessages(t *testing.T) {
	var botSender mixinapi.User
	if err := json.Unmarshal([]byte(`{"user_id":"33333333-3333-3333-3333-333333333333","app":{"app_id":"33333333-3333-3333-3333-333333333333"}}`), &botSender); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name, category, senderID, source string
		sender                           mixinapi.User
		wantHandled                      bool
	}{
		{"bot", "PLAIN_TEXT", testUserID, "", botSender, true},
		{"self", "PLAIN_TEXT", testBotID, "", mixinapi.User{}, true},
		{"receipt", "PLAIN_TEXT", testUserID, "ACKNOWLEDGE_MESSAGE_RECEIPT", mixinapi.User{}, true},
		{"missing sender", "PLAIN_TEXT", "", "", mixinapi.User{}, true},
		{"encrypted", mixinapi.MessageCategoryEncryptedText, testUserID, "", mixinapi.User{}, false},
		{"app card", "APP_CARD", testUserID, "", mixinapi.User{}, false},
		{"system", mixinapi.MessageCategorySystem, testUserID, "", mixinapi.User{}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			api := &fakeMixinAPI{users: map[string]mixinapi.User{testUserID: tt.sender}}
			ingress := newMixinIngress(api, mixinapi.User{UserID: testBotID}, "", nil)
			handled, err := ingress.HandlePlainMessage(context.Background(), mixinapi.MessageView{
				ConversationID: testConversationID, UserID: tt.senderID, Source: tt.source,
				MessageID: "55555555-5555-5555-5555-555555555555", Category: tt.category,
			})
			if err != nil || handled != tt.wantHandled || len(api.sent) != 0 {
				t.Fatalf("handled=%v err=%v sent=%#v", handled, err, api.sent)
			}
			if tt.name != "bot" && api.readUserCalls != 0 {
				t.Fatalf("unexpected profile reads: %d", api.readUserCalls)
			}
		})
	}
}

func TestPlainMessageDoesNotGuessSenderKindOnProfileFailure(t *testing.T) {
	for _, tt := range []struct {
		name    string
		readErr error
		user    mixinapi.User
	}{
		{name: "fetch failed", readErr: errors.New("profile unavailable")},
		{name: "missing profile"},
		{name: "wrong profile", user: mixinapi.User{UserID: testBotID}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			api := &fakeMixinAPI{users: map[string]mixinapi.User{testUserID: tt.user}, readUserErrors: []error{tt.readErr}}
			ingress := newMixinIngress(api, mixinapi.User{UserID: testBotID}, "", nil)
			handled, err := ingress.HandlePlainMessage(context.Background(), mixinapi.MessageView{
				ConversationID: testConversationID, UserID: testUserID,
				MessageID: "55555555-5555-5555-5555-555555555555", Category: "PLAIN_TEXT",
			})
			if !handled || err == nil || len(api.sent) != 0 {
				t.Fatalf("handled=%v err=%v sent=%#v", handled, err, api.sent)
			}
		})
	}
}

func TestPlainMessageCardSendFailureCanRetry(t *testing.T) {
	sendErr := errors.New("send failed")
	for _, name := range []string{"", strings.Repeat("猫", 50)} {
		api := &fakeMixinAPI{users: map[string]mixinapi.User{testUserID: {UserID: testUserID}}, sendError: sendErr}
		ingress := newMixinIngress(api, mixinapi.User{UserID: testBotID, FullName: name}, "", nil)
		message := mixinapi.MessageView{ConversationID: testConversationID, UserID: testUserID,
			MessageID: "55555555-5555-5555-5555-555555555555", Category: "PLAIN_TEXT"}
		if handled, err := ingress.HandlePlainMessage(context.Background(), message); !handled || !errors.Is(err, sendErr) {
			t.Fatalf("handled=%v err=%v", handled, err)
		}
		api.sendError = nil
		if _, err := ingress.HandlePlainMessage(context.Background(), message); err != nil {
			t.Fatal(err)
		}
		if len(api.sent) != 2 || api.sent[0].MessageID != api.sent[1].MessageID {
			t.Fatalf("unstable retry: %#v", api.sent)
		}
		raw, err := base64.RawURLEncoding.DecodeString(api.sent[1].DataBase64)
		if err != nil {
			t.Fatal(err)
		}
		var card map[string]string
		if err := json.Unmarshal(raw, &card); err != nil {
			t.Fatal(err)
		}
		if title := card["title"]; !utf8.ValidString(title) || utf8.RuneCountInString(title) < 1 || utf8.RuneCountInString(title) > 36 {
			t.Fatalf("invalid title: %q", title)
		}
	}
}
