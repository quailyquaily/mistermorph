package consolecmd

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
)

func testPWAAvatarPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: 0x20, G: 0x80, B: 0xe0, A: 0xff})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatalf("encode avatar: %v", err)
	}
	return out.Bytes()
}

func newPWATestServer(t *testing.T, client *stubRuntimeEndpointClient) *server {
	t.Helper()
	s := &server{
		cfg: serveConfig{basePath: "/console"},
		endpoints: []runtimeEndpoint{
			{Ref: consoleLocalEndpointRef, Name: "Console", Client: client},
			{Ref: "ep_remote", Name: "Remote", Client: &stubRuntimeEndpointClient{}},
		},
	}
	s.refreshEndpointHealth(context.Background())
	return s
}

func TestHandlePWAManifest(t *testing.T) {
	s := newPWATestServer(t, &stubRuntimeEndpointClient{
		health: runtimeEndpointHealth{AgentName: "Morph"},
	})

	t.Run("local agent", func(t *testing.T) {
		rec := httptest.NewRecorder()
		s.handlePWAManifest(rec, httptest.NewRequest(http.MethodGet, "/console/api/pwa/manifest.webmanifest?agent=ep_console_local", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		var manifest struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			StartURL string `json:"start_url"`
			Scope    string `json:"scope"`
			Icons    []struct {
				Src     string `json:"src"`
				Purpose string `json:"purpose"`
			} `json:"icons"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &manifest); err != nil {
			t.Fatalf("decode manifest: %v", err)
		}
		if manifest.Name != "Morph" {
			t.Fatalf("name = %q, want Morph", manifest.Name)
		}
		if manifest.StartURL != "/console/e/default/chat" || manifest.ID != manifest.StartURL {
			t.Fatalf("start_url = %q, id = %q", manifest.StartURL, manifest.ID)
		}
		if manifest.Scope != "/console/e/default/" {
			t.Fatalf("scope = %q", manifest.Scope)
		}
		if len(manifest.Icons) != 4 || manifest.Icons[0].Src != "/console/api/pwa/icon?agent=ep_console_local&size=192" {
			t.Fatalf("icons = %+v", manifest.Icons)
		}
		if manifest.Icons[3].Purpose != "maskable" {
			t.Fatalf("last icon purpose = %q", manifest.Icons[3].Purpose)
		}
	})

	t.Run("agent without a name uses the endpoint name", func(t *testing.T) {
		rec := httptest.NewRecorder()
		s.handlePWAManifest(rec, httptest.NewRequest(http.MethodGet, "/console/api/pwa/manifest.webmanifest?agent=ep_remote", nil))
		var manifest struct {
			Name     string `json:"name"`
			StartURL string `json:"start_url"`
			Scope    string `json:"scope"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &manifest)
		if manifest.Name != "Remote" || manifest.StartURL != "/console/e/ep_remote/chat" || manifest.Scope != "/console/e/ep_remote/" {
			t.Fatalf("manifest = %+v", manifest)
		}
	})

	t.Run("unknown agent", func(t *testing.T) {
		rec := httptest.NewRecorder()
		s.handlePWAManifest(rec, httptest.NewRequest(http.MethodGet, "/console/api/pwa/manifest.webmanifest?agent=nope", nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d", rec.Code)
		}
	})
}

func TestHandlePWAIcon(t *testing.T) {
	avatar := testPWAAvatarPNG(t, 300, 200)

	cases := []struct {
		name     string
		client   *stubRuntimeEndpointClient
		query    string
		wantCode int
		wantSize int
	}{
		{
			name: "avatar from health data URL",
			client: &stubRuntimeEndpointClient{health: runtimeEndpointHealth{
				AvatarURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString(avatar),
			}},
			query:    "agent=ep_console_local&size=192",
			wantCode: http.StatusOK,
			wantSize: 192,
		},
		{
			name:     "avatar downloaded from the endpoint",
			client:   &stubRuntimeEndpointClient{downloadStatus: http.StatusOK, downloadRaw: avatar},
			query:    "agent=ep_console_local&size=512&purpose=maskable",
			wantCode: http.StatusOK,
			wantSize: 512,
		},
		{
			name:     "no avatar and no default asset",
			client:   &stubRuntimeEndpointClient{downloadStatus: http.StatusNotFound},
			query:    "agent=ep_console_local&size=192",
			wantCode: http.StatusNotFound,
		},
		{
			name:     "unsupported size",
			client:   &stubRuntimeEndpointClient{},
			query:    "agent=ep_console_local&size=64",
			wantCode: http.StatusBadRequest,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newPWATestServer(t, tc.client)
			rec := httptest.NewRecorder()
			s.handlePWAIcon(rec, httptest.NewRequest(http.MethodGet, "/console/api/pwa/icon?"+tc.query, nil))
			if rec.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d, body = %s", rec.Code, tc.wantCode, rec.Body.String())
			}
			if tc.wantSize == 0 {
				return
			}
			img, err := png.Decode(rec.Body)
			if err != nil {
				t.Fatalf("decode icon: %v", err)
			}
			if b := img.Bounds(); b.Dx() != tc.wantSize || b.Dy() != tc.wantSize {
				t.Fatalf("icon size = %v, want %d", b, tc.wantSize)
			}
		})
	}
}

func TestRenderPWAIconMaskableKeepsBackgroundAtEdges(t *testing.T) {
	src, _, err := image.Decode(bytes.NewReader(testPWAAvatarPNG(t, 64, 64)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	raw, err := renderPWAIcon(src, 192, true)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	img, _ := png.Decode(bytes.NewReader(raw))
	r, g, b, _ := img.At(2, 2).RGBA()
	if r>>8 != 0xf7 || g>>8 != 0xf2 || b>>8 != 0xea {
		t.Fatalf("corner = %02x%02x%02x, want background", r>>8, g>>8, b>>8)
	}
	r, g, b, _ = img.At(96, 96).RGBA()
	if r>>8 != 0x20 || g>>8 != 0x80 || b>>8 != 0xe0 {
		t.Fatalf("center = %02x%02x%02x, want avatar", r>>8, g>>8, b>>8)
	}
}
