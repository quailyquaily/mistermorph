package todo

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

var (
	// Strip already-annotated mentions like "John (tg:1001)" before
	// scanning for missing first-person references.
	annotatedMentionPattern = regexp.MustCompile(`[^()\s]+\s*\([^()]+\)`)
	englishSelfWordPattern  = regexp.MustCompile(`(?i)\b(i|me|my|myself|we|us|our|ourselves)\b`)
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

// ValidateRequiredReferenceMentions enforces that first-person object mentions
// are explicitly referenceable (e.g. "我 (tg:1001)" / "me (tg:1001)").
func ValidateRequiredReferenceMentions(content string, snapshot ContactSnapshot) error {
	content = strings.TrimSpace(content)
	if content == "" {
		return fmt.Errorf("content is required")
	}
	stripped := annotatedMentionPattern.ReplaceAllString(content, "")
	mention := firstPersonMention(stripped)
	if mention == "" {
		return nil
	}

	item := MissingReference{Mention: mention}
	if ref := suggestSelfReferenceID(snapshot); ref != "" {
		item.Suggestion = strings.TrimSpace(mention) + " (" + ref + ")"
	}
	return &MissingReferenceIDError{Items: []MissingReference{item}}
}

// AnnotateFirstPersonReference rewrites one unannotated first-person mention
// into "mention (refID)". It returns (rewritten, changed, error).
func AnnotateFirstPersonReference(content string, refID string) (string, bool, error) {
	content = strings.TrimSpace(content)
	refID = strings.TrimSpace(refID)
	if content == "" {
		return "", false, fmt.Errorf("content is required")
	}
	if refID == "" {
		return content, false, nil
	}
	if !isValidReferenceID(refID) {
		return "", false, fmt.Errorf("invalid reference id: %s", refID)
	}

	stripped := annotatedMentionPattern.ReplaceAllString(content, "")
	if firstPersonMention(stripped) == "" {
		return content, false, nil
	}

	for _, token := range []string{"我们", "本人", "我"} {
		if rewritten, ok := annotateFirstUnannotatedLiteral(content, token, refID); ok {
			return rewritten, true, nil
		}
	}
	if rewritten, ok := annotateFirstUnannotatedEnglishSelf(content, refID); ok {
		return rewritten, true, nil
	}
	return content, false, nil
}

func firstPersonMention(content string) string {
	content = strings.TrimSpace(content)
	if content == "" {
		return ""
	}
	for _, token := range []string{"我们", "本人", "我"} {
		if strings.Contains(content, token) {
			return token
		}
	}
	if m := englishSelfWordPattern.FindString(content); strings.TrimSpace(m) != "" {
		return strings.TrimSpace(m)
	}
	return ""
}

func annotateFirstUnannotatedLiteral(content string, token string, refID string) (string, bool) {
	token = strings.TrimSpace(token)
	if token == "" {
		return content, false
	}
	searchPos := 0
	for {
		off := strings.Index(content[searchPos:], token)
		if off < 0 {
			return content, false
		}
		start := searchPos + off
		end := start + len(token)
		if hasInlineReferenceSuffix(content, end) {
			searchPos = end
			continue
		}
		annotated := token + " (" + refID + ")" + annotationSpacer(content, end)
		return content[:start] + annotated + content[end:], true
	}
}

func annotateFirstUnannotatedEnglishSelf(content string, refID string) (string, bool) {
	indices := englishSelfWordPattern.FindAllStringIndex(content, -1)
	for _, pair := range indices {
		if len(pair) != 2 {
			continue
		}
		start, end := pair[0], pair[1]
		if start < 0 || end > len(content) || start >= end {
			continue
		}
		if hasInlineReferenceSuffix(content, end) {
			continue
		}
		word := content[start:end]
		annotated := word + " (" + refID + ")" + annotationSpacer(content, end)
		return content[:start] + annotated + content[end:], true
	}
	return content, false
}

func hasInlineReferenceSuffix(content string, pos int) bool {
	if pos < 0 {
		pos = 0
	}
	for pos < len(content) {
		switch content[pos] {
		case ' ', '\t':
			pos++
			continue
		case '(':
			return true
		default:
			return false
		}
	}
	return false
}

func annotationSpacer(content string, pos int) string {
	if pos < 0 || pos >= len(content) {
		return ""
	}
	r, _ := utf8.DecodeRuneInString(content[pos:])
	switch r {
	case ' ', '\t', '\n',
		',', '.', '!', '?', ':', ';',
		'，', '。', '！', '？', '：', '；', '、',
		')', ']', '}', '】', '）':
		return ""
	default:
		return " "
	}
}

func suggestSelfReferenceID(snapshot ContactSnapshot) string {
	ids := dedupeSortedStrings(snapshot.ReachableIDs)
	if len(ids) == 0 {
		return ""
	}

	tgIDs := make([]string, 0, len(ids))
	for _, id := range ids {
		if strings.HasPrefix(id, "tg:") {
			tgIDs = append(tgIDs, id)
		}
	}
	tgIDs = dedupeSortedStrings(tgIDs)
	if len(tgIDs) == 1 {
		return tgIDs[0]
	}

	preferred := make([]string, 0, len(snapshot.Contacts))
	for _, c := range snapshot.Contacts {
		id := strings.TrimSpace(c.PreferredID)
		if id == "" || !isValidReferenceID(id) {
			continue
		}
		preferred = append(preferred, id)
	}
	preferred = dedupeSortedStrings(preferred)
	if len(preferred) == 1 {
		return preferred[0]
	}
	return ""
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
