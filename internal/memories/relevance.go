package memories

import (
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Relevance finds the memories a message is about, so a run sees them without searching even when
// they are not among the newest. Every memory an audience may hear is scored in memory: there are
// at most a few hundred, and scoring them here keeps the ranking and the handling of Chinese and
// Japanese text in one place, where the FTS index (trigrams of three runes or more) cannot.
//
// The score is BM25F over a memory's name, description and body, weighted 3, 2 and 1, since the name
// and description are written as summaries. Latin text is split into lowercase words with simple
// suffixes folded; Chinese, Japanese and Korean text into overlapping pairs of characters, the usual
// way to search them without a word list; identifiers such as v0.3.66, @alice or a path stay whole.
const (
	// RelevantLimit is how many memories a message can bring in.
	RelevantLimit = 8
	// relevantShare drops a match that scores below this share of the best match.
	relevantShare = 0.4
	// queryRunes bounds the text a query is built from.
	queryRunes = 2000

	bm25K1 = 1.2
	bm25B  = 0.75
	// recencyBoost and recencyHalfLife favor newer memories among matches of near equal score.
	recencyBoost    = 0.1
	recencyHalfLife = 90 * 24 * time.Hour
	// subjectBoost favors memories about someone the run names, such as the speaker in a group.
	subjectBoost = 1.2
)

var fieldWeights = [3]float64{3, 2, 1}

// RankOptions tune Rank. Subjects are the subjects to favor; Now dates memories for recency.
type RankOptions struct {
	Limit    int
	Subjects []string
	Now      time.Time
}

// Ranked is a memory that matched a query, with its score and the distinct query terms it matched.
type Ranked struct {
	Memory  Memory
	Score   float64
	Matched int
}

// Rank returns the memories of items the query is about, best first. A memory is kept when it
// matches at least two distinct query terms (or every term of a shorter query), an identifier whole,
// the person it is about or its whole name, and scores at least relevantShare of the best match. Nothing is returned rather than
// weak matches.
func Rank(items []Memory, query string, opts RankOptions) []Ranked {
	limit := opts.Limit
	if limit <= 0 {
		limit = RelevantLimit
	}
	queryTerms := uniqueTerms(terms(query))
	if len(queryTerms) == 0 || len(items) == 0 {
		return nil
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	docs := make([]rankDoc, len(items))
	var avgLen [3]float64
	df := map[string]int{}
	for i, m := range items {
		docs[i] = newRankDoc(m)
		for f := range docs[i].fields {
			avgLen[f] += float64(docs[i].length[f])
		}
		for term := range docs[i].all {
			df[term]++
		}
	}
	for f := range avgLen {
		avgLen[f] = math.Max(avgLen[f]/float64(len(items)), 1)
	}
	favored := map[string]bool{}
	for _, s := range opts.Subjects {
		if s = strings.TrimSpace(s); s != "" {
			favored[s] = true
		}
	}
	n := float64(len(items))
	var ranked []Ranked
	for i, doc := range docs {
		score, matched, whole, nameMatched := 0.0, 0, false, 0
		for _, qt := range queryTerms {
			if !doc.all[qt.text] {
				continue
			}
			matched++
			if qt.whole || doc.subject[qt.text] {
				whole = true
			}
			if doc.name[qt.text] {
				nameMatched++
			}
			tf := 0.0
			for f := range doc.fields {
				norm := 1 - bm25B + bm25B*float64(doc.length[f])/avgLen[f]
				tf += fieldWeights[f] * float64(doc.fields[f][qt.text]) / norm
			}
			d := float64(df[qt.text])
			idf := math.Log(1 + (n-d+0.5)/(d+0.5))
			score += idf * tf / (bm25K1 + tf)
		}
		// Naming the memory's whole name is as strong as an identifier: "launch" finds the memory
		// named launch.
		if len(doc.name) > 0 && nameMatched == len(doc.name) {
			whole = true
		}
		if matched == 0 || (matched < min(2, len(queryTerms)) && !whole) {
			continue
		}
		if updated, err := time.Parse(time.RFC3339, items[i].UpdatedAt); err == nil {
			age := now.Sub(updated)
			if age < 0 {
				age = 0
			}
			score *= 1 + recencyBoost*math.Exp2(-float64(age)/float64(recencyHalfLife))
		}
		if favored[items[i].Subject] {
			score *= subjectBoost
		}
		ranked = append(ranked, Ranked{Memory: items[i], Score: score, Matched: matched})
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].Score > ranked[j].Score })
	if len(ranked) == 0 {
		return nil
	}
	floor := ranked[0].Score * relevantShare
	cut := 0
	for cut < len(ranked) && cut < limit && ranked[cut].Score >= floor {
		cut++
	}
	return ranked[:cut]
}

