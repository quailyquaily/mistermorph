package consolecmd

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/cmd/mistermorph/daemoncmd"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

type serveConfig struct {
	listen       string
	basePath     string
	staticDir    string
	sessionTTL   time.Duration
	password     string
	passwordHash string
	daemonURL    string
	daemonToken  string
	stateDir     string
	cacheDir     string
}

type server struct {
	cfg            serveConfig
	startedAt      time.Time
	password       *passwordVerifier
	sessions       *sessionStore
	limiter        *loginLimiter
	tasks          *daemonTaskClient
	guardAuditPath string
	contactsDir    string
	contactsActive string
	contactsOld    string
	identityPath   string
	soulPath       string
	todoWIPPath    string
	todoDonePath   string
}

const (
	auditDefaultWindowBytes int64 = 128 * 1024
	auditMinWindowBytes     int64 = 4 * 1024
	auditMaxWindowBytes     int64 = 2 * 1024 * 1024
)

type auditFileItem struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
	ModTime   string `json:"mod_time"`
	Current   bool   `json:"current"`
}

type auditLogChunk struct {
	File      string   `json:"file"`
	Path      string   `json:"path"`
	Exists    bool     `json:"exists"`
	SizeBytes int64    `json:"size_bytes"`
	Before    int64    `json:"before"`
	From      int64    `json:"from"`
	To        int64    `json:"to"`
	HasOlder  bool     `json:"has_older"`
	Lines     []string `json:"lines"`
}

func newServeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Run console API + SPA server",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := loadServeConfig(cmd)
			if err != nil {
				return err
			}
			srv, err := newServer(cfg)
			if err != nil {
				return err
			}
			return srv.run()
		},
	}

	cmd.Flags().String("console-listen", "127.0.0.1:9080", "Console server listen address.")
	cmd.Flags().String("console-base-path", "/console", "Console base path.")
	cmd.Flags().String("console-static-dir", "", "Mistermorph Console SPA static directory (required).")
	cmd.Flags().Duration("console-session-ttl", 12*time.Hour, "Session TTL for console bearer token.")

	return cmd
}

func loadServeConfig(cmd *cobra.Command) (serveConfig, error) {
	listen := strings.TrimSpace(configutil.FlagOrViperString(cmd, "console-listen", "console.listen"))
	if listen == "" {
		listen = "127.0.0.1:9080"
	}

	basePath, err := normalizeBasePath(configutil.FlagOrViperString(cmd, "console-base-path", "console.base_path"))
	if err != nil {
		return serveConfig{}, err
	}

	staticDir := strings.TrimSpace(configutil.FlagOrViperString(cmd, "console-static-dir", "console.static_dir"))
	staticDir = pathutil.ExpandHomePath(staticDir)
	if staticDir == "" {
		return serveConfig{}, fmt.Errorf("missing console static directory (--console-static-dir)")
	}
	if fi, err := os.Stat(staticDir); err != nil || !fi.IsDir() {
		return serveConfig{}, fmt.Errorf("console static dir is invalid: %s", staticDir)
	}
	indexPath := filepath.Join(staticDir, "index.html")
	if fi, err := os.Stat(indexPath); err != nil || fi.IsDir() {
		return serveConfig{}, fmt.Errorf("console static dir must contain index.html: %s", indexPath)
	}

	sessionTTL := configutil.FlagOrViperDuration(cmd, "console-session-ttl", "console.session_ttl")
	if sessionTTL <= 0 {
		sessionTTL = 12 * time.Hour
	}

	stateDir := pathutil.ResolveStateDir(viper.GetString("file_state_dir"))
	cacheDir := pathutil.ExpandHomePath(viper.GetString("file_cache_dir"))
	daemonURL := strings.TrimRight(strings.TrimSpace(viper.GetString("server.url")), "/")
	daemonToken := strings.TrimSpace(viper.GetString("server.auth_token"))

	return serveConfig{
		listen:       listen,
		basePath:     basePath,
		staticDir:    staticDir,
		sessionTTL:   sessionTTL,
		password:     viper.GetString("console.password"),
		passwordHash: viper.GetString("console.password_hash"),
		daemonURL:    daemonURL,
		daemonToken:  daemonToken,
		stateDir:     stateDir,
		cacheDir:     cacheDir,
	}, nil
}

