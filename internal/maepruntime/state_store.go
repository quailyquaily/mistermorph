package maepruntime

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

const (
	ChannelTelegram = "telegram"
)

type SessionState struct {
	TurnCount         int       `json:"turn_count"`
	CooldownUntil     time.Time `json:"cooldown_until,omitempty"`
	UpdatedAt         time.Time `json:"updated_at,omitempty"`
	InterestLevel     float64   `json:"interest_level"`
	LowInterestRounds int       `json:"low_interest_rounds"`
	PreferenceSynced  bool      `json:"preference_synced"`
}

type StateSnapshot struct {
	ChannelOffsets map[string]int64        `json:"channel_offsets"`
	SessionStates  map[string]SessionState `json:"session_states"`
}

type StateStore struct {
	path string
	mu   sync.Mutex
}

func NewStateStore(maepDir string) (*StateStore, error) {
	maepDir = strings.TrimSpace(maepDir)
	if maepDir == "" {
		return nil, fmt.Errorf("maep dir is required")
	}
	expanded := pathutil.ExpandHomePath(maepDir)
	path := filepath.Join(expanded, "runtime", "state.json")
	return &StateStore{path: path}, nil
}

func (s *StateStore) Load() (StateSnapshot, bool, error) {
	if s == nil {
		return StateSnapshot{}, false, fmt.Errorf("nil state store")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return StateSnapshot{}, false, nil
		}
		return StateSnapshot{}, false, fmt.Errorf("read runtime state %s: %w", s.path, err)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return StateSnapshot{}, false, fmt.Errorf("runtime state file is empty: %s", s.path)
	}

	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var snapshot StateSnapshot
	if err := dec.Decode(&snapshot); err != nil {
		return StateSnapshot{}, false, fmt.Errorf("decode runtime state %s: %w", s.path, err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return StateSnapshot{}, false, fmt.Errorf("decode runtime state %s: trailing data", s.path)
	}
	if err := validateSnapshot(snapshot); err != nil {
		return StateSnapshot{}, false, err
	}
	return snapshot, true, nil
}

func (s *StateStore) Save(snapshot StateSnapshot) error {
	if s == nil {
		return fmt.Errorf("nil state store")
	}
	if err := validateSnapshot(snapshot); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return fsstore.WriteJSONAtomic(s.path, snapshot, fsstore.FileOptions{})
}

func validateSnapshot(snapshot StateSnapshot) error {
	if snapshot.ChannelOffsets == nil {
		return fmt.Errorf("channel_offsets is required")
	}
	if snapshot.SessionStates == nil {
		return fmt.Errorf("session_states is required")
	}
	for key, offset := range snapshot.ChannelOffsets {
		if key == "" || strings.TrimSpace(key) != key {
			return fmt.Errorf("channel offset key is invalid")
		}
		if offset < 0 {
			return fmt.Errorf("channel offset %q must be >= 0", key)
		}
	}
	for key, session := range snapshot.SessionStates {
		if key == "" || strings.TrimSpace(key) != key {
			return fmt.Errorf("session state key is invalid")
		}
		if session.TurnCount < 0 {
			return fmt.Errorf("session_state[%q].turn_count must be >= 0", key)
		}
		if session.LowInterestRounds < 0 {
			return fmt.Errorf("session_state[%q].low_interest_rounds must be >= 0", key)
		}
		if math.IsNaN(session.InterestLevel) || math.IsInf(session.InterestLevel, 0) {
			return fmt.Errorf("session_state[%q].interest_level must be finite", key)
		}
		if session.InterestLevel < 0 || session.InterestLevel > 1 {
			return fmt.Errorf("session_state[%q].interest_level must be in [0,1]", key)
		}
	}
	return nil
}
