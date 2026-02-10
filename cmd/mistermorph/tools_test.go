package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestToolsCommand_IncludesRuntimeTools(t *testing.T) {
	initViperDefaults()

	cmd := newToolsCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)

	if err := cmd.Execute(); err != nil {
		t.Fatalf("tools command failed: %v", err)
	}

	got := out.String()
	checks := []string{
		"Core tools (",
		"Extra tools (",
		"Telegram tools (",
		"read_file",
		"plan_create",
		"telegram_send_file",
		"telegram_send_voice",
		"telegram_react",
	}
	for _, want := range checks {
		if !strings.Contains(got, want) {
			t.Fatalf("tools output missing %q\noutput:\n%s", want, got)
		}
	}
}
