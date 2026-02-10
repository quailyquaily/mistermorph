package todo

import (
	"context"
	"time"
)

const (
	TimestampLayout     = "2006-01-02 15:04"
	HeaderWIP           = "# TODO Work In Progress (WIP)"
	HeaderDONE          = "# TODO Done"
	DefaultWIPFilename  = "TODO.md"
	DefaultDONEFilename = "TODO.DONE.md"
)

type Entry struct {
	Done      bool   `json:"done"`
	CreatedAt string `json:"created_at"`
	DoneAt    string `json:"done_at,omitempty"`
	ChatID    string `json:"chat_id,omitempty"`
	Content   string `json:"content"`
}

type WIPFile struct {
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
	OpenCount int     `json:"open_count"`
	Entries   []Entry `json:"entries"`
}

type DONEFile struct {
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
	DoneCount int     `json:"done_count"`
	Entries   []Entry `json:"entries"`
}

type Changed struct {
	WIPAdded   int `json:"wip_added"`
	WIPRemoved int `json:"wip_removed"`
	DONEAdded  int `json:"done_added"`
}

type UpdateResult struct {
	OK            bool     `json:"ok"`
	Action        string   `json:"action"`
	UpdatedCounts Counts   `json:"updated_counts"`
	Changed       Changed  `json:"changed"`
	Entry         *Entry   `json:"entry,omitempty"`
	Warnings      []string `json:"warnings,omitempty"`
}

type Counts struct {
	OpenCount int `json:"open_count"`
	DoneCount int `json:"done_count"`
}

type ListResult struct {
	Scope       string  `json:"scope"`
	OpenCount   int     `json:"open_count"`
	DoneCount   int     `json:"done_count"`
	WIPItems    []Entry `json:"wip_items,omitempty"`
	DONEItems   []Entry `json:"done_items,omitempty"`
	WIPPath     string  `json:"wip_path,omitempty"`
	DONEPath    string  `json:"done_path,omitempty"`
	GeneratedAt string  `json:"generated_at"`
}

type SemanticResolver interface {
	SelectDedupKeepIndices(ctx context.Context, entries []Entry) ([]int, error)
	MatchCompleteIndex(ctx context.Context, query string, entries []Entry) (int, error)
}

type Store struct {
	WIPPath   string
	DONEPath  string
	Now       func() time.Time
	Semantics SemanticResolver
}
