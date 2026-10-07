//go:build wailsdesktop

package main

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pkg/browser"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/updatecheck"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

const (
	desktopOpenURLMessagePrefix = "mistermorph:open-url:"
	desktopLogMessagePrefix     = "mistermorph:desktop-log:"
)

type App struct {
	wailsApp             *application.App
	consoleURL           string
	logPath              string
	startedAt            time.Time
	logWriter            io.Writer
	autoUpdate           desktopAutoUpdateConfig
	autoUpdateConfigPath string
	autoUpdateMu         sync.RWMutex
	restartMu            sync.Mutex
	restarting           bool
	readyOnce            sync.Once
	notificationService  *desktopNotificationManager
}

type DesktopNotificationRequest struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

func NewApp(consoleURL string, logPath string, startedAt time.Time, logWriter io.Writer) *App {
	return &App{
		consoleURL:          strings.TrimSpace(consoleURL),
		logPath:             strings.TrimSpace(logPath),
		startedAt:           startedAt,
		logWriter:           logWriter,
		notificationService: newDesktopNotificationManager(nil),
	}
}

func (a *App) RequestNotificationPermission() (bool, error) {
	if a == nil || a.notificationService == nil {
		return false, fmt.Errorf("desktop notification service is unavailable")
	}
	return a.notificationService.RequestNotificationAuthorization()
}

func (a *App) ShowNotification(req DesktopNotificationRequest) error {
	if a == nil || a.notificationService == nil {
		return fmt.Errorf("desktop notification service is unavailable")
	}
	return a.notificationService.SendNotification(notifications.NotificationOptions{
		ID:    strings.TrimSpace(req.ID),
		Title: strings.TrimSpace(req.Title),
		Body:  strings.TrimSpace(req.Body),
	})
}

func (a *App) SetAutoUpdateConfig(cfg desktopAutoUpdateConfig, configPath string) {
	if a == nil {
		return
	}
	a.autoUpdateMu.Lock()
	defer a.autoUpdateMu.Unlock()
	a.autoUpdate = cfg
	a.autoUpdateConfigPath = configPath
}

// currentAutoUpdateConfig re-reads the config file so that settings changed in
// the console (such as the release channel) apply without a restart.
func (a *App) currentAutoUpdateConfig() desktopAutoUpdateConfig {
	if a == nil {
		return desktopAutoUpdateConfig{}
	}
	a.autoUpdateMu.RLock()
	cfg, configPath := a.autoUpdate, a.autoUpdateConfigPath
	a.autoUpdateMu.RUnlock()
	if configPath == "" {
		return cfg
	}
	loaded, err := loadDesktopRuntimeConfig(configPath)
	if err != nil {
		return cfg
	}
	return loaded.AutoUpdate
}

func (a *App) Attach(wailsApp *application.App) {
	a.wailsApp = wailsApp
}

func (a *App) HandleRawMessage(window application.Window, message string) {
	switch {
	case strings.HasPrefix(message, desktopOpenURLMessagePrefix):
		if err := a.OpenExternalURL(message[len(desktopOpenURLMessagePrefix):]); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "open external URL failed: %v\n", err)
		}
	case strings.HasPrefix(message, desktopLogMessagePrefix):
		a.logDesktopFrontendMessage(window, strings.TrimPrefix(message, desktopLogMessagePrefix))
	}
}

func (a *App) OpenExternalURL(rawURL string) error {
	target, err := normalizeExternalBrowserURL(rawURL)
	if err != nil {
		return err
	}
	if err := browser.OpenURL(target); err != nil {
		return fmt.Errorf("open URL in browser: %w", err)
	}
	return nil
}

func desktopWindowName(window application.Window) string {
	if window == nil {
		return ""
	}
	return strings.TrimSpace(window.Name())
}

func (a *App) logDesktopFrontendMessage(window application.Window, raw string) {
	raw = compactDesktopLogValue(raw, 2000)
	a.logDesktopEvent("frontend source=%q %s", desktopWindowName(window), raw)
}

func (a *App) logDesktopEvent(format string, args ...any) {
	line := "desktop_window " + fmt.Sprintf(format, args...)
	_, _ = fmt.Fprintln(os.Stderr, line)
	if a != nil && a.logWriter != nil {
		_, _ = fmt.Fprintln(a.logWriter, line)
	}
}

