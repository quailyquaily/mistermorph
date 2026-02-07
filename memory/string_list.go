package memory

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// StringList accepts both YAML scalar and YAML sequence, and normalizes to []string.
type StringList []string

func (s *StringList) UnmarshalYAML(node *yaml.Node) error {
	if s == nil {
		return fmt.Errorf("nil StringList")
	}
	if node == nil {
		*s = nil
		return nil
	}
	switch node.Kind {
	case yaml.ScalarNode:
		v := strings.TrimSpace(node.Value)
		if v == "" {
			*s = nil
			return nil
		}
		*s = StringList([]string{v})
		return nil
	case yaml.SequenceNode:
		out := make([]string, 0, len(node.Content))
		for _, item := range node.Content {
			if item == nil || item.Kind != yaml.ScalarNode {
				return fmt.Errorf("invalid list item kind: %d", item.Kind)
			}
			v := strings.TrimSpace(item.Value)
			if v == "" {
				continue
			}
			out = append(out, v)
		}
		*s = StringList(out)
		return nil
	default:
		return fmt.Errorf("invalid yaml kind for StringList: %d", node.Kind)
	}
}

func (s StringList) MarshalYAML() (any, error) {
	if len(s) == 0 {
		return []string(nil), nil
	}
	out := make([]string, 0, len(s))
	for _, item := range s {
		v := strings.TrimSpace(item)
		if v == "" {
			continue
		}
		out = append(out, v)
	}
	return out, nil
}
