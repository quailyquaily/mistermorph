package promptprofile

import (
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/memories"
)

func TestAppendMemoriesBlock(t *testing.T) {
	item := memories.Memory{
		ID: "mem_1", Subject: "contact:tg:@alice", Name: "timezone", Type: memories.TypePerson,
		Description: "Alice works in JST", Body: "Alice is in Tokyo.\nShe prefers mornings.", ToldBy: "tg:@alice", UpdatedAt: "2026-10-27T03:00:00Z",
	}
	for _, tc := range []struct {
		name     string
		who      audience.Audience
		items    []memories.Memory
		readOnly bool
		want     []string
		absent   []string
	}{
		{"contact with memories", audience.Contact("tg:@alice"), []memories.Memory{item}, false,
			[]string{"[[ Memories ]]", "one contact (tg:@alice) in a direct message", "When to save", "mem_1 · contact:tg:@alice · timezone (person, updated 2026-10-27, told by tg:@alice): Alice works in JST", "  She prefers mornings."},
			nil},
		{"group", audience.Conversation("tg:-100"), nil, false, []string{"public square", "No memories here yet."}, nil},
		{"read-only owner", audience.Owner(), nil, true, []string{"the owner", "does not save or forget"}, []string{"When to save"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec := agent.PromptSpec{}
			AppendMemoriesBlock(&spec, tc.who, tc.items, false, tc.readOnly)
			if len(spec.Blocks) != 1 {
				t.Fatalf("blocks = %d, want 1", len(spec.Blocks))
			}
			content := spec.Blocks[0].Content
			for _, want := range tc.want {
				if !strings.Contains(content, want) {
					t.Fatalf("block missing %q:\n%s", want, content)
				}
			}
			for _, absent := range tc.absent {
				if strings.Contains(content, absent) {
					t.Fatalf("block has %q:\n%s", absent, content)
				}
			}
		})
	}

	spec := agent.PromptSpec{}
	AppendMemoriesBlock(&spec, audience.Audience{}, []memories.Memory{item}, false, false)
	if len(spec.Blocks) != 0 {
		t.Fatal("block added for a run with no audience")
	}
}

func TestMemoriesBlockListsOnlyDescriptionsPastTheBudget(t *testing.T) {
	var items []memories.Memory
	for i := 0; i < 4; i++ {
		items = append(items, memories.Memory{ID: "mem", Subject: "owner", Name: "big", Type: memories.TypeContext, Description: "a big one", Body: strings.Repeat("x", MemoriesInlineBudget/3)})
	}
	spec := agent.PromptSpec{}
	AppendMemoriesBlock(&spec, audience.Owner(), items, true, false)
	content := spec.Blocks[0].Content
	if strings.Contains(content, "xxxx") || !strings.Contains(content, "descriptions only") || !strings.Contains(content, "More memories exist") {
		t.Fatalf("block over budget:\n%s", content)
	}
}
