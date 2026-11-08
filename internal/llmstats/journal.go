// The JSONL usage journal an older version wrote, read once by the import into usage.db.

package llmstats

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var journalKeyRe = regexp.MustCompile(`^since-([0-9]{4}-[0-9]{2}-[0-9]{2})-([0-9]{4})\.jsonl$`)

type journalSegmentFile struct {
	Key   string
	Date  string
	Index int
}

func listSegmentFiles(dir string) ([]journalSegmentFile, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]journalSegmentFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		seg, ok := parseJournalSegmentFile(entry.Name())
		if !ok {
			continue
		}
		out = append(out, seg)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

func parseJournalSegmentFile(name string) (journalSegmentFile, bool) {
	name = strings.TrimSpace(name)
	m := journalKeyRe.FindStringSubmatch(name)
	if len(m) != 3 {
		return journalSegmentFile{}, false
	}
	idx, err := strconv.Atoi(m[2])
	if err != nil || idx <= 0 {
		return journalSegmentFile{}, false
	}
	return journalSegmentFile{Key: name, Date: m[1], Index: idx}, true
}

func formatJournalFileName(date string, idx int) string {
	return fmt.Sprintf("since-%s-%04d.jsonl", date, idx)
}