// rankDoc is a memory split into terms: per field the count of each term and the field's length,
// every term it holds, the terms of its name, and the terms that name the person it is about.
type rankDoc struct {
	fields  [3]map[string]int
	length  [3]int
	all     map[string]bool
	name    map[string]bool
	subject map[string]bool
}

func newRankDoc(m Memory) rankDoc {
	doc := rankDoc{all: map[string]bool{}, name: map[string]bool{}, subject: map[string]bool{}}
	// A contact's handle (contact:tg:@alice gives @alice and alice) counts as part of the name, so a
	// message that names the person finds what is known about them.
	if id, ok := strings.CutPrefix(m.Subject, "contact:"); ok {
		if _, handle, found := strings.Cut(id, ":"); found {
			for _, t := range terms(handle) {
				doc.subject[t.text] = true
			}
		}
	}
	for f, text := range [3]string{m.Name, m.Description, m.Body} {
		doc.fields[f] = map[string]int{}
		ts := terms(text)
		if f == 0 {
			for t := range doc.subject {
				ts = append(ts, term{text: t})
			}
		}
		for _, t := range ts {
			doc.fields[f][t.text]++
			doc.length[f]++
			doc.all[t.text] = true
			if f == 0 && !doc.subject[t.text] {
				doc.name[t.text] = true
			}
		}
	}
	return doc
}

// term is one search term; whole marks an identifier kept whole, a strong match on its own.
type term struct {
	text  string
	whole bool
}

func uniqueTerms(in []term) []term {
	seen := map[string]bool{}
	var out []term
	for _, t := range in {
		if !seen[t.text] {
			seen[t.text] = true
			out = append(out, t)
		}
	}
	return out
}

// terms splits text into search terms. Each whitespace-separated token is cut into runs of one
// script: a Latin run gives a lowercase word with its suffix folded; a run of Chinese characters,
// katakana or hangul its overlapping character pairs. Pairs do not cross from one script to another,
// so メールは gives no ルは, and hiragana runs, mostly particles and endings (の, さんに, ている),
// give nothing. A lone kanji between kana, as in 遅れ or 休み, is a term of its own. A token that
// joins words with . _ - / : or @, mixes letters and digits, or is written in CamelCase is also kept
// whole, lowercase.
func terms(text string) []term {
	var out []term
	for _, token := range strings.FieldsFunc(text, unicode.IsSpace) {
		token = strings.Trim(token, "\"'`()[]{}<>,;!?。、，；：！？「」『』（）【】")
		if isIdentifier(token) {
			out = append(out, term{text: strings.ToLower(strings.TrimRight(token, "._-/:")), whole: true})
		}
		var runs []scriptRun
		joined := false
		for _, r := range token {
			if !unicode.IsLetter(r) && !unicode.IsNumber(r) {
				joined = false
				continue
			}
			sc := scriptOf(r)
			if joined && runs[len(runs)-1].script == sc {
				runs[len(runs)-1].runes = append(runs[len(runs)-1].runes, r)
				continue
			}
			runs = append(runs, scriptRun{script: sc, runes: []rune{r}, joinedPrev: joined})
			joined = true
		}
		for i, run := range runs {
			kanaNext := (i > 0 && run.joinedPrev && runs[i-1].script.kana()) ||
				(i+1 < len(runs) && runs[i+1].joinedPrev && runs[i+1].script.kana())
			out = append(out, run.terms(kanaNext)...)
		}
	}
	return out
}

type script int

const (
	scriptLatin script = iota
	scriptHan
	scriptHiragana
	scriptKatakana
	scriptHangul
)

func (s script) kana() bool { return s == scriptHiragana || s == scriptKatakana }

func scriptOf(r rune) script {
	switch {
	case r == 'ー' || unicode.Is(unicode.Katakana, r):
		return scriptKatakana
	case unicode.Is(unicode.Hiragana, r):
		return scriptHiragana
	case r == '々' || unicode.Is(unicode.Han, r):
		return scriptHan
	case unicode.Is(unicode.Hangul, r):
		return scriptHangul
	}
	return scriptLatin
}

// scriptRun is a stretch of one script within a token; joinedPrev is set when it follows the run
// before it with nothing in between.
type scriptRun struct {
	script     script
	runes      []rune
	joinedPrev bool
}

func (run scriptRun) terms(kanaNext bool) []term {
	switch run.script {
	case scriptLatin:
		word := strings.ToLower(string(run.runes))
		if utf8.RuneCountInString(word) < 2 || stopwords[word] {
			return nil
		}
		return []term{{text: fold(word)}}
	case scriptHiragana:
		return nil
	}
	if len(run.runes) == 1 {
		if run.script == scriptHan && kanaNext {
			return []term{{text: string(run.runes)}}
		}
		return nil
	}
	var out []term
	for i := 0; i+1 < len(run.runes); i++ {
		pair := string(run.runes[i : i+2])
		if !cjkStopwords[pair] {
			out = append(out, term{text: pair})
		}
	}
	return out
}

