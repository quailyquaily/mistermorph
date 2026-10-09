package consolecmd

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// The console installs as a web app per agent: each agent gets its own manifest, named after the
// agent and using its avatar as the icon. Browsers fetch manifests and icons without the console's
// bearer token, so these routes are public; they show only the agent's name and avatar.

const (
	pwaThemeColor      = "#0f1711"
	pwaBackgroundColor = "#f7f2ea"
	pwaDefaultName     = "Mister Morph"
	// Maskable icons keep the avatar inside the safe zone, the inner 80% circle.
	pwaMaskableInset = 0.1
)

var pwaIconSizes = map[int]bool{180: true, 192: true, 512: true}

type pwaAgent struct {
	Ref       string
	Name      string
	AvatarURL string
	Client    runtimeEndpointClient
}

func (s *server) pwaAgent(ref string) (pwaAgent, bool) {
	ref = strings.TrimSpace(ref)
	if s == nil || ref == "" {
		return pwaAgent{}, false
	}
	s.ensureEndpointStates()
	s.endpointStateMu.RLock()
	defer s.endpointStateMu.RUnlock()
	for i, endpoint := range s.endpoints {
		if endpoint.Ref != ref {
			continue
		}
		state := s.endpointStates[i]
		name := strings.TrimSpace(state.Health.AgentName)
		if name == "" {
			name = strings.TrimSpace(endpoint.Name)
		}
		if name == "" {
			name = pwaDefaultName
		}
		return pwaAgent{
			Ref:       endpoint.Ref,
			Name:      name,
			AvatarURL: strings.TrimSpace(state.AvatarURL),
			Client:    endpoint.Client,
		}, true
	}
	return pwaAgent{}, false
}

// pwaScope is the agent's pages, as the console's router names them. Each agent's app has its
// own scope, so browsers install agents as separate apps; pages of other agents and the pages
// outside any agent, such as login, open in the app with the browser's toolbar.
func pwaScope(basePath, endpointRef string) string {
	routeRef := endpointRef
	if routeRef == consoleLocalEndpointRef {
		routeRef = "default"
	}
	return joinBasePath(basePath, "/e/"+url.PathEscape(routeRef)+"/")
}

// pwaStartPath is the agent's chat page.
func pwaStartPath(basePath, endpointRef string) string {
	return pwaScope(basePath, endpointRef) + "chat"
}

func (s *server) handlePWAManifest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	agent, ok := s.pwaAgent(r.URL.Query().Get("agent"))
	if !ok {
		writeError(w, http.StatusNotFound, "unknown agent")
		return
	}
	iconPath := joinBasePath(s.cfg.basePath, "/api/pwa/icon")
	icon := func(size int, purpose string) map[string]any {
		query := url.Values{}
		query.Set("agent", agent.Ref)
		query.Set("size", strconv.Itoa(size))
		if purpose == "maskable" {
			query.Set("purpose", purpose)
		}
		sizes := strconv.Itoa(size) + "x" + strconv.Itoa(size)
		return map[string]any{"src": iconPath + "?" + query.Encode(), "sizes": sizes, "type": "image/png", "purpose": purpose}
	}
	startPath := pwaStartPath(s.cfg.basePath, agent.Ref)
	writeJSON(w, http.StatusOK, map[string]any{
		"id":               startPath,
		"name":             agent.Name,
		"short_name":       agent.Name,
		"start_url":        startPath,
		"scope":            pwaScope(s.cfg.basePath, agent.Ref),
		"display":          "standalone",
		"theme_color":      pwaThemeColor,
		"background_color": pwaBackgroundColor,
		"icons": []map[string]any{
			icon(192, "any"),
			icon(512, "any"),
			icon(192, "maskable"),
			icon(512, "maskable"),
		},
	})
}