func normalizeBasePath(raw string) (string, error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "/console", nil
	}
	if !strings.HasPrefix(v, "/") {
		v = "/" + v
	}
	v = path.Clean(v)
	if v == "." || v == "/" {
		return "", fmt.Errorf("console base path cannot be root")
	}
	return strings.TrimRight(v, "/"), nil
}

func newServer(cfg serveConfig) (*server, error) {
	password, err := newPasswordVerifier(cfg.password, cfg.passwordHash)
	if err != nil {
		return nil, err
	}
	contactsDir := statepaths.ContactsDir()
	return &server{
		cfg:            cfg,
		startedAt:      time.Now().UTC(),
		password:       password,
		sessions:       newSessionStore(),
		limiter:        newLoginLimiter(),
		tasks:          newDaemonTaskClient(cfg.daemonURL, cfg.daemonToken),
		guardAuditPath: resolveGuardAuditPath(cfg.stateDir),
		contactsDir:    contactsDir,
		contactsActive: filepath.Join(contactsDir, "ACTIVE.md"),
		contactsOld:    filepath.Join(contactsDir, "INACTIVE.md"),
		identityPath:   filepath.Join(cfg.stateDir, "IDENTITY.md"),
		soulPath:       filepath.Join(cfg.stateDir, "SOUL.md"),
		todoWIPPath:    filepath.Join(cfg.stateDir, statepaths.TODOWIPFilename),
		todoDonePath:   filepath.Join(cfg.stateDir, statepaths.TODODONEFilename),
	}, nil
}

