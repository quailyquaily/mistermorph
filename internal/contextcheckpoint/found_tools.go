package contextcheckpoint

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/topicstate"
)

// MaxFoundTools is how many tools found through tool search a conversation keeps.
const MaxFoundTools = 20

const foundToolsFileName = "found_tools.json"

type foundToolsFile struct {
	Tools []string `json:"tools"`
}

func foundToolsPath(root, conversationKey string) string {
	return filepath.Join(topicstate.Dir(root, conversationKey), foundToolsFileName)
}

// LoadFoundTools returns the tools a conversation found through tool search, most recent first.
func LoadFoundTools(root, conversationKey string) ([]string, error) {
	root, conversationKey = strings.TrimSpace(root), strings.TrimSpace(conversationKey)
	if root == "" || conversationKey == "" {
		return nil, nil
	}
	var file foundToolsFile
	if _, err := fsstore.ReadJSON(foundToolsPath(root, conversationKey), &file); err != nil {
		return nil, err
	}
	return file.Tools, nil
}

// SaveFoundTools records a run's found tools ahead of the conversation's earlier ones, keeping
// the most recent MaxFoundTools.
func SaveFoundTools(root, conversationKey string, recent, earlier []string) error {
	root, conversationKey = strings.TrimSpace(root), strings.TrimSpace(conversationKey)
	if root == "" || conversationKey == "" {
		return nil
	}
	merged := make([]string, 0, MaxFoundTools)
	seen := make(map[string]bool)
	for _, name := range append(append([]string(nil), recent...), earlier...) {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		merged = append(merged, name)
		if len(merged) == MaxFoundTools {
			break
		}
	}
	return fsstore.WriteJSONAtomic(foundToolsPath(root, conversationKey), foundToolsFile{Tools: merged}, fsstore.FileOptions{})
}

// ClearFoundTools forgets a conversation's found tools.
func ClearFoundTools(root, conversationKey string) error {
	root, conversationKey = strings.TrimSpace(root), strings.TrimSpace(conversationKey)
	if root == "" || conversationKey == "" {
		return nil
	}
	if err := os.Remove(foundToolsPath(root, conversationKey)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
