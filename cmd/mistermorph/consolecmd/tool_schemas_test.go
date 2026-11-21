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
		for _, name := range []string{"send_file", "message_react", "ask_user", "skill_install_preview", "skill_install"} {
			if !console[name] {
				t.Fatalf("console tools = %v, want %s", console, name)
			}
		}
		for _, channel := range []string{"telegram", "slack"} {
			asks := false
			for _, tool := range body.Channels[channel] {
				asks = asks || tool.Name == "ask_user"
			}
			if !asks {
				t.Fatalf("%s tools lack ask_user", channel)
			}
		}
		if body.Tools["codemode"].Name != "codemode" || len(body.Channels["telegram"]) == 0 {
			t.Fatalf("catalog = %d tools, %d channels", len(body.Tools), len(body.Channels))
		}
	}
}
