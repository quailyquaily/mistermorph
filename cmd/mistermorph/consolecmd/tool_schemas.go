package consolecmd

import (
	"net/http"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/toolschema"
)

// toolSchemaCatalog adds to the built-in tools the Console's own send_file and message_react,
// which this package defines, and ask_user in the channels whose chats can put a question to the
// person.
var toolSchemaCatalog = sync.OnceValue(func() toolschema.Catalog {
	catalog := toolschema.Build()
	catalog.Channels["console"] = append(catalog.Channels["console"],
		toolschema.Describe(&consoleSendFileTool{}),
		toolschema.Describe(&consoleMessageReactTool{}),
	)
	askUser := toolschema.Describe(taskruntime.AskUserTool())
	for _, channel := range []string{"console", "telegram", "slack"} {
		catalog.Channels[channel] = append(catalog.Channels[channel], askUser)
	}
	return catalog
})

// handleToolSchemas lists the built-in tools' parameter schemas for the Tools settings page.
func (s *server) handleToolSchemas(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, toolSchemaCatalog())
}