func (s *server) run() error {
	mux := http.NewServeMux()
	apiPrefix := s.cfg.basePath + "/api"

	mux.HandleFunc(apiPrefix+"/auth/login", s.handleLogin)
	mux.HandleFunc(apiPrefix+"/system/health", s.handleSystemHealth)

	mux.HandleFunc(apiPrefix+"/auth/logout", s.withAuth(s.handleLogout))
	mux.HandleFunc(apiPrefix+"/auth/me", s.withAuth(s.handleAuthMe))
	mux.HandleFunc(apiPrefix+"/dashboard/overview", s.withAuth(s.handleDashboardOverview))
	mux.HandleFunc(apiPrefix+"/tasks", s.withAuth(s.handleTasks))
	mux.HandleFunc(apiPrefix+"/tasks/", s.withAuth(s.handleTaskDetail))
	mux.HandleFunc(apiPrefix+"/todo/files", s.withAuth(s.handleTODOFiles))
	mux.HandleFunc(apiPrefix+"/todo/files/", s.withAuth(s.handleTODOFileDetail))
	mux.HandleFunc(apiPrefix+"/contacts/files", s.withAuth(s.handleContactsFiles))
	mux.HandleFunc(apiPrefix+"/contacts/files/", s.withAuth(s.handleContactsFileDetail))
	mux.HandleFunc(apiPrefix+"/persona/files", s.withAuth(s.handlePersonaFiles))
	mux.HandleFunc(apiPrefix+"/persona/files/", s.withAuth(s.handlePersonaFileDetail))
	mux.HandleFunc(apiPrefix+"/audit/files", s.withAuth(s.handleAuditFiles))
	mux.HandleFunc(apiPrefix+"/audit/logs", s.withAuth(s.handleAuditLogs))
	mux.HandleFunc(apiPrefix+"/system/config", s.withAuth(s.handleSystemConfig))
	mux.HandleFunc(apiPrefix+"/system/diagnostics", s.withAuth(s.handleSystemDiagnostics))

	mux.HandleFunc(s.cfg.basePath, s.handleSPA)
	mux.HandleFunc(s.cfg.basePath+"/", s.handleSPA)

	httpSrv := &http.Server{
		Addr:              s.cfg.listen,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	return httpSrv.ListenAndServe()
}

func (s *server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		expiresAt, ok := s.sessions.Validate(token)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		r.Header.Set("X-Console-Token-Expires-At", expiresAt.Format(time.RFC3339))
		next(w, r)
	}
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	now := time.Now().UTC()
	ip := clientIP(r.RemoteAddr)
	key := "console@" + ip
	if remaining, locked := s.limiter.CheckLocked(key, now); locked {
		w.Header().Set("Retry-After", strconv.Itoa(int(remaining.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "too many failed attempts")
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}

	if !s.password.Verify(req.Password) {
		lockUntil := s.limiter.RecordFailure(ip, key, now)
		time.Sleep(s.limiter.FailureDelay())
		if !lockUntil.IsZero() {
			retry := int(lockUntil.Sub(time.Now().UTC()).Seconds()) + 1
			if retry < 1 {
				retry = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			writeError(w, http.StatusTooManyRequests, "too many failed attempts")
			return
		}
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	s.limiter.RecordSuccess(ip, key, now)
	token, expiresAt, err := s.sessions.Create(s.cfg.sessionTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"access_token": token,
		"token_type":   "Bearer",
		"expires_at":   expiresAt.Format(time.RFC3339),
	})
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	token, _ := bearerToken(r)
	s.sessions.Delete(token)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	expires := strings.TrimSpace(r.Header.Get("X-Console-Token-Expires-At"))
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"account":       "console",
		"expires_at":    expires,
	})
}

func (s *server) handleDashboardOverview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	channelConfigured, telegramConfigured, slackConfigured := detectConfiguredChannelAPI()
	channelRunning, telegramRunning, slackRunning := s.detectRunningChannelAPI(r.Context())

	writeJSON(w, http.StatusOK, map[string]any{
		"version":    buildVersion(),
		"started_at": s.startedAt.Format(time.RFC3339),
		"uptime_sec": int(time.Since(s.startedAt).Seconds()),
		"health":     "ok",
		"llm": map[string]any{
			"provider": strings.TrimSpace(viper.GetString("llm.provider")),
			"model":    strings.TrimSpace(viper.GetString("llm.model")),
		},
		"channel": map[string]any{
			"configured":          channelConfigured,
			"telegram_configured": telegramConfigured,
			"slack_configured":    slackConfigured,
			"running":             channelRunning,
			"telegram_running":    telegramRunning,
			"slack_running":       slackRunning,
		},
		"runtime": map[string]any{
			"go_version":       runtime.Version(),
			"goroutines":       runtime.NumGoroutine(),
			"heap_alloc_bytes": mem.HeapAlloc,
			"heap_sys_bytes":   mem.HeapSys,
			"heap_objects":     mem.HeapObjects,
			"gc_cycles":        mem.NumGC,
		},
	})
}

func (s *server) handleSystemHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"started_at": s.startedAt.Format(time.RFC3339),
	})
}

func (s *server) handleSystemConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"console": map[string]any{
			"listen":            s.cfg.listen,
			"base_path":         s.cfg.basePath,
			"session_ttl":       s.cfg.sessionTTL.String(),
			"password_set":      strings.TrimSpace(s.cfg.password) != "",
			"password_hash_set": strings.TrimSpace(s.cfg.passwordHash) != "",
		},
		"llm": map[string]any{
			"provider": strings.TrimSpace(viper.GetString("llm.provider")),
			"model":    strings.TrimSpace(viper.GetString("llm.model")),
		},
		"paths": map[string]any{
			"file_state_dir": s.cfg.stateDir,
			"file_cache_dir": s.cfg.cacheDir,
			"console_static": s.cfg.staticDir,
		},
	})
}

func (s *server) handleSystemDiagnostics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	checks := []map[string]any{
		diagnoseDirReadable("console_static_dir", s.cfg.staticDir),
		diagnoseFileReadable("console_static_index", filepath.Join(s.cfg.staticDir, "index.html")),
		diagnoseDirWritable("file_state_dir", s.cfg.stateDir),
		diagnoseDirWritable("file_cache_dir", s.cfg.cacheDir),
		diagnoseFileReadable("contacts_active", s.contactsActive),
		diagnoseFileReadable("contacts_inactive", s.contactsOld),
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"started_at": s.startedAt.Format(time.RFC3339),
		"version":    buildVersion(),
		"checks":     checks,
	})
}