// isIdentifier reports whether a token is worth matching whole: it joins words with . _ - / : or @
// (v0.3.66, @alice, docs/memories.md, release-notes), mixes letters and digits (gpt5, v2), or is in
// CamelCase (TestJournalImport). A
// trailing period or colon does not count, so "done." is a word, not an identifier.
func isIdentifier(token string) bool {
	core := strings.Trim(token, "._-/:")
	if strings.HasPrefix(token, "@") {
		core = "@" + strings.Trim(token[1:], "._-/:")
	}
	if utf8.RuneCountInString(core) < 3 {
		return false
	}
	var letters, digits, joins int
	for _, r := range core {
		switch {
		case isCJK(r):
			return false
		case unicode.IsLetter(r):
			letters++
		case unicode.IsDigit(r):
			digits++
		case strings.ContainsRune("._-/:@", r):
			joins++
		default:
			return false
		}
	}
	return (letters+digits > 0 && joins > 0) || (letters > 0 && digits > 0) || camelCase(core)
}

// camelCase reports whether a word of eight letters or more changes from lower to upper case inside,
// like a Go or Java name (TestJournalImport, getUserByID).
func camelCase(word string) bool {
	if utf8.RuneCountInString(word) < 8 {
		return false
	}
	prev := ' '
	for _, r := range word {
		if unicode.IsUpper(r) && unicode.IsLower(prev) {
			return true
		}
		prev = r
	}
	return false
}

// isCJK reports whether r is written without spaces between words: Chinese, Japanese or Korean,
// with the Japanese long vowel mark ー and the repeat mark 々, which Unicode puts in no script.
func isCJK(r rune) bool {
	return r == 'ー' || r == '々' || unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}

// fold strips common English suffixes so "notes" finds "note", "meetings" finds "meeting" and
// "releasing" finds "release": first a plural, then -ing or -ed, then a final e. Both sides are
// folded the same way, so the stems need not be words.
func fold(word string) string {
	switch n := len(word); {
	case n > 4 && strings.HasSuffix(word, "ies"):
		word = word[:n-3] + "y"
	case n > 3 && strings.HasSuffix(word, "es") && strings.ContainsAny(word[n-3:n-2], "sxz"):
		word = word[:n-2]
	case n > 3 && strings.HasSuffix(word, "s") && !strings.HasSuffix(word, "ss"):
		word = word[:n-1]
	}
	switch n := len(word); {
	case n > 5 && strings.HasSuffix(word, "ing"):
		word = word[:n-3]
	case n > 4 && strings.HasSuffix(word, "ed"):
		word = word[:n-2]
	}
	return strings.TrimSuffix(word, "e")
}

// QueryText is the text to find memories with, from a run's messages, latest first: the text of
// each, read from the "text" and "output" fields when it is a channel's JSON payload, up to
// queryRunes in all.
func QueryText(messages ...string) string {
	var parts []string
	left := queryRunes
	for _, m := range messages {
		text := strings.TrimSpace(messageWords(m))
		if text == "" || left <= 0 {
			continue
		}
		if runes := []rune(text); len(runes) > left {
			text = string(runes[:left])
		}
		left -= utf8.RuneCountInString(text)
		parts = append(parts, text)
	}
	return strings.Join(parts, "\n")
}

// messageWords is what a message says: a JSON payload's "text" and "output" strings (the current
// message, history records, the agent's own replies), or the message itself.
func messageWords(content string) string {
	content = strings.TrimSpace(content)
	if !strings.HasPrefix(content, "{") && !strings.HasPrefix(content, "[") {
		return content
	}
	var v any
	if json.Unmarshal([]byte(content), &v) != nil {
		return content
	}
	var words []string
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if s, ok := x[k].(string); ok && (k == "text" || k == "output") {
					words = append(words, s)
					continue
				}
				walk(x[k])
			}
		case []any:
			for _, item := range x {
				walk(item)
			}
		}
	}
	walk(v)
	return strings.Join(words, "\n")
}

var stopwords = setOf(`a about above after again all also am an and any are as at be been before being below between both but by can could did do does doing done during each few for from further had has have having he her here hers him his how i if in into is it its itself just let me more most my no nor not now of on once only or other our ours over own please same she should so some such than that the their them then there these they this those through to too under until very was we were what when where which while who whom why will with would yes you your yours ok okay thanks thank hi hello hey new use make get got need want like know see way thing lot much many well really still even back next`)

// cjkStopwords are Chinese character pairs too common to say what a message is about. Hiragana needs
// none: its runs give no terms.
var cjkStopwords = setOf(`我们 你们 他们 这个 那个 一个 一下 可以 什么 怎么 没有 就是 还是 但是 因为 所以 如果 然后 现在 已经 帮我 请你 一些 这样 那样 的话 是不 不是 了吗`)

func setOf(words string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Fields(words) {
		out[w] = true
	}
	return out
}
