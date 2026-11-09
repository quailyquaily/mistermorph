package contacts

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"gopkg.in/yaml.v3"
)

// contactVersion is a complete replacement of tg:123 whose nickname and private chat id agree, so a
// read that mixes two replacements shows as a nickname that does not match the chat id.
func contactVersion(n int) string {
	return fmt.Sprintf("contact_id: tg:123\nkind: human\nnickname: V%d\ntg_user_id: 123\ntg_private_chat_id: %d\n", n, n)
}

func checkCoherent(t *testing.T, how string, c Contact) {
	t.Helper()
	if c.ContactNickname != fmt.Sprintf("V%d", c.TGPrivateChatID) {
		t.Fatalf("%s: nickname %s with tg_private_chat_id %d, a contact never saved", how, c.ContactNickname, c.TGPrivateChatID)
	}
}

// A contact and its handles are read from one snapshot: a reader racing complete replacements
// sees one of them, never the row of one and the handles of another.
func TestContactReadsAreOneSnapshot(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	if err := store.PutContact(ctx, Contact{ContactID: "tg:123", TGUserID: 123}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutContactYAML(ctx, "tg:123", contactVersion(1001)); err != nil {
		t.Fatal(err)
	}
	// A second contact makes the listings take the many-contacts path.
	if err := store.PutContact(ctx, Contact{ContactID: "tg:7", TGUserID: 7}); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	writeErr := make(chan error, 1)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				writeErr <- nil
				return
			default:
			}
			if _, err := store.PutContactYAML(ctx, "tg:123", contactVersion(1001+i%2)); err != nil {
				writeErr <- err
				return
			}
		}
	}()
	defer func() {
		close(stop)
		wg.Wait()
		if err := <-writeErr; err != nil {
			t.Errorf("writer: %v", err)
		}
	}()

	find := func(items []Contact) Contact {
		for _, c := range items {
			if c.ContactID == "tg:123" {
				return c
			}
		}
		t.Fatalf("tg:123 missing from %+v", items)
		return Contact{}
	}
	for i := 0; i < 500; i++ {
		c, ok, err := store.GetContact(ctx, "tg:123")
		if err != nil || !ok {
			t.Fatalf("GetContact: %v %v", ok, err)
		}
		checkCoherent(t, "GetContact", c)

		all, err := store.ListContacts(ctx, StatusActive)
		if err != nil {
			t.Fatal(err)
		}
		checkCoherent(t, "ListContacts", find(all))

		listed, err := store.ListContactsFiltered(ctx, ContactFilter{})
		if err != nil {
			t.Fatal(err)
		}
		var plain []Contact
		for _, item := range listed {
			plain = append(plain, item.Contact)
		}
		checkCoherent(t, "ListContactsFiltered", find(plain))

		found, err := store.FindContactsByHandle(ctx, "tg_user_id", "123")
		if err != nil {
			t.Fatal(err)
		}
		if len(found) == 1 {
			checkCoherent(t, "FindContactsByHandle", found[0])
		}

		block, ok, err := store.GetContactYAML(ctx, "tg:123")
		if err != nil || !ok {
			t.Fatalf("GetContactYAML: %v %v", ok, err)
		}
		parsed, err := parseContactYAMLForTest(block.YAML)
		if err != nil {
			t.Fatal(err)
		}
		checkCoherent(t, "GetContactYAML", parsed)
	}
}

func parseContactYAMLForTest(raw string) (Contact, error) {
	var profile contactProfileSection
	if err := yaml.Unmarshal([]byte(raw), &profile); err != nil {
		return Contact{}, err
	}
	return contactFromProfileSection("", profile)
}

// Reads of a missing contact, an unknown handle and an empty store still answer, inside their
// transaction.
func TestContactReadsOfNothing(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	if _, ok, err := store.GetContact(ctx, "tg:1"); err != nil || ok {
		t.Fatalf("GetContact on an empty store: %v %v", ok, err)
	}
	if items, err := store.ListContacts(ctx, ""); err != nil || len(items) != 0 {
		t.Fatalf("ListContacts on an empty store: %v %v", items, err)
	}
	if items, err := store.ListContactsFiltered(ctx, ContactFilter{Kind: KindAgent}); err != nil || len(items) != 0 {
		t.Fatalf("ListContactsFiltered on an empty store: %v %v", items, err)
	}
	if items, err := store.FindContactsByHandle(ctx, "tg_user_id", "1"); err != nil || len(items) != 0 {
		t.Fatalf("FindContactsByHandle on an empty store: %v %v", items, err)
	}
	if _, err := store.FindContactsByHandle(ctx, "no_such_field", "1"); err == nil {
		t.Fatal("FindContactsByHandle accepted an unknown field")
	}
	if _, ok, err := store.GetContactYAML(ctx, "tg:1"); err != nil || ok {
		t.Fatalf("GetContactYAML on an empty store: %v %v", ok, err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err := store.GetContact(canceled, "tg:1"); err == nil {
		t.Fatal("GetContact with a canceled context succeeded")
	}
}
