package memory

import "time"

type RequestContext string

const (
	ContextUnknown RequestContext = "unknown"
	ContextPublic  RequestContext = "public"
	ContextPrivate RequestContext = "private"
)

type Frontmatter struct {
	CreatedAt        string     `yaml:"created_at"`
	UpdatedAt        string     `yaml:"updated_at"`
	Summary          string     `yaml:"summary"`
	Tasks            string     `yaml:"tasks,omitempty"`
	SessionID        string     `yaml:"session_id,omitempty"`
	Tags             []string   `yaml:"tags,omitempty"`
	ContactIDs       StringList `yaml:"contact_id,omitempty"`
	ContactNicknames StringList `yaml:"contact_nickname,omitempty"`
}

type Manager struct {
	Dir           string
	ShortTermDays int
	Now           func() time.Time
}

type KVItem struct {
	Title string `json:"title"`
	Value string `json:"value"`
}

type PromoteDraft struct {
	GoalsProjects []string `json:"goals_projects"`
	KeyFacts      []KVItem `json:"key_facts"`
}

type SessionDraft struct {
	SummaryItems []string     `json:"summary_items"`
	Promote      PromoteDraft `json:"promote"`
}

type ShortTermSummary struct {
	Date    string
	Summary string
	RelPath string
}

// ShortTermContent is the parsed representation of a short-term session file.
type ShortTermContent struct {
	SummaryItems []SummaryItem
}

type SummaryItem struct {
	Created string `json:"created"`
	Content string `json:"content"`
}

type LongTermGoal struct {
	Done    bool   `json:"done"`
	Created string `json:"created"`
	DoneAt  string `json:"done_at,omitempty"`
	Content string `json:"content"`
}

type LongTermContent struct {
	Goals []LongTermGoal
	Facts []KVItem
}
