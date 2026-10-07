package consolecmd

import (
	"net/http"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/toolschema"
)

var toolSchemaCatalog = sync.OnceValue(toolschema.Build)

// handleToolSchemas lists the built-in tools' parameter schemas for the Tools settings page.
func (s *server) handleToolSchemas(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, toolSchemaCatalog())
}
