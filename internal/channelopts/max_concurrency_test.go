package channelopts

import (
	"fmt"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/spf13/viper"
)

// Every task runner reads its limit through these readers; omitted settings resolve to 8 and
// explicit ones, including 1, are kept.
func TestTaskRunnerMaxConcurrencyFromReader(t *testing.T) {
	readers := map[string]func(ConfigReader) int{
		"telegram": func(r ConfigReader) int { return TelegramConfigFromReader(r).MaxConcurrency },
		"slack":    func(r ConfigReader) int { return SlackConfigFromReader(r).MaxConcurrency },
		"line":     func(r ConfigReader) int { return LineConfigFromReader(r).MaxConcurrency },
		"lark":     func(r ConfigReader) int { return LarkConfigFromReader(r).MaxConcurrency },
		"mixin":    func(r ConfigReader) int { return MixinConfigFromReader(r).MaxConcurrency },
		"discord":  func(r ConfigReader) int { return DiscordConfigFromReader(r).MaxConcurrency },
		"wechat":   func(r ConfigReader) int { return WeChatConfigFromReader(r).MaxConcurrency },
		"whatsapp": func(r ConfigReader) int { return WhatsAppConfigFromReader(r).MaxConcurrency },
		"bluesky":  func(r ConfigReader) int { return BlueskyConfigFromReader(r).MaxConcurrency },
		"x":        func(r ConfigReader) int { return XConfigFromReader(r).MaxConcurrency },
		"cron":     func(r ConfigReader) int { return CronConfigFromReader(r).MaxConcurrency },
	}
	for section, read := range readers {
		t.Run(section, func(t *testing.T) {
			omitted := viper.New()
			configdefaults.Apply(omitted)
			if got := read(omitted); got != 8 {
				t.Fatalf("omitted %s.max_concurrency = %d, want 8", section, got)
			}
			for _, explicit := range []int{1, 5} {
				configured := viper.New()
				configdefaults.Apply(configured)
				configured.SetConfigType("yaml")
				if err := configured.ReadConfig(strings.NewReader(fmt.Sprintf("%s:\n  max_concurrency: %d\n", section, explicit))); err != nil {
					t.Fatal(err)
				}
				if got := read(configured); got != explicit {
					t.Fatalf("explicit %s.max_concurrency = %d, want %d", section, got, explicit)
				}
			}
		})
	}
}