func (s *server) handlePWAIcon(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	query := r.URL.Query()
	agent, ok := s.pwaAgent(query.Get("agent"))
	if !ok {
		writeError(w, http.StatusNotFound, "unknown agent")
		return
	}
	size, err := strconv.Atoi(strings.TrimSpace(query.Get("size")))
	if err != nil || !pwaIconSizes[size] {
		writeError(w, http.StatusBadRequest, "unsupported icon size")
		return
	}
	maskable := strings.TrimSpace(query.Get("purpose")) == "maskable"

	var body []byte
	if avatar := s.pwaAgentAvatar(r.Context(), agent); avatar != nil {
		body, err = renderPWAIcon(avatar, size, maskable)
		if err != nil {
			body = nil
		}
	}
	if body == nil {
		body, err = s.readStaticAsset(pwaDefaultIconAsset(size, maskable))
		if err != nil {
			writeError(w, http.StatusNotFound, "icon unavailable")
			return
		}
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("Content-Type", "image/png")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}

// pwaAgentAvatar decodes the agent's avatar: the cached data URL when there is one, or a fresh
// download from the endpoint. It is nil when the agent has no avatar or it cannot be decoded.
func (s *server) pwaAgentAvatar(ctx context.Context, agent pwaAgent) image.Image {
	raw, ok := decodeImageDataURL(agent.AvatarURL)
	if !ok && agent.Client != nil {
		downloadCtx, cancel := context.WithTimeout(ctx, endpointAvatarTimeout)
		defer cancel()
		download, err := agent.Client.Download(downloadCtx, "/persona/avatar")
		if err != nil {
			return nil
		}
		if download.Body != nil {
			defer download.Body.Close()
		}
		if download.Status < 200 || download.Status >= 300 || download.Body == nil {
			return nil
		}
		raw, err = io.ReadAll(io.LimitReader(download.Body, endpointAvatarMaxBytes+1))
		if err != nil || len(raw) == 0 || len(raw) > endpointAvatarMaxBytes {
			return nil
		}
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil
	}
	return img
}

func decodeImageDataURL(value string) ([]byte, bool) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "data:image/") {
		return nil, false
	}
	meta, payload, found := strings.Cut(value, ",")
	if !found || !strings.HasSuffix(meta, ";base64") {
		return nil, false
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil || len(raw) == 0 {
		return nil, false
	}
	return raw, true
}

// renderPWAIcon draws the avatar as a square PNG on the app background, cropped to fill it.
// A maskable icon insets the avatar so platform masks do not cut it.
func renderPWAIcon(avatar image.Image, size int, maskable bool) ([]byte, error) {
	canvas := image.NewRGBA(image.Rect(0, 0, size, size))
	background := color.RGBA{R: 0xf7, G: 0xf2, B: 0xea, A: 0xff}
	draw.Draw(canvas, canvas.Bounds(), image.NewUniform(background), image.Point{}, draw.Src)

	target := canvas.Bounds()
	if maskable {
		inset := int(float64(size) * pwaMaskableInset)
		target = target.Inset(inset)
	}
	draw.CatmullRom.Scale(canvas, target, avatar, squareCrop(avatar.Bounds()), draw.Over, nil)

	var out bytes.Buffer
	if err := png.Encode(&out, canvas); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func squareCrop(bounds image.Rectangle) image.Rectangle {
	width, height := bounds.Dx(), bounds.Dy()
	if width > height {
		offset := (width - height) / 2
		return image.Rect(bounds.Min.X+offset, bounds.Min.Y, bounds.Min.X+offset+height, bounds.Max.Y)
	}
	offset := (height - width) / 2
	return image.Rect(bounds.Min.X, bounds.Min.Y+offset, bounds.Max.X, bounds.Min.Y+offset+width)
}

func pwaDefaultIconAsset(size int, maskable bool) string {
	switch {
	case size == 180:
		return "apple-touch-icon.png"
	case maskable && size == 192:
		return "maskable-192x192.png"
	case maskable:
		return "maskable-512x512.png"
	case size == 192:
		return "android-chrome-192x192.png"
	default:
		return "android-chrome-512x512.png"
	}
}
