// Package personastore keeps the agent's identity, soul included, and its heartbeat workflows in
// agent.db: one identity row and one row per workflow. It also renders and parses the files they
// were (identity.yaml, soul.md, HEARTBEAT.md), for the import, the Console's compatibility routes
// and `morph state export` / `import`.
package personastore

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	markdownutil "github.com/quailyquaily/mistermorph/internal/markdown"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"gopkg.in/yaml.v3"
)

// Who changed a row, in updated_by.
const (
	ByConsole = "console"
	ByInstall = "install"
	ByImport  = "import"
	ByCLI     = "cli"
)

// identityKeys are the identity fields that have columns, in the order identity.yaml had them.
var identityKeys = []string{"name", "name_alts", "creature", "vibe", "emoji"}

// Identity is the identity row: who the agent is, and its soul.
type Identity struct {
	Name     string   `json:"name"`
	NameAlts []string `json:"name_alts"`
	Creature string   `json:"creature"`
	Vibe     string   `json:"vibe"`
	Emoji    string   `json:"emoji"`
	// Soul is Markdown the model reads whole; "" for none.
	Soul string `json:"soul"`
	// Extra are keys an owner added to identity.yaml beyond the five, in their order.
	Extra     Extra  `json:"extra"`
	UpdatedAt string `json:"updated_at,omitempty"`
	UpdatedBy string `json:"updated_by,omitempty"`
}

// ExtraField is one key of Extra.
type ExtraField struct {
	Key   string
	Value any
}

// Extra keeps the keys in order, and is a JSON object.
type Extra []ExtraField

