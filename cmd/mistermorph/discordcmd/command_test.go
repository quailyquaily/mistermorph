package discordcmd

import "testing"

func TestCommandFlags(t *testing.T) {
	t.Parallel()

	cmd := NewCommand(Dependencies{})
	for _, name := range []string{
		"discord-bot-token", "discord-allowed-guild-id", "discord-allowed-channel-id", "discord-allowed-user-id",
		"discord-group-trigger-mode", "discord-task-timeout", "discord-max-concurrency",
	} {
		if cmd.Flags().Lookup(name) == nil {
			t.Fatalf("missing flag --%s", name)
		}
	}
	if got := cmd.Flags().Lookup("discord-group-trigger-mode").DefValue; got != "strict" {
		t.Fatalf("default group trigger mode = %q, want strict", got)
	}
}

func TestAwarenessNotifierNeedsAChannel(t *testing.T) {
	t.Parallel()

	if newDiscordAwarenessNotifier("token", "", nil) != nil {
		t.Fatal("a notifier with no target channel was built")
	}
	if newDiscordAwarenessNotifier("token", "", []string{"200"}) == nil {
		t.Fatal("no notifier for a listed channel")
	}
}
