package livesend

import (
	"context"
	"errors"
	"testing"
)

type fakeSender struct {
	targets []string
	sent    []string
}

func (f *fakeSender) SendText(_ context.Context, peerID, text string) error {
	f.sent = append(f.sent, peerID+":"+text)
	return nil
}

func (f *fakeSender) SendFile(_ context.Context, peerID, path, filename, caption string) error {
	f.sent = append(f.sent, peerID+":file:"+path+":"+filename+":"+caption)
	return nil
}

func (f *fakeSender) NotifyTargets() []string { return f.targets }

func TestSendFileGoesToTheRunningRuntime(t *testing.T) {
	if err := SendFile(context.Background(), "whatsapp", "u1", "/c/a.pdf", "a.pdf", ""); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("SendFile with nothing running = %v", err)
	}
	sender := &fakeSender{}
	defer Register("whatsapp", sender)()
	if err := SendFile(context.Background(), "whatsapp", " u1 ", "/c/a.pdf", "a.pdf", "hi"); err != nil {
		t.Fatalf("SendFile() error = %v", err)
	}
	if len(sender.sent) != 1 || sender.sent[0] != "u1:file:/c/a.pdf:a.pdf:hi" {
		t.Fatalf("sent %v", sender.sent)
	}
}

func TestTheLatestRegisteredRuntimeSends(t *testing.T) {
	if err := Send(context.Background(), "wechat", "u1", "hi"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("Send with nothing running = %v", err)
	}
	first, second := &fakeSender{}, &fakeSender{targets: []string{"a", "b"}}
	stopFirst := Register("wechat", first)
	stopSecond := Register("WeChat", second)
	if err := Send(context.Background(), "wechat", "u1", "hi"); err != nil || len(second.sent) != 1 || len(first.sent) != 0 {
		t.Fatalf("Send = %v; first %v second %v", err, first.sent, second.sent)
	}
	if err := Notify(context.Background(), "wechat", "beat"); err != nil || len(second.sent) != 3 {
		t.Fatalf("Notify = %v; sent %v", err, second.sent)
	}
	stopSecond()
	_ = Send(context.Background(), "wechat", "u1", "again")
	if len(first.sent) != 1 {
		t.Fatalf("after unregistering, first sent %v", first.sent)
	}
	stopFirst()
	if err := Notify(context.Background(), "wechat", "x"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("Notify after both stopped = %v", err)
	}
}