// MarshalJSON writes the fields as a JSON object in their order.
func (e Extra) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, field := range e {
		if i > 0 {
			buf.WriteByte(',')
		}
		key, err := json.Marshal(field.Key)
		if err != nil {
			return nil, err
		}
		value, err := json.Marshal(field.Value)
		if err != nil {
			return nil, err
		}
		buf.Write(key)
		buf.WriteByte(':')
		buf.Write(value)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// UnmarshalJSON reads a JSON object, keeping its keys in order.
func (e *Extra) UnmarshalJSON(data []byte) error {
	*e = nil
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if tok == nil {
		return nil
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return fmt.Errorf("extra must be a JSON object")
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		key, _ := tok.(string)
		var value any
		if err := dec.Decode(&value); err != nil {
			return err
		}
		*e = append(*e, ExtraField{Key: key, Value: value})
	}
	_, err = dec.Token()
	return err
}

// Store is the persona in agent.db.
type Store struct {
	db     *agentdb.DB
	cached bool
}

// New returns the persona store on db.
func New(db *agentdb.DB) *Store {
	return &Store{db: db}
}

// Open opens agent.db in stateDir; the caller closes the store.
func Open(ctx context.Context, stateDir string) (*Store, error) {
	db, err := agentdb.OpenStateDir(ctx, stateDir)
	if err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

// OpenPersonaDir opens agent.db for a persona folder (<state>/persona), as the prompt code names
// the persona by its folder.
func OpenPersonaDir(ctx context.Context, personaDir string) (*Store, error) {
	personaDir = strings.TrimSpace(personaDir)
	if personaDir == "" {
		personaDir = statepaths.PersonaDir()
	}
	return Open(ctx, filepath.Dir(filepath.Clean(personaDir)))
}

// Close releases the store's database handle.
func (s *Store) Close() error {
	if s == nil || s.db == nil || s.cached {
		return nil
	}
	return s.db.Close()
}

// DB is the database.
func (s *Store) DB() *agentdb.DB { return s.db }

type queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Identity returns the identity row, and whether there is one.
func (s *Store) Identity(ctx context.Context) (Identity, bool, error) {
	return readIdentity(ctx, s.db)
}

func readIdentity(ctx context.Context, q queryer) (Identity, bool, error) {
	var id Identity
	var alts, extra string
	err := q.QueryRowContext(ctx, `SELECT name, name_alts, creature, vibe, emoji, soul, extra, updated_at, updated_by
		FROM identity WHERE id = 1`).Scan(&id.Name, &alts, &id.Creature, &id.Vibe, &id.Emoji, &id.Soul, &extra, &id.UpdatedAt, &id.UpdatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return Identity{}, false, nil
	}
	if err != nil {
		return Identity{}, false, err
	}
	if err := json.Unmarshal([]byte(alts), &id.NameAlts); err != nil {
		return Identity{}, false, fmt.Errorf("identity name_alts: %w", err)
	}
	if err := json.Unmarshal([]byte(extra), &id.Extra); err != nil {
		return Identity{}, false, fmt.Errorf("identity extra: %w", err)
	}
	if id.NameAlts == nil {
		id.NameAlts = []string{}
	}
	return id, true, nil
}

// SaveIdentity replaces the identity row.
func (s *Store) SaveIdentity(ctx context.Context, id Identity, by string) (Identity, error) {
	if err := writeIdentity(ctx, s.db, id, by); err != nil {
		return Identity{}, err
	}
	saved, _, err := s.Identity(ctx)
	return saved, err
}

func writeIdentity(ctx context.Context, db execer, id Identity, by string) error {
	id = normalizeIdentity(id)
	alts, err := json.Marshal(id.NameAlts)
	if err != nil {
		return err
	}
	extra, err := json.Marshal(id.Extra)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO identity (id, name, name_alts, creature, vibe, emoji, soul, extra, updated_at, updated_by)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_alts = excluded.name_alts, creature = excluded.creature,
		vibe = excluded.vibe, emoji = excluded.emoji, soul = excluded.soul, extra = excluded.extra,
		updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
		id.Name, string(alts), id.Creature, id.Vibe, id.Emoji, id.Soul, string(extra), agentdb.Now(), strings.TrimSpace(by))
	return err
}

// IdentityPatch changes some fields of the identity; nil fields stay as they are.
type IdentityPatch struct {
	Name     *string   `json:"name,omitempty"`
	NameAlts *[]string `json:"name_alts,omitempty"`
	Creature *string   `json:"creature,omitempty"`
	Vibe     *string   `json:"vibe,omitempty"`
	Emoji    *string   `json:"emoji,omitempty"`
	Soul     *string   `json:"soul,omitempty"`
	Extra    *Extra    `json:"extra,omitempty"`
}

// PatchIdentity changes the fields set in patch, in one transaction, creating the row if needed.
func (s *Store) PatchIdentity(ctx context.Context, patch IdentityPatch, by string) (Identity, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Identity{}, err
	}
	defer func() { _ = tx.Rollback() }()
	id, _, err := readIdentity(ctx, tx)
	if err != nil {
		return Identity{}, err
	}
	if patch.Name != nil {
		id.Name = *patch.Name
	}
	if patch.NameAlts != nil {
		id.NameAlts = *patch.NameAlts
	}
	if patch.Creature != nil {
		id.Creature = *patch.Creature
	}
	if patch.Vibe != nil {
		id.Vibe = *patch.Vibe
	}
	if patch.Emoji != nil {
		id.Emoji = *patch.Emoji
	}
	if patch.Soul != nil {
		id.Soul = *patch.Soul
	}
	if patch.Extra != nil {
		id.Extra = *patch.Extra
	}
	if err := writeIdentity(ctx, tx, id, by); err != nil {
		return Identity{}, err
	}
	if err := tx.Commit(); err != nil {
		return Identity{}, err
	}
	saved, _, err := s.Identity(ctx)
	return saved, err
}