func (s *server) handleAuditFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	items, err := s.listAuditFiles()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"default_file": filepath.Base(strings.TrimSpace(s.guardAuditPath)),
		"items":        items,
	})
}

func (s *server) handleAuditLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	fileName := strings.TrimSpace(r.URL.Query().Get("file"))
	filePath, err := s.resolveAuditFilePath(fileName)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	maxBytes, err := parseInt64QueryParamInRange(r.URL.Query().Get("max_bytes"), auditDefaultWindowBytes, auditMinWindowBytes, auditMaxWindowBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid max_bytes")
		return
	}
	before, err := parseInt64QueryParamOptional(r.URL.Query().Get("before"), -1)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid before")
		return
	}
	chunk, err := readAuditLogChunk(filePath, before, maxBytes)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	chunk.File = filepath.Base(filePath)
	writeJSON(w, http.StatusOK, chunk)
}

func (s *server) handleTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	statusRaw := strings.TrimSpace(r.URL.Query().Get("status"))
	status, ok := daemoncmd.ParseTaskStatus(statusRaw)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid status")
		return
	}
	limit := 20
	if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
		v, err := strconv.Atoi(rawLimit)
		if err != nil || v <= 0 {
			writeError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		limit = v
	}
	items, err := s.tasks.List(r.Context(), status, limit)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *server) handleTaskDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	taskID := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, s.cfg.basePath+"/api/tasks/"))
	if taskID == "" {
		writeError(w, http.StatusBadRequest, "missing task id")
		return
	}
	item, err := s.tasks.Get(r.Context(), taskID)
	if err != nil {
		status := http.StatusServiceUnavailable
		if errors.Is(err, errTaskNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *server) handleContactsFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	items := []map[string]any{
		describeContactFile("ACTIVE.md", s.contactsActive),
		describeContactFile("INACTIVE.md", s.contactsOld),
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
	})
}

func (s *server) handleTODOFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	items := []map[string]any{
		describeContactFile(statepaths.TODOWIPFilename, s.todoWIPPath),
		describeContactFile(statepaths.TODODONEFilename, s.todoDonePath),
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
	})
}

func (s *server) handleTODOFileDetail(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, s.cfg.basePath+"/api/todo/files/"))
	filePath, ok := s.resolveTODOFile(name)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid file name")
		return
	}

	switch r.Method {
	case http.MethodGet:
		content, exists, err := fsstore.ReadText(filePath)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !exists {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"name":    name,
			"content": content,
		})
		return

	case http.MethodPut:
		var req struct {
			Content string `json:"content"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := fsstore.EnsureDir(filepath.Dir(filePath), 0o700); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := fsstore.WriteTextAtomic(filePath, req.Content, fsstore.FileOptions{}); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":   true,
			"name": name,
		})
		return

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
}

func (s *server) handleContactsFileDetail(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, s.cfg.basePath+"/api/contacts/files/"))
	filePath, ok := s.resolveContactsFile(name)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid file name")
		return
	}

	switch r.Method {
	case http.MethodGet:
		content, exists, err := fsstore.ReadText(filePath)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !exists {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"name":    name,
			"content": content,
		})
		return

	case http.MethodPut:
		var req struct {
			Content string `json:"content"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := fsstore.EnsureDir(s.contactsDir, 0o700); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := fsstore.WriteTextAtomic(filePath, req.Content, fsstore.FileOptions{}); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":   true,
			"name": name,
		})
		return

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
}

func (s *server) handlePersonaFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	items := []map[string]any{
		describeContactFile("IDENTITY.md", s.identityPath),
		describeContactFile("SOUL.md", s.soulPath),
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
	})
}

