package todo

import (
	"context"
	"strings"
	"testing"
)

func TestLLMReferenceResolverResolveAddContentOK(t *testing.T) {
	client := &stubTodoLLMClient{
		replies: []string{
			`{"status":"ok","rewritten_content":"提醒 John (tg:id:1001) 明天确认","warnings":["  x  ","x",""]}`,
		},
	}
	resolver := NewLLMReferenceResolver(client, "gpt-5.2")
	rewritten, warnings, err := resolver.ResolveAddContent(context.Background(), "提醒 John 明天确认", ContactSnapshot{
		Contacts: []ContactSnapshotItem{
			{Name: "John", ReachableIDs: []string{"tg:id:1001"}, PreferredID: "tg:id:1001"},
		},
		ReachableIDs: []string{"tg:id:1001"},
	})
	if err != nil {
		t.Fatalf("ResolveAddContent() error = %v", err)
	}
	if rewritten != "提醒 John (tg:id:1001) 明天确认" {
		t.Fatalf("rewritten mismatch: %q", rewritten)
	}
	if len(warnings) != 1 || warnings[0] != "x" {
		t.Fatalf("warnings mismatch: %#v", warnings)
	}
}

func TestLLMReferenceResolverResolveAddContentMissingReference(t *testing.T) {
	client := &stubTodoLLMClient{
		replies: []string{
			`{"status":"missing_reference_id","missing":[{"mention":"John","suggestion":"John (tg:id:1001)"}]}`,
		},
	}
	resolver := NewLLMReferenceResolver(client, "gpt-5.2")
	_, _, err := resolver.ResolveAddContent(context.Background(), "提醒 John 明天确认", ContactSnapshot{})
	if err == nil {
		t.Fatalf("expected missing_reference_id error")
	}
	var missingErr *MissingReferenceIDError
	if !strings.Contains(strings.ToLower(err.Error()), "missing_reference_id") {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(err.Error(), "John") || !strings.Contains(err.Error(), "tg:id:1001") {
		t.Fatalf("missing error detail: %v", err)
	}
	if !asMissingReferenceError(err, &missingErr) || missingErr == nil || len(missingErr.Items) != 1 {
		t.Fatalf("expected MissingReferenceIDError, got %T", err)
	}
}

func TestLLMReferenceResolverResolveAddContentRejectsNonStrictJSON(t *testing.T) {
	client := &stubTodoLLMClient{
		replies: []string{"```json\n{\"status\":\"ok\",\"rewritten_content\":\"x\"}\n```"},
	}
	resolver := NewLLMReferenceResolver(client, "gpt-5.2")
	_, _, err := resolver.ResolveAddContent(context.Background(), "提醒 John 明天确认", ContactSnapshot{})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "invalid reference_resolve response") {
		t.Fatalf("expected strict-json parse error, got %v", err)
	}
}

func asMissingReferenceError(err error, target **MissingReferenceIDError) bool {
	if err == nil || target == nil {
		return false
	}
	v, ok := err.(*MissingReferenceIDError)
	if !ok {
		return false
	}
	*target = v
	return true
}