func normalizeIdentity(id Identity) Identity {
	id.Name = strings.TrimSpace(id.Name)
	id.Creature = strings.TrimSpace(id.Creature)
	id.Vibe = strings.TrimSpace(id.Vibe)
	id.Emoji = strings.TrimSpace(id.Emoji)
	alts := make([]string, 0, len(id.NameAlts))
	for _, alt := range id.NameAlts {
		if alt = strings.TrimSpace(alt); alt != "" {
			alts = append(alts, alt)
		}
	}
	id.NameAlts = alts
	id.Soul = strings.TrimSpace(strings.ReplaceAll(id.Soul, "\r\n", "\n"))
	kept := Extra{}
	for _, field := range id.Extra {
		if strings.TrimSpace(field.Key) == "" || isIdentityKey(field.Key) {
			continue
		}
		kept = append(kept, field)
	}
	id.Extra = kept
	return id
}

func isIdentityKey(key string) bool {
	for _, k := range identityKeys {
		if k == key {
			return true
		}
	}
	return false
}

// RenderIdentityYAML writes the identity's fields as identity.yaml was: the five keys in their
// order, then the extra keys. The soul is not part of it.
func RenderIdentityYAML(id Identity) string {
	root := &yaml.Node{Kind: yaml.MappingNode}
	add := func(key string, value any) {
		var node yaml.Node
		if err := node.Encode(value); err != nil {
			return
		}
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, &node)
	}
	alts := id.NameAlts
	if alts == nil {
		alts = []string{}
	}
	add("name", id.Name)
	add("name_alts", alts)
	add("creature", id.Creature)
	add("vibe", id.Vibe)
	add("emoji", id.Emoji)
	for _, field := range id.Extra {
		add(field.Key, field.Value)
	}
	for _, node := range root.Content {
		if node.Kind == yaml.SequenceNode && scalarsOnly(node) {
			node.Style = yaml.FlowStyle
		}
		if node.Kind == yaml.ScalarNode && node.Tag == "!!str" && node.Value == "" {
			node.Style = yaml.DoubleQuotedStyle
		}
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		return ""
	}
	_ = enc.Close()
	// yaml.v3 writes characters outside the Basic Multilingual Plane (most emoji) as \U escapes;
	// the file had them as they are.
	return bigEscape.ReplaceAllStringFunc(buf.String(), func(esc string) string {
		code, err := strconv.ParseUint(esc[2:], 16, 32)
		if err != nil || !utf8.ValidRune(rune(code)) {
			return esc
		}
		return string(rune(code))
	})
}

var bigEscape = regexp.MustCompile(`\\U[0-9A-Fa-f]{8}`)

func scalarsOnly(node *yaml.Node) bool {
	for _, item := range node.Content {
		if item.Kind != yaml.ScalarNode {
			return false
		}
	}
	return true
}

// ParseIdentityYAML reads identity.yaml (or a ```yaml fence holding it) into the identity's
// fields; keys beyond the five go into Extra, in order. The soul is left empty.
func ParseIdentityYAML(raw string) (Identity, error) {
	content := strings.TrimSpace(strings.ReplaceAll(raw, "\r\n", "\n"))
	if fenced, ok := yamlFence(content); ok {
		content = fenced
	}
	id := Identity{NameAlts: []string{}, Extra: Extra{}}
	if content == "" {
		return id, nil
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(content), &doc); err != nil {
		return Identity{}, fmt.Errorf("identity.yaml is invalid: %w", err)
	}
	root := &doc
	if doc.Kind == yaml.DocumentNode {
		if len(doc.Content) == 0 {
			return id, nil
		}
		root = doc.Content[0]
	}
	if root.Kind != yaml.MappingNode {
		return Identity{}, fmt.Errorf("identity.yaml must be a mapping")
	}
	for i := 0; i+1 < len(root.Content); i += 2 {
		key := root.Content[i].Value
		valueNode := root.Content[i+1]
		switch key {
		case "name":
			id.Name = scalarText(valueNode)
		case "creature":
			id.Creature = scalarText(valueNode)
		case "vibe":
			id.Vibe = scalarText(valueNode)
		case "emoji":
			id.Emoji = scalarText(valueNode)
		case "name_alts":
			switch valueNode.Kind {
			case yaml.SequenceNode:
				for _, item := range valueNode.Content {
					if text := scalarText(item); text != "" {
						id.NameAlts = append(id.NameAlts, text)
					}
				}
			case yaml.ScalarNode:
				if text := scalarText(valueNode); text != "" {
					id.NameAlts = append(id.NameAlts, text)
				}
			}
		default:
			var value any
			if err := valueNode.Decode(&value); err != nil {
				return Identity{}, fmt.Errorf("identity.yaml %s: %w", key, err)
			}
			id.Extra = append(id.Extra, ExtraField{Key: key, Value: jsonCompatible(value)})
		}
	}
	return normalizeIdentity(id), nil
}

