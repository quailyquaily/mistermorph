package todo

import (
	"fmt"
	"sort"
	"strings"
)

func ExtractReferenceIDs(content string) ([]string, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return nil, fmt.Errorf("content is required")
	}
	matches := parenPattern.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return nil, nil
	}
	seen := make(map[string]bool, len(matches))
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		ref := strings.TrimSpace(m[1])
		if ref == "" {
			return nil, fmt.Errorf("missing reference id")
		}
		if !isValidReferenceID(ref) {
			return nil, fmt.Errorf("invalid reference id: %s", ref)
		}
		if seen[ref] {
			continue
		}
		seen[ref] = true
		out = append(out, ref)
	}
	return out, nil
}

func ValidateReachableReferences(content string, snapshot ContactSnapshot) error {
	refs, err := ExtractReferenceIDs(content)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		if snapshot.HasReachableID(ref) {
			continue
		}
		return fmt.Errorf("reference id is not reachable: %s", ref)
	}
	return nil
}

func dedupeSortedStrings(items []string) []string {
	if len(items) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(items))
	out := make([]string, 0, len(items))
	for _, raw := range items {
		v := strings.TrimSpace(raw)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}
