package main

import (
	"testing"

	"github.com/quailyquaily/mistermorph/internal/telegramutil"
)

func TestEscapeMarkdownV2(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "plain_identifier",
			in:   "new_york",
			want: "new\\_york",
		},
		{
			name: "special_chars",
			in:   "_*[]()~`>#+-=|{}.!\\",
			want: "\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\",
		},
		{
			name: "non_specials",
			in:   "hello world",
			want: "hello world",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := telegramutil.EscapeMarkdownV2(tt.in); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}