func scalarText(node *yaml.Node) string {
	if node == nil || node.Kind != yaml.ScalarNode || node.Tag == "!!null" {
		return ""
	}
	return strings.TrimSpace(node.Value)
}

func yamlFence(content string) (string, bool) {
	lower := strings.ToLower(content)
	for _, open := range []string{"```yaml", "```yml"} {
		start := strings.Index(lower, open)
		if start < 0 {
			continue
		}
		rest := content[start+len(open):]
		newline := strings.Index(rest, "\n")
		if newline < 0 {
			continue
		}
		rest = rest[newline+1:]
		end := strings.Index(rest, "```")
		if end < 0 {
			continue
		}
		return strings.TrimSpace(rest[:end]), true
	}
	return "", false
}

// jsonCompatible turns what yaml.v3 decodes (map[string]any with any keys) into values
// encoding/json can write.
func jsonCompatible(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = jsonCompatible(item)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[fmt.Sprint(key)] = jsonCompatible(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = jsonCompatible(item)
		}
		return out
	default:
		return v
	}
}

// ParseSoul reads soul.md: the Markdown without its front matter, or "" when the front matter
// says status: draft (a draft soul was left out of the prompt).
func ParseSoul(raw string) string {
	if strings.EqualFold(markdownutil.FrontmatterStatus(raw), "draft") {
		return ""
	}
	return strings.TrimSpace(markdownutil.StripFrontmatter(strings.ReplaceAll(raw, "\r\n", "\n")))
}

// RenderSoul is soul.md as written back from the soul: the Markdown itself.
func RenderSoul(soul string) string {
	soul = strings.TrimSpace(soul)
	if soul == "" {
		return ""
	}
	return soul + "\n"
}

// CleanAgentName is the name to call the agent by, without Markdown emphasis or the template's
// "(pick one)" placeholder.
func CleanAgentName(raw string) string {
	value := strings.Trim(strings.TrimSpace(raw), "*_`")
	value = strings.TrimSpace(value)
	switch strings.ToLower(value) {
	case "", "(pick one)", "pick one":
		return ""
	default:
		return value
	}
}

// ForStateDir is the persona store on the process's cached handle on agent.db in stateDir. Its
// Close does nothing; the handle stays open.
func ForStateDir(ctx context.Context, stateDir string) (*Store, error) {
	db, err := agentdb.CachedStateDir(stateDir).Get(ctx)
	if err != nil {
		return nil, err
	}
	return &Store{db: db, cached: true}, nil
}

// ForPersonaDir is ForStateDir for a persona folder (<state>/persona).
func ForPersonaDir(ctx context.Context, personaDir string) (*Store, error) {
	personaDir = strings.TrimSpace(personaDir)
	if personaDir == "" {
		personaDir = statepaths.PersonaDir()
	}
	return ForStateDir(ctx, filepath.Dir(filepath.Clean(personaDir)))
}

// LoadAgentName is the identity's name, cleaned, or "" without one.
func LoadAgentName(ctx context.Context, stateDir string) string {
	if strings.TrimSpace(stateDir) == "" {
		return ""
	}
	store, err := ForStateDir(ctx, stateDir)
	if err != nil {
		return ""
	}
	id, ok, err := store.Identity(ctx)
	if err != nil || !ok {
		return ""
	}
	return CleanAgentName(id.Name)
}
