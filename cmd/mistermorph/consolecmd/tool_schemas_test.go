package consolecmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/toolschema"
)

func TestHandleToolSchemas(t *testing.T) {
	for _, tc := range []struct {
		method string
		want   int
	}{
		{http.MethodGet, http.StatusOK},
		{http.MethodPost, http.StatusMethodNotAllowed},
	} {
		rec := httptest.NewRecorder()
		(&server{}).handleToolSchemas(rec, httptest.NewRequest(tc.method, "/api/settings/tools/schemas", nil))
		if rec.Code != tc.want {
			t.Fatalf("%s status = %d, want %d", tc.method, rec.Code, tc.want)
		}
		if tc.want != http.StatusOK {
			continue
		}
		var body toolschema.Catalog
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		console := map[string]bool{}
		for _, tool := range body.Channels["console"] {
			console[tool.Name] = true
		}
		if !console["message_react"] || !console["skill_install"] {
			t.Fatalf("console tools = %v", console)
		}
		if body.Tools["codemode"].Name != "codemode" || len(body.Channels["telegram"]) == 0 {
			t.Fatalf("catalog = %d tools, %d channels", len(body.Tools), len(body.Channels))
		}
	}
}
