package consolecmd

import (
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/chattrace"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

func newConsoleChatTrace(taskID string, roots pathroots.PathRoots, g *guard.Guard, hub *consoleStreamHub) *chattrace.Collector {
	var publish func(chattrace.Snapshot)
	if hub != nil {
		publish = func(snapshot chattrace.Snapshot) {
			hub.publish(consoleStreamFrame{TaskID: taskID, Status: "running", Trace: &snapshot})
		}
	}
	return chattrace.NewCollector(taskID, roots, g, publish)
}
