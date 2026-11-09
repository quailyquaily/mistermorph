package contacts

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

func init() {
	agentdb.Register(agentdb.Importer{Name: "contacts", Order: 30, Run: importContactFiles})
}

// Files the contacts folder held before agent.db.
const (
	ActiveContactsFile   = "ACTIVE.md"
	InactiveContactsFile = "INACTIVE.md"
	BusInboxFile         = "bus_inbox.json"
	BusOutboxFile        = "bus_outbox.json"
)

// contactsDirName is the contacts folder under the state folder (contacts.dir_name).
func contactsDirName(stateDir string) string {
	dir := pathutil.ResolveStateChildDir(stateDir, viper.GetString("contacts.dir_name"), "contacts")
	return stateimport.Rel(stateDir, dir)
}

// importContactFiles reads ACTIVE.md, INACTIVE.md, bus_inbox.json and bus_outbox.json from the
// contacts folder into their tables. Each contact's YAML block is parsed on its own, so one that
// does not parse is listed as a reject and the others import. A contact in both files stays
// active. The legacy persona_brief and topic_preferences fields are not carried over: they are
// kept in meta until MoveContactProfiles turns them into memories.
func importContactFiles(ctx context.Context, tx *sql.Tx, env agentdb.ImportEnv) (agentdb.ImportResult, error) {
	var result agentdb.ImportResult
	dirRel := contactsDirName(env.StateDir)
	dir := filepath.Join(env.StateDir, filepath.FromSlash(dirRel))
	rel := func(name string) string { return filepath.ToSlash(filepath.Join(dirRel, name)) }
	seen := map[string]bool{}
	var legacy []LegacyProfile
	for _, source := range []struct {
		name   string
		status Status
	}{{ActiveContactsFile, StatusActive}, {InactiveContactsFile, StatusInactive}} {
		raw, err := os.ReadFile(filepath.Join(dir, source.name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return result, err
		}
		result.Rename = append(result.Rename, rel(source.name))
		for _, block := range splitContactBlocks(string(raw)) {
			contact, err := parseContactBlock(block)
			if err == nil && seen[contact.ContactID] {
				err = fmt.Errorf("contact %s is in both files; the active one is kept", contact.ContactID)
			}
			if err != nil {
				result.Rejects = append(result.Rejects, stateimport.Reject{Source: rel(source.name), Line: block.line, Error: err.Error(), Raw: block.yaml})
				continue
			}
			seen[contact.ContactID] = true
			if !contact.legacy.empty() {
				legacy = append(legacy, LegacyProfile{ContactID: contact.ContactID, PersonaBrief: contact.legacy.personaBrief,
					TopicPreferences: append([]string(nil), contact.legacy.topicPreferences...)})
			}
			owner, paired := contact.Owner, contact.Paired
			canonical, err := canonicalContact(contact)
			if err != nil {
				result.Rejects = append(result.Rejects, stateimport.Reject{Source: rel(source.name), Line: block.line, Error: err.Error(), Raw: block.yaml})
				continue
			}
			canonical.Owner, canonical.Paired = owner, paired
			if err := writeContactRow(ctx, tx, contactRow{contact: canonical, status: source.status}); err != nil {
				return result, err
			}
		}
	}
	if err := enforceActiveLimit(ctx, tx); err != nil {
		return result, err
	}
	if len(legacy) > 0 {
		data, err := json.Marshal(legacy)
		if err != nil {
			return result, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value`, legacyProfilesKey, string(data)); err != nil {
			return result, err
		}
	}

	if raw, err := os.ReadFile(filepath.Join(dir, BusInboxFile)); err == nil {
		result.Rename = append(result.Rename, rel(BusInboxFile))
		var file busInboxFile
		if err := decodeStrict(raw, &file); err != nil {
			result.Rejects = append(result.Rejects, stateimport.Reject{Source: rel(BusInboxFile), Error: err.Error(), Raw: string(raw)})
			file = busInboxFile{}
		}
		for i, record := range file.Records {
			normalized, err := normalizeBusInboxRecord(record)
			if err == nil {
				err = putBusInboxRecord(ctx, tx, normalized)
			}
			if err != nil {
				encoded, _ := json.Marshal(record)
				result.Rejects = append(result.Rejects, stateimport.Reject{Source: rel(BusInboxFile), Line: i + 1, Error: err.Error(), Raw: string(encoded)})
			}
		}
	} else if !os.IsNotExist(err) {
		return result, err
	}
	if raw, err := os.ReadFile(filepath.Join(dir, BusOutboxFile)); err == nil {
		result.Rename = append(result.Rename, rel(BusOutboxFile))
		var file busOutboxFile
		if err := decodeStrict(raw, &file); err != nil {
			result.Rejects = append(result.Rejects, stateimport.Reject{Source: rel(BusOutboxFile), Error: err.Error(), Raw: string(raw)})
			file = busOutboxFile{}
		}
		for i, record := range file.Records {
			normalized, err := normalizeBusOutboxRecordForLoad(record)
			if err == nil {
				err = putBusOutboxRecord(ctx, tx, normalized)
			}
			if err != nil {
				encoded, _ := json.Marshal(record)
				result.Rejects = append(result.Rejects, stateimport.Reject{Source: rel(BusOutboxFile), Line: i + 1, Error: err.Error(), Raw: string(encoded)})
			}
		}
	} else if !os.IsNotExist(err) {
		return result, err
	}
	return result, nil
}

// contactBlock is one contact's YAML block in a contacts file, with its section heading.
type contactBlock struct {
	heading string
	yaml    string
	line    int
}

// splitContactBlocks finds the ```yaml blocks of a contacts file, outside HTML comments, as
// parseContactsProfileMarkdown reads them.
func splitContactBlocks(content string) []contactBlock {
	clean := stripMarkdownHTMLComments(content)
	scanner := bufio.NewScanner(strings.NewReader(clean))
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)
	var out []contactBlock
	heading := ""
	inYAML := false
	start := 0
	var lines []string
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		rawLine := scanner.Text()
		line := strings.TrimSpace(rawLine)
		if !inYAML && strings.HasPrefix(line, "## ") {
			heading = strings.TrimSpace(strings.TrimPrefix(line, "## "))
			continue
		}
		if !inYAML && strings.HasPrefix(line, "```") {
			lower := strings.ToLower(line)
			if strings.HasPrefix(lower, "```yaml") || strings.HasPrefix(lower, "```yml") {
				inYAML = true
				start = lineNo + 1
				lines = lines[:0]
			}
			continue
		}
		if inYAML && strings.HasPrefix(line, "```") {
			out = append(out, contactBlock{heading: heading, yaml: strings.Join(lines, "\n"), line: start})
			inYAML = false
			continue
		}
		if inYAML {
			lines = append(lines, rawLine)
		}
	}
	if inYAML && len(lines) > 0 {
		out = append(out, contactBlock{heading: heading, yaml: strings.Join(lines, "\n"), line: start})
	}
	return out
}

func parseContactBlock(block contactBlock) (Contact, error) {
	var profile contactProfileSection
	if err := yaml.Unmarshal([]byte(block.yaml), &profile); err != nil {
		return Contact{}, err
	}
	contact, err := contactFromProfileSection(block.heading, profile)
	if err != nil {
		return Contact{}, err
	}
	if strings.TrimSpace(contact.ContactID) == "" {
		return Contact{}, fmt.Errorf("contact_id is required")
	}
	return contact, nil
}

// RenderContactsFiles writes the contacts as ACTIVE.md and INACTIVE.md, the files they were, for
// `morph state export`.
func RenderContactsFiles(items []ListedContact) (active string, inactive string, err error) {
	var a, i []Contact
	for _, item := range items {
		if item.Status == StatusInactive {
			i = append(i, item.Contact)
		} else {
			a = append(a, item.Contact)
		}
	}
	if active, err = renderContactsMarkdown("Active Contacts", StatusActive, a); err != nil {
		return "", "", err
	}
	inactive, err = renderContactsMarkdown("Inactive Contacts", StatusInactive, i)
	return active, inactive, err
}

// ParseContactsFile reads a contacts file into its contacts; a block that does not parse is an
// error naming its line.
func ParseContactsFile(content string) ([]Contact, error) {
	var out []Contact
	for _, block := range splitContactBlocks(content) {
		contact, err := parseContactBlock(block)
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", block.line, err)
		}
		out = append(out, contact)
	}
	return out, nil
}

// ReplaceStatuses replaces the contacts of the given statuses with items, in one transaction, for
// `morph state import`: importing only ACTIVE.md replaces the active contacts and keeps the
// inactive ones. Every item's status must be one of statuses; a contact in items that had another
// status takes the item's. Owner and paired come from items; the active limit applies.
func (s *DBStore) ReplaceStatuses(ctx context.Context, statuses []Status, items []ListedContact) error {
	replaced := map[Status]bool{}
	for _, status := range statuses {
		switch status {
		case StatusActive, StatusInactive:
			replaced[status] = true
		default:
			return fmt.Errorf("unknown contact status %q", status)
		}
	}
	if len(replaced) == 0 {
		return nil
	}
	for _, item := range items {
		if !replaced[normalizeStatus(item.Status)] {
			return fmt.Errorf("contact %s is %s, which is not being replaced", item.ContactID, normalizeStatus(item.Status))
		}
	}
	return s.inTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
		for status := range replaced {
			if _, err := tx.ExecContext(ctx, `DELETE FROM contacts WHERE status = ?`, string(status)); err != nil {
				return err
			}
		}
		for _, item := range items {
			owner, paired := item.Owner, item.Paired
			contact, err := canonicalContact(item.Contact)
			if err != nil {
				return fmt.Errorf("contact %s: %w", item.ContactID, err)
			}
			contact.Owner, contact.Paired = owner, paired
			if err := writeContactRow(ctx, tx, contactRow{contact: contact, status: normalizeStatus(item.Status)}); err != nil {
				return err
			}
		}
		return enforceActiveLimit(ctx, tx)
	})
}

// decodeStrict decodes JSON refusing unknown fields, as the bus files were read.
func decodeStrict(raw []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(out)
}
