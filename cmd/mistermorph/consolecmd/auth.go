package consolecmd

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
	"golang.org/x/crypto/bcrypt"
)

type passwordVerifier struct {
	plain string
	hash  string
}

func newPasswordVerifier(plain, hash string) (*passwordVerifier, error) {
	plain = strings.TrimSpace(plain)
	hash = strings.TrimSpace(hash)
	if plain == "" && hash == "" {
		return nil, fmt.Errorf("missing console password (set console.password/console.password_hash or env)")
	}
	if hash != "" && !strings.HasPrefix(hash, "$2") {
		return nil, fmt.Errorf("console.password_hash currently supports bcrypt hashes only")
	}
	return &passwordVerifier{
		plain: plain,
		hash:  hash,
	}, nil
}

func consolePasswordConfigured(plain, hash string) bool {
	return strings.TrimSpace(plain) != "" || strings.TrimSpace(hash) != ""
}

func (v *passwordVerifier) Verify(candidate string) bool {
	if v == nil {
		return false
	}
	if strings.TrimSpace(v.hash) != "" {
		return bcrypt.CompareHashAndPassword([]byte(v.hash), []byte(candidate)) == nil
	}
	left := []byte(v.plain)
	right := []byte(candidate)
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare(left, right) == 1
}

type tokenSession struct {
	ExpiresAt time.Time
}

// sessionPruneInterval is how often Validate deletes expired sessions from agent.db.
const sessionPruneInterval = time.Minute

// sessionStore holds Console login sessions: in agent.db (console_sessions) when it has a state
// folder, so a restart keeps people logged in, or in memory (stream tickets). Only a token's
// SHA-256 is kept, never the token.
type sessionStore struct {
	mu        sync.Mutex
	db        *agentdb.DB
	sessions  map[string]tokenSession
	lastPrune time.Time
}

func init() {
	agentdb.Register(agentdb.Importer{Name: "console_sessions", Order: 70, Run: importConsoleSessions})
}

// legacySessionsFile is console/sessions.json, which held the sessions before agent.db.
var legacySessionsFile = filepath.Join("console", "sessions.json")

type persistedSessions struct {
	Version  int               `json:"version"`
	Sessions map[string]string `json:"sessions"`
}

func importConsoleSessions(ctx context.Context, tx *sql.Tx, env agentdb.ImportEnv) (agentdb.ImportResult, error) {
	var result agentdb.ImportResult
	raw, err := os.ReadFile(filepath.Join(env.StateDir, legacySessionsFile))
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Rename = append(result.Rename, filepath.ToSlash(legacySessionsFile))
	var payload persistedSessions
	if err := json.Unmarshal(raw, &payload); err != nil {
		result.Rejects = append(result.Rejects, stateimport.Reject{Source: filepath.ToSlash(legacySessionsFile), Error: err.Error()})
		return result, nil
	}
	now := time.Now().UTC()
	for hash, expiresRaw := range payload.Sessions {
		hash = strings.TrimSpace(hash)
		expiresAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(expiresRaw))
		if hash == "" || err != nil {
			result.Rejects = append(result.Rejects, stateimport.Reject{Source: filepath.ToSlash(legacySessionsFile), Error: "bad session entry"})
			continue
		}
		if !expiresAt.After(now) {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO console_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)`,
			hash, agentdb.FormatTime(now), agentdb.FormatTime(expiresAt)); err != nil {
			return result, err
		}
	}
	return result, nil
}

// newSessionStore keeps sessions in agent.db in stateDir, or in memory when stateDir is "" or the
// database cannot open.
func newSessionStore(stateDir string) *sessionStore {
	store := &sessionStore{sessions: map[string]tokenSession{}}
	if strings.TrimSpace(stateDir) == "" {
		return store
	}
	db, err := agentdb.OpenStateDir(context.Background(), stateDir)
	if err != nil {
		slog.Default().Warn("console_sessions_store_unavailable", "error", err)
		return store
	}
	store.db = db
	return store
}

// Close releases the store's database handle.
func (s *sessionStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *sessionStore) Create(ttl time.Duration) (string, time.Time, error) {
	if s == nil {
		return "", time.Time{}, fmt.Errorf("nil session store")
	}
	if ttl <= 0 {
		ttl = 7 * 24 * time.Hour
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	hash := tokenHash(token)
	now := time.Now().UTC()
	// agent.db keeps times to the second.
	expiresAt := now.Add(ttl).Truncate(time.Second)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		ctx := context.Background()
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return "", time.Time{}, err
		}
		defer func() { _ = tx.Rollback() }()
		if _, err := tx.ExecContext(ctx, `DELETE FROM console_sessions WHERE expires_at <= ?`, agentdb.FormatTime(now)); err != nil {
			return "", time.Time{}, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO console_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)`,
			hash, agentdb.FormatTime(now), agentdb.FormatTime(expiresAt)); err != nil {
			return "", time.Time{}, err
		}
		if err := tx.Commit(); err != nil {
			return "", time.Time{}, err
		}
		s.lastPrune = now
		return token, expiresAt, nil
	}
	s.pruneExpiredLocked(now)
	s.sessions[hash] = tokenSession{ExpiresAt: expiresAt}
	return token, expiresAt, nil
}

