package db

import (
	"fmt"

	"github.com/quailyquaily/mistermorph/db/models"
	"gorm.io/gorm"
)

func AutoMigrate(gdb *gorm.DB) error {
	if gdb == nil {
		return fmt.Errorf("nil gorm db")
	}
	return gdb.AutoMigrate(
		&models.CronJob{},
		&models.CronRun{},
	)
}