func compactDesktopLogValue(value string, limit int) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.ReplaceAll(value, "\r", " ")
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit] + "...(truncated)"
}

func (a *App) QuitApp() {
	if a.wailsApp != nil {
		a.wailsApp.Quit()
	}
}

// DesktopDirectoryRequest asks the user to choose a folder for a path setting.
type DesktopDirectoryRequest struct {
	Title   string `json:"title"`
	Current string `json:"current"`
}

// PickDirectory shows the native folder picker and returns the chosen folder,
// or "" when the user cancels.
func (a *App) PickDirectory(req DesktopDirectoryRequest) (string, error) {
	if a == nil || a.wailsApp == nil {
		return "", fmt.Errorf("desktop app is not ready")
	}
	dialog := a.wailsApp.Dialog.OpenFile().
		CanChooseFiles(false).
		CanChooseDirectories(true).
		CanCreateDirectories(true).
		ShowHiddenFiles(true)
	if title := strings.TrimSpace(req.Title); title != "" {
		dialog = dialog.SetTitle(title)
	}
	if current := strings.TrimSpace(req.Current); current != "" {
		dialog = dialog.SetDirectory(pathutil.ExpandHomePath(current))
	}
	return dialog.PromptForSingleSelection()
}

func (a *App) OpenDesktopLog() error {
	if strings.TrimSpace(a.logPath) == "" {
		return fmt.Errorf("desktop log path is not available")
	}
	if err := browser.OpenFile(a.logPath); err != nil {
		return fmt.Errorf("open desktop log file: %w", err)
	}
	return nil
}

// CheckUpdate checks for an update. channel overrides the saved release
// channel so the console can check a channel before it is saved; nil uses the
// saved setting and an empty string the build channel.
func (a *App) CheckUpdate(channel *string) (DesktopUpdateCheckResult, error) {
	var logWriter io.Writer
	if a != nil {
		logWriter = a.logWriter
	}
	cfg := a.currentAutoUpdateConfig()
	if channel != nil {
		cfg.Channel = strings.TrimSpace(*channel)
	}
	opts := newDesktopUpdateCheckOptions(cfg)
	resolvedChannel, _ := updatecheck.NormalizeChannel(opts.Channel)
	manifestURL, _ := updatecheck.ResolveManifestURL(opts)
	logDesktopUpdateEvent(logWriter, "check_update channel=%q manifest_url=%q", resolvedChannel, manifestURL)
	result, err := updatecheck.Check(context.Background(), opts)
	if err != nil {
		logDesktopUpdateEvent(logWriter, "check_update_failed manifest_url=%q error=%q", manifestURL, compactDesktopLogValue(err.Error(), 1000))
	}
	return result, err
}

func (a *App) ReportFrontendReady() {
	if a == nil || a.logWriter == nil || a.startedAt.IsZero() {
		return
	}
	a.readyOnce.Do(func() {
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		_, _ = fmt.Fprintf(
			a.logWriter,
			"desktop_startup_frontend_ready duration_ms=%d desktop_go_alloc_bytes=%d desktop_go_sys_bytes=%d\n",
			time.Since(a.startedAt).Milliseconds(),
			mem.Alloc,
			mem.Sys,
		)
	})
}

func normalizeExternalBrowserURL(rawURL string) (string, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return "", fmt.Errorf("empty URL")
	}
	for i, r := range rawURL {
		if r < 32 || r == 127 {
			return "", fmt.Errorf("control character at position %d not allowed", i)
		}
	}
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("parse URL: %w", err)
	}
	scheme := strings.ToLower(parsedURL.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("unsupported URL scheme %q", parsedURL.Scheme)
	}
	if parsedURL.Host == "" {
		return "", fmt.Errorf("missing URL host")
	}
	return parsedURL.String(), nil
}

// RestartApp relaunches the current executable and quits the current process.
func (a *App) RestartApp() error {
	a.restartMu.Lock()
	if a.restarting {
		a.restartMu.Unlock()
		return nil
	}
	a.restarting = true
	a.restartMu.Unlock()

	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable path: %w", err)
	}

	cmd := exec.Command(exePath, os.Args[1:]...)
	cmd.Env = os.Environ()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if wd, wdErr := os.Getwd(); wdErr == nil {
		cmd.Dir = wd
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start new app process: %w", err)
	}

	if a.wailsApp != nil {
		a.wailsApp.Quit()
	}
	return nil
}
