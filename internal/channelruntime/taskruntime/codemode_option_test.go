package taskruntime

import (
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/viper"
)

func TestCodeModeOption(t *testing.T) {
	reader := viper.New()
	configdefaults.Apply(reader)
	cfg := toolsutil.LoadRuntimeToolsRegisterConfigFromReader(reader).CodeMode
	if !cfg.Enabled || cfg.Timeout != 120*time.Second || cfg.MaxToolCalls != 32 || cfg.MaxParallelCalls != 4 {
		t.Fatalf("defaults = %+v", cfg)
	}

	tests := []struct {
		name    string
		cfg     toolsutil.CodeModeConfig
		reg     func() *tools.Registry
		wantNil bool
		wantErr string
	}{
		{name: "on", cfg: cfg, reg: tools.NewRegistry},
		{name: "off", cfg: toolsutil.CodeModeConfig{}, reg: tools.NewRegistry, wantNil: true},
		{name: "invalid limits", cfg: toolsutil.CodeModeConfig{Enabled: true, Timeout: time.Second}, reg: tools.NewRegistry, wantErr: "must be positive"},
		{name: "name taken", cfg: cfg, reg: func() *tools.Registry {
			reg := tools.NewRegistry()
			_ = reg.Register(namedTool{name: "codemode"})
			return reg
		}, wantErr: "named codemode"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			option, err := CodeModeOption(tt.reg(), tt.cfg)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || (option == nil) != tt.wantNil {
				t.Fatalf("option = %v, err = %v", option != nil, err)
			}
		})
	}
}