func (s *server) handlePersonaFileDetail(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, s.cfg.basePath+"/api/persona/files/"))
	filePath, ok := s.resolvePersonaFile(name)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid file name")
		return
	}

	switch r.Method {
	case http.MethodGet:
		content, exists, err := fsstore.ReadText(filePath)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !exists {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"name":    name,
			"content": content,
		})
		return

	case http.MethodPut:
		var req struct {
			Content string `json:"content"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := fsstore.EnsureDir(filepath.Dir(filePath), 0o700); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := fsstore.WriteTextAtomic(filePath, req.Content, fsstore.FileOptions{}); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":   true,
			"name": name,
		})
		return

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
}

func (s *server) resolveContactsFile(name string) (string, bool) {
	switch strings.TrimSpace(strings.ToUpper(name)) {
	case "ACTIVE.MD":
		return s.contactsActive, true
	case "INACTIVE.MD":
		return s.contactsOld, true
	default:
		return "", false
	}
}

func (s *server) resolveTODOFile(name string) (string, bool) {
	switch strings.TrimSpace(strings.ToUpper(name)) {
	case strings.ToUpper(statepaths.TODOWIPFilename):
		return s.todoWIPPath, true
	case strings.ToUpper(statepaths.TODODONEFilename):
		return s.todoDonePath, true
	default:
		return "", false
	}
}

func (s *server) resolvePersonaFile(name string) (string, bool) {
	switch strings.TrimSpace(strings.ToUpper(name)) {
	case "IDENTITY.MD":
		return s.identityPath, true
	case "SOUL.MD":
		return s.soulPath, true
	default:
		return "", false
	}
}

func (s *server) listAuditFiles() ([]auditFileItem, error) {
	basePath := strings.TrimSpace(s.guardAuditPath)
	if basePath == "" {
		return []auditFileItem{}, nil
	}

	dirPath := filepath.Dir(basePath)
	baseName := filepath.Base(basePath)

	entries, err := os.ReadDir(dirPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []auditFileItem{}, nil
		}
		return nil, err
	}

	type sortableAuditFileItem struct {
		item  auditFileItem
		unixN int64
	}
	items := make([]sortableAuditFileItem, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := strings.TrimSpace(entry.Name())
		if name == "" {
			continue
		}
		if name != baseName && !strings.HasPrefix(name, baseName+".") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		modTime := info.ModTime().UTC()
		items = append(items, sortableAuditFileItem{
			item: auditFileItem{
				Name:      name,
				Path:      filepath.Join(dirPath, name),
				SizeBytes: info.Size(),
				ModTime:   modTime.Format(time.RFC3339),
				Current:   name == baseName,
			},
			unixN: modTime.UnixNano(),
		})
	}

	sort.SliceStable(items, func(i, j int) bool {
		if items[i].item.Current != items[j].item.Current {
			return items[i].item.Current
		}
		if items[i].unixN != items[j].unixN {
			return items[i].unixN > items[j].unixN
		}
		return items[i].item.Name > items[j].item.Name
	})

	out := make([]auditFileItem, 0, len(items))
	for _, it := range items {
		out = append(out, it.item)
	}
	return out, nil
}

func (s *server) resolveAuditFilePath(name string) (string, error) {
	basePath := strings.TrimSpace(s.guardAuditPath)
	if basePath == "" {
		return "", fmt.Errorf("guard audit path is not configured")
	}
	baseName := filepath.Base(basePath)
	name = strings.TrimSpace(name)
	if name == "" {
		return basePath, nil
	}
	if strings.Contains(name, "/") || strings.Contains(name, "\\") {
		return "", fmt.Errorf("invalid file name")
	}
	if name != baseName && !strings.HasPrefix(name, baseName+".") {
		return "", fmt.Errorf("invalid file name")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(basePath), name)), nil
}

func (s *server) handleSPA(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if r.URL.Path == s.cfg.basePath {
		target := s.cfg.basePath + "/"
		if strings.TrimSpace(r.URL.RawQuery) != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusTemporaryRedirect)
		return
	}
	if strings.HasPrefix(r.URL.Path, s.cfg.basePath+"/api/") || r.URL.Path == s.cfg.basePath+"/api" {
		http.NotFound(w, r)
		return
	}

	rel := strings.TrimPrefix(r.URL.Path, s.cfg.basePath)
	rel = strings.TrimPrefix(rel, "/")
	if rel == "" {
		http.ServeFile(w, r, filepath.Join(s.cfg.staticDir, "index.html"))
		return
	}

	clean := path.Clean("/" + rel)
	target := filepath.Join(s.cfg.staticDir, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
	if fi, err := os.Stat(target); err == nil && !fi.IsDir() {
		http.ServeFile(w, r, target)
		return
	}
	http.ServeFile(w, r, filepath.Join(s.cfg.staticDir, "index.html"))
}

func buildVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok || info == nil {
		return "dev"
	}
	if strings.TrimSpace(info.Main.Version) == "" || strings.TrimSpace(info.Main.Version) == "(devel)" {
		return "dev"
	}
	return strings.TrimSpace(info.Main.Version)
}

func detectConfiguredChannelAPI() (current string, telegramConfigured bool, slackConfigured bool) {
	telegramConfigured = strings.TrimSpace(viper.GetString("telegram.bot_token")) != ""
	slackConfigured = strings.TrimSpace(viper.GetString("slack.bot_token")) != "" &&
		strings.TrimSpace(viper.GetString("slack.app_token")) != ""

	switch {
	case telegramConfigured && slackConfigured:
		return "both", telegramConfigured, slackConfigured
	case telegramConfigured:
		return "telegram", telegramConfigured, slackConfigured
	case slackConfigured:
		return "slack", telegramConfigured, slackConfigured
	default:
		return "none", telegramConfigured, slackConfigured
	}
}

func resolveGuardAuditPath(stateDir string) string {
	configured := pathutil.ExpandHomePath(viper.GetString("guard.audit.jsonl_path"))
	if strings.TrimSpace(configured) != "" {
		return configured
	}
	guardDir := pathutil.ResolveStateChildDir(stateDir, strings.TrimSpace(viper.GetString("guard.dir_name")), "guard")
	return filepath.Join(guardDir, "audit", "guard_audit.jsonl")
}

func parseInt64QueryParamOptional(raw string, fallback int64) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, err
	}
	return v, nil
}

func parseInt64QueryParamInRange(raw string, fallback, minValue, maxValue int64) (int64, error) {
	v, err := parseInt64QueryParamOptional(raw, fallback)
	if err != nil {
		return 0, err
	}
	if v < minValue {
		v = minValue
	}
	if v > maxValue {
		v = maxValue
	}
	return v, nil
}

func readAuditLogChunk(filePath string, before int64, maxBytes int64) (auditLogChunk, error) {
	chunk := auditLogChunk{
		Path:  strings.TrimSpace(filePath),
		Lines: []string{},
	}
	fd, err := os.Open(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return chunk, nil
		}
		return chunk, err
	}
	defer fd.Close()

	fi, err := fd.Stat()
	if err != nil {
		return chunk, err
	}
	if fi.IsDir() {
		return chunk, fmt.Errorf("audit log path is a directory")
	}

	chunk.Exists = true
	chunk.SizeBytes = fi.Size()
	if chunk.SizeBytes <= 0 {
		return chunk, nil
	}
	if before <= 0 || before > chunk.SizeBytes {
		before = chunk.SizeBytes
	}
	start := before - maxBytes
	if start < 0 {
		start = 0
	}
	windowBytes := before - start
	if windowBytes <= 0 {
		chunk.Before = before
		chunk.From = before
		chunk.To = before
		chunk.HasOlder = before > 0
		return chunk, nil
	}

	buf := make([]byte, windowBytes)
	n, err := fd.ReadAt(buf, start)
	if err != nil && !errors.Is(err, io.EOF) {
		return chunk, err
	}
	buf = buf[:n]

	if start > 0 {
		idx := bytes.IndexByte(buf, '\n')
		if idx >= 0 {
			start += int64(idx + 1)
			buf = buf[idx+1:]
		} else {
			start = before
			buf = buf[:0]
		}
	}

	chunk.Before = before
	chunk.From = start
	chunk.To = before
	chunk.HasOlder = start > 0
	chunk.Lines = splitAuditLines(buf)
	return chunk, nil
}

func splitAuditLines(buf []byte) []string {
	if len(buf) == 0 {
		return []string{}
	}
	parts := bytes.Split(buf, []byte{'\n'})
	lines := make([]string, 0, len(parts))
	for _, part := range parts {
		if len(part) == 0 {
			continue
		}
		lines = append(lines, strings.TrimSuffix(string(part), "\r"))
	}
	return lines
}

func (s *server) detectRunningChannelAPI(ctx context.Context) (current string, telegramRunning bool, slackRunning bool) {
	if s == nil || s.tasks == nil {
		return "unknown", false, false
	}
	mode, err := s.tasks.HealthMode(ctx)
	if err != nil {
		return "unknown", false, false
	}
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "telegram":
		return "telegram", true, false
	case "slack":
		return "slack", false, true
	case "serve":
		return "none", false, false
	default:
		return "unknown", false, false
	}
}

func bearerToken(r *http.Request) (string, bool) {
	raw := strings.TrimSpace(r.Header.Get("Authorization"))
	if raw == "" {
		return "", false
	}
	const prefix = "Bearer "
	if len(raw) <= len(prefix) {
		return "", false
	}
	if subtle.ConstantTimeCompare([]byte(strings.ToLower(raw[:len(prefix)])), []byte(strings.ToLower(prefix))) != 1 {
		return "", false
	}
	token := strings.TrimSpace(raw[len(prefix):])
	if token == "" {
		return "", false
	}
	return token, true
}

func clientIP(remoteAddr string) string {
	host := strings.TrimSpace(remoteAddr)
	if strings.Contains(host, ":") {
		if h, _, err := net.SplitHostPort(remoteAddr); err == nil && strings.TrimSpace(h) != "" {
			return strings.TrimSpace(h)
		}
	}
	return host
}

func describeContactFile(name, p string) map[string]any {
	_, err := os.Stat(p)
	return map[string]any{
		"name":   name,
		"path":   p,
		"exists": err == nil,
	}
}

func diagnoseDirReadable(id, p string) map[string]any {
	fi, err := os.Stat(p)
	if err != nil {
		return map[string]any{"id": id, "ok": false, "detail": err.Error()}
	}
	if !fi.IsDir() {
		return map[string]any{"id": id, "ok": false, "detail": "not a directory"}
	}
	return map[string]any{"id": id, "ok": true}
}

func diagnoseDirWritable(id, p string) map[string]any {
	fi, err := os.Stat(p)
	if err != nil {
		return map[string]any{"id": id, "ok": false, "detail": err.Error()}
	}
	if !fi.IsDir() {
		return map[string]any{"id": id, "ok": false, "detail": "not a directory"}
	}
	fd, err := os.CreateTemp(p, ".diag_write_*")
	if err != nil {
		return map[string]any{"id": id, "ok": false, "detail": err.Error()}
	}
	name := fd.Name()
	_ = fd.Close()
	_ = os.Remove(name)
	return map[string]any{"id": id, "ok": true}
}

func diagnoseFileReadable(id, p string) map[string]any {
	fi, err := os.Stat(p)
	if err != nil {
		return map[string]any{"id": id, "ok": false, "detail": err.Error()}
	}
	if fi.IsDir() {
		return map[string]any{"id": id, "ok": false, "detail": "is a directory"}
	}
	fd, err := os.Open(p)
	if err != nil {
		return map[string]any{"id": id, "ok": false, "detail": err.Error()}
	}
	_ = fd.Close()
	return map[string]any{"id": id, "ok": true}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	setNoCacheHeaders(w.Header())
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func setNoCacheHeaders(h http.Header) {
	if h == nil {
		return
	}
	h.Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	h.Set("Pragma", "no-cache")
	h.Set("Expires", "0")
	h.Set("Vary", "Authorization")
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": strings.TrimSpace(msg)})
}