func (s *sessionStore) Validate(token string) (time.Time, bool) {
	if s == nil {
		return time.Time{}, false
	}
	hash := tokenHash(token)
	now := time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		ctx := context.Background()
		if now.Sub(s.lastPrune) >= sessionPruneInterval {
			if _, err := s.db.ExecContext(ctx, `DELETE FROM console_sessions WHERE expires_at <= ?`, agentdb.FormatTime(now)); err == nil {
				s.lastPrune = now
			}
		}
		var raw string
		if err := s.db.QueryRowContext(ctx, `SELECT expires_at FROM console_sessions WHERE token_hash = ?`, hash).Scan(&raw); err != nil {
			return time.Time{}, false
		}
		expiresAt, err := agentdb.ParseTime(raw)
		if err != nil || !expiresAt.After(now) {
			_, _ = s.db.ExecContext(ctx, `DELETE FROM console_sessions WHERE token_hash = ?`, hash)
			return time.Time{}, false
		}
		return expiresAt.UTC(), true
	}
	s.pruneExpiredLocked(now)
	session, ok := s.sessions[hash]
	if !ok || !session.ExpiresAt.After(now) {
		delete(s.sessions, hash)
		return time.Time{}, false
	}
	return session.ExpiresAt, true
}

func (s *sessionStore) Delete(token string) {
	if s == nil {
		return
	}
	hash := tokenHash(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		_, _ = s.db.ExecContext(context.Background(), `DELETE FROM console_sessions WHERE token_hash = ?`, hash)
		return
	}
	delete(s.sessions, hash)
}

func (s *sessionStore) pruneExpiredLocked(now time.Time) {
	for k, v := range s.sessions {
		if !v.ExpiresAt.After(now) {
			delete(s.sessions, k)
		}
	}
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

type loginLimiter struct {
	mu                sync.Mutex
	window            time.Duration
	maxFailuresPerIP  int
	maxFailuresPerKey int
	lockDuration      time.Duration
	delayMin          time.Duration
	delayMax          time.Duration
	ipFailures        map[string][]time.Time
	keyFailures       map[string][]time.Time
	locks             map[string]time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{
		window:            10 * time.Minute,
		maxFailuresPerIP:  20,
		maxFailuresPerKey: 5,
		lockDuration:      15 * time.Minute,
		delayMin:          200 * time.Millisecond,
		delayMax:          1200 * time.Millisecond,
		ipFailures:        map[string][]time.Time{},
		keyFailures:       map[string][]time.Time{},
		locks:             map[string]time.Time{},
	}
}

func (l *loginLimiter) CheckLocked(key string, now time.Time) (time.Duration, bool) {
	if l == nil {
		return 0, false
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return 0, false
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	l.pruneLocked(now)
	until, ok := l.locks[key]
	if !ok || !until.After(now) {
		return 0, false
	}
	return until.Sub(now), true
}

func (l *loginLimiter) RecordFailure(ip, key string, now time.Time) time.Time {
	if l == nil {
		return time.Time{}
	}
	ip = strings.TrimSpace(ip)
	key = strings.TrimSpace(key)

	l.mu.Lock()
	defer l.mu.Unlock()

	l.pruneFailuresLocked(now)
	l.pruneLocked(now)

	if ip != "" {
		l.ipFailures[ip] = append(l.ipFailures[ip], now)
	}
	if key != "" {
		l.keyFailures[key] = append(l.keyFailures[key], now)
	}

	reachedIP := ip != "" && len(l.ipFailures[ip]) >= l.maxFailuresPerIP
	reachedKey := key != "" && len(l.keyFailures[key]) >= l.maxFailuresPerKey
	if reachedIP || reachedKey {
		lockUntil := now.Add(l.lockDuration)
		if key != "" {
			l.locks[key] = lockUntil
		}
		return lockUntil
	}
	return time.Time{}
}

func (l *loginLimiter) RecordSuccess(ip, key string, now time.Time) {
	if l == nil {
		return
	}
	ip = strings.TrimSpace(ip)
	key = strings.TrimSpace(key)

	l.mu.Lock()
	defer l.mu.Unlock()

	l.pruneFailuresLocked(now)
	l.pruneLocked(now)
	if ip != "" {
		delete(l.ipFailures, ip)
	}
	if key != "" {
		delete(l.keyFailures, key)
		delete(l.locks, key)
	}
}

func (l *loginLimiter) FailureDelay() time.Duration {
	if l == nil {
		return 0
	}
	if l.delayMax <= l.delayMin {
		return l.delayMin
	}
	span := l.delayMax - l.delayMin
	// 8 random bytes -> uint64.
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return l.delayMin
	}
	var n uint64
	for _, b := range buf {
		n = (n << 8) | uint64(b)
	}
	return l.delayMin + time.Duration(n%uint64(span))
}

func (l *loginLimiter) pruneFailuresLocked(now time.Time) {
	cutoff := now.Add(-l.window)
	for ip, items := range l.ipFailures {
		next := filterRecent(items, cutoff)
		if len(next) == 0 {
			delete(l.ipFailures, ip)
			continue
		}
		l.ipFailures[ip] = next
	}
	for key, items := range l.keyFailures {
		next := filterRecent(items, cutoff)
		if len(next) == 0 {
			delete(l.keyFailures, key)
			continue
		}
		l.keyFailures[key] = next
	}
}

func (l *loginLimiter) pruneLocked(now time.Time) {
	for key, until := range l.locks {
		if !until.After(now) {
			delete(l.locks, key)
		}
	}
}

func filterRecent(items []time.Time, cutoff time.Time) []time.Time {
	if len(items) == 0 {
		return nil
	}
	out := make([]time.Time, 0, len(items))
	for _, ts := range items {
		if ts.After(cutoff) {
			out = append(out, ts)
		}
	}
	return out
}
