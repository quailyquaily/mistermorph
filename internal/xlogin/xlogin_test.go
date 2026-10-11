package xlogin

import (
	"testing"

	"github.com/quailyquaily/mistermorph/internal/xapi"
)

func TestSaveLoadLogout(t *testing.T) {
	dir := t.TempDir()
	if Load(dir).LoggedIn || Configured(dir, "") {
		t.Fatal("logged in before any login")
	}
	if !Configured(dir, "from-config") {
		t.Fatal("a configured refresh token does not count")
	}
	if err := Save(dir, xapi.Token{RefreshToken: "r", UserID: "42", Username: "agent_bot"}); err != nil {
		t.Fatal(err)
	}
	if got := Load(dir); !got.LoggedIn || got.Username != "agent_bot" {
		t.Fatalf("Load() = %+v", got)
	}
	if err := Logout(dir); err != nil {
		t.Fatal(err)
	}
	if Load(dir).LoggedIn {
		t.Fatal("still logged in after logout")
	}
	if err := Logout(dir); err != nil {
		t.Fatalf("a second logout = %v", err)
	}
}
