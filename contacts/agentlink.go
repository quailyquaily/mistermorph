package contacts

import (
	"regexp"
	"strings"
)

// agentLinkProtocol is the contact ID protocol of Agent Link agents: mm:<instance_id>.
const agentLinkProtocol = "mm"

var agentLinkInstanceIDPattern = regexp.MustCompile(`^inst_[0-9a-f]{32}$`)

// AgentLinkInstanceID returns the instance ID in an Agent Link contact ID or chat ID.
func AgentLinkInstanceID(id string) (string, bool) {
	id = strings.TrimSpace(id)
	prefix := agentLinkProtocol + ":"
	if len(id) <= len(prefix) || !strings.EqualFold(id[:len(prefix)], prefix) {
		return "", false
	}
	instanceID := strings.TrimSpace(id[len(prefix):])
	if !agentLinkInstanceIDPattern.MatchString(instanceID) {
		return "", false
	}
	return instanceID, true
}
