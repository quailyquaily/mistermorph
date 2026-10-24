package integration

import (
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/spf13/viper"
)

func ApplyViperDefaults(v *viper.Viper) {
	if v == nil {
		v = viper.GetViper()
	}
	configdefaults.Apply(v)
	// An embedding program decides whether its agent may ask for administrator rights through a
	// system dialog; it is off unless the program sets tools.bash.elevation.enabled (Linux, macOS)
	// or tools.powershell.elevation.enabled (Windows).
	v.SetDefault("tools.bash.elevation.enabled", false)
	v.SetDefault("tools.powershell.elevation.enabled", false)
}
