package consolecmd

import (
	"net/http"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/toolschema"
)

// toolSchemaCatalog adds the Console's own message_react, which this package defines, to the
// built-in tools.
var toolSchemaCatalog = sync.OnceValue(func() toolschema.Catalog {
	catalog := toolschema.Build()
	catalog.Channels["console"] = append(catalog.Channels["console"], toolschema.Describe(newConsoleMessageReactTool()))
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
