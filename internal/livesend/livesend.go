// Package livesend lets code outside a running channel runtime send through it. WeChat can only
// reply within a conversation context the running runtime holds in memory, and WhatsApp limits
// sends per agent, so contacts_send, cron results and heartbeats for these channels go through the
// runtime that polls them, in this process, rather than through a client of their own.
package livesend

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
)

// Sender is a running channel runtime.
type Sender interface {
	// SendText sends text to a user of the channel, in order with the runtime's other messages.
	SendText(ctx context.Context, peerID, text string) error
	// SendFile sends a local file to a user of the channel, with caption as the transport handles
	// one. The runtime applies its transport's file size limit.
	SendFile(ctx context.Context, peerID, path, filename, caption string) error
	// NotifyTargets are the users heartbeat notifications go to.
	NotifyTargets() []string
}

// ErrNotRunning means no runtime for the channel runs in this process.
var ErrNotRunning = errors.New("the channel runtime is not running in this process")

var (
	mu      sync.Mutex
	senders = map[string][]*entry{}
)

type entry struct{ sender Sender }

// Register makes sender the channel's live sender until the returned function is called. When
// several runtimes of a channel run, the latest one sends.
func Register(channel string, sender Sender) (unregister func()) {
	channel = strings.ToLower(strings.TrimSpace(channel))
	e := &entry{sender: sender}
	mu.Lock()
	senders[channel] = append(senders[channel], e)
	mu.Unlock()
	return func() {
		mu.Lock()
		defer mu.Unlock()
		list := senders[channel]
		for i, item := range list {
			if item == e {
				senders[channel] = append(list[:i:i], list[i+1:]...)
				break
			}
		}
	}
}

func lookup(channel string) (Sender, error) {
	channel = strings.ToLower(strings.TrimSpace(channel))
	mu.Lock()
	defer mu.Unlock()
	list := senders[channel]
	if len(list) == 0 {
		return nil, fmt.Errorf("%s: %w", channel, ErrNotRunning)
	}
	return list[len(list)-1].sender, nil
}

// Send sends text to peerID through the channel's running runtime.
func Send(ctx context.Context, channel, peerID, text string) error {
	sender, err := lookup(channel)
	if err != nil {
		return err
	}
	return sender.SendText(ctx, strings.TrimSpace(peerID), text)
}

// SendFile sends a local file to peerID through the channel's running runtime.
func SendFile(ctx context.Context, channel, peerID, path, filename, caption string) error {
	sender, err := lookup(channel)
	if err != nil {
		return err
	}
	return sender.SendFile(ctx, strings.TrimSpace(peerID), path, filename, caption)
}

// Notify sends text to each of the channel's notification targets. It returns the first error but
// still tries every target. With no runtime running, or no target, nothing is sent.
func Notify(ctx context.Context, channel, text string) error {
	sender, err := lookup(channel)
	if err != nil {
		return err
	}
	var first error
	for _, peerID := range sender.NotifyTargets() {
		if err := sender.SendText(ctx, peerID, text); err != nil && first == nil {
			first = fmt.Errorf("%s notify %s: %w", channel, peerID, err)
		}
	}
	return first
}
