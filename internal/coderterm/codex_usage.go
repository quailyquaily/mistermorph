package coderterm

import (
	"fmt"
	"path/filepath"
)

type codexBackend struct{}

func (codexBackend) transcriptRoot(getenv func(string) string, home, cwd string) string {
	return filepath.Join(configDir(getenv, "CODEX_HOME", home, ".codex", cwd), "sessions")
}

func (codexBackend) findTranscript(root, id string) (string, error) {
	matches, err := filepath.Glob(filepath.Join(root, "*", "*", "*", "rollout-*-"+id+".jsonl"))
	if err != nil || len(matches) == 0 {
		return "", err
	}
	if len(matches) > 1 {
		return "", fmt.Errorf("Codex has %d session files for %s", len(matches), id)
	}
	return matches[0], nil
}

type codexAgentActivity struct {
	Agent string `json:"agent_thread_id"`
}
type codexEntry struct {
	Type    string `json:"type"`
	Payload struct {
		Type string `json:"type"`
		codexAgentActivity
		Item struct {
			Type string `json:"type"`
			codexAgentActivity
		} `json:"item"`
	} `json:"payload"`
}

func (e codexEntry) agentActivity() (codexAgentActivity, bool) {
	p := e.Payload
	if e.Type == "event_msg" {
		if p.Type == "sub_agent_activity" {
			return p.codexAgentActivity, true
		}
		if p.Type == "item_completed" && p.Item.Type == "SubAgentActivity" {
			return p.Item.codexAgentActivity, true
		}
	}
	return codexAgentActivity{}, false
}
