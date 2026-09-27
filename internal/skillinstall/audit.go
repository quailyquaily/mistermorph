package skillinstall

import (
	"fmt"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// Severities, least to most severe.
const (
	SeverityInfo     = "info"
	SeverityLow      = "low"
	SeverityMedium   = "medium"
	SeverityHigh     = "high"
	SeverityCritical = "critical"
)

var severityRank = map[string]int{SeverityInfo: 0, SeverityLow: 1, SeverityMedium: 2, SeverityHigh: 3, SeverityCritical: 4}

// severityPoints and the bands below are the scoring rubric (ScoringRubric).
var severityPoints = map[string]int{SeverityInfo: 0, SeverityLow: 3, SeverityMedium: 10, SeverityHigh: 25, SeverityCritical: 50}

// ScoringRubric explains Assessment.Score and Assessment.Level; the preview carries it so the
// approval card can show it.
const ScoringRubric = "Each distinct issue adds points by severity (the same issue in several files counts once): critical 50, high 25, medium 10, low 3, info 0; the score is capped at 100. " +
	"The level is the higher of the most severe finding and the score's band: 0 none, 1-9 low, 10-29 medium, 30-59 high, 60 or more critical. " +
	"The assessment is complete only when the model review read SKILL.md and every other text file in full and every image and font was inspected; " +
	"otherwise it is not fully assessed, whatever the score."

// Finding is one issue found in a skill, by a fixed check or by the model review.
type Finding struct {
	Severity  string `json:"severity"`
	Category  string `json:"category"`
	Title     string `json:"title"`
	File      string `json:"file,omitempty"`
	Line      int    `json:"line,omitempty"`
	Evidence  string `json:"evidence,omitempty"`
	Rationale string `json:"rationale,omitempty"`
	// Source is "check" (a fixed pattern or file inspection) or "review" (the model).
	Source string `json:"source"`
	// EvidenceVerified is set for review findings whose evidence appears in the named file.
	EvidenceVerified *bool `json:"evidence_verified,omitempty"`
}

// File audit statuses.
const (
	AuditReviewed       = "reviewed"        // the model read it in full; pattern checks ran
	AuditPartlyReviewed = "partly_reviewed" // the model read a truncated copy; pattern checks ran on all of it
	AuditPatternChecked = "pattern_checked" // pattern checks only; the model did not read it
	AuditReviewFailed   = "review_failed"   // its review call failed; pattern checks ran
	AuditInspected      = "inspected"       // an image or font whose structure was parsed
	AuditNotInspected   = "not_inspected"   // nothing looked inside it
)

// FileAudit says how far one file was examined.
type FileAudit struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"` // instructions, script, text, image or font
	Status string `json:"status"`
	Note   string `json:"note,omitempty"`
}

// Assessment is the overall result. Level and Score describe what was examined; Complete says
// whether that was everything.
type Assessment struct {
	Complete          bool           `json:"complete"`
	IncompleteReasons []string       `json:"incomplete_reasons,omitempty"`
	Level             string         `json:"level"` // none, low, medium, high or critical
	Score             int            `json:"score"`
	Counts            map[string]int `json:"counts"`
	Files             int            `json:"files"`
	FullyExamined     int            `json:"fully_examined"`
	Rubric            string         `json:"rubric"`
}

func worseSeverity(a, b string) string {
	if severityRank[b] > severityRank[a] {
		return b
	}
	return a
}

func normalizeSeverity(raw string) (string, bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if _, ok := severityRank[s]; ok {
		return s, true
	}
	return SeverityMedium, false
}

// assess scores findings and decides whether the audit covered everything.
func assess(findings []Finding, audits []FileAudit, reviewRan bool, reviewErrors []string) Assessment {
	a := Assessment{Counts: map[string]int{}, Files: len(audits), Rubric: ScoringRubric, Level: "none"}
	worst := ""
	scored := map[string]bool{}
	for _, f := range findings {
		a.Counts[f.Severity]++
		if key := f.Severity + "\x00" + strings.ToLower(f.Title); !scored[key] {
			scored[key] = true
			a.Score += severityPoints[f.Severity]
		}
		if f.Severity != SeverityInfo {
			worst = worseSeverity(worst, f.Severity)
		}
	}
	if a.Score > 100 {
		a.Score = 100
	}
	band := ""
	switch {
	case a.Score >= 60:
		band = SeverityCritical
	case a.Score >= 30:
		band = SeverityHigh
	case a.Score >= 10:
		band = SeverityMedium
	case a.Score >= 1:
		band = SeverityLow
	}
	if level := worseSeverity(worst, band); level != "" {
		a.Level = level
	}

	var notRead, partly, failed, notInspected int
	for _, fa := range audits {
		switch fa.Status {
		case AuditReviewed, AuditInspected:
			a.FullyExamined++
		case AuditPartlyReviewed:
			partly++
		case AuditPatternChecked:
			notRead++
		case AuditReviewFailed:
			failed++
		case AuditNotInspected:
			notInspected++
		}
	}
	if !reviewRan {
		a.IncompleteReasons = append(a.IncompleteReasons, "the model review did not run")
	}
	a.IncompleteReasons = append(a.IncompleteReasons, reviewErrors...)
	if failed > 0 {
		a.IncompleteReasons = append(a.IncompleteReasons, textFiles(failed, "was not reviewed because its review failed", "were not reviewed because their review failed"))
	}
	if notRead > 0 {
		a.IncompleteReasons = append(a.IncompleteReasons, textFiles(notRead, "was only pattern-checked; the model did not read it", "were only pattern-checked; the model did not read them"))
	}
	if partly > 0 {
		a.IncompleteReasons = append(a.IncompleteReasons, textFiles(partly, "was too long and the model read only part of it", "were too long and the model read only part of them"))
	}
	if notInspected > 0 {
		a.IncompleteReasons = append(a.IncompleteReasons, plural(notInspected, "1 file could not be inspected", "%d files could not be inspected"))
	}
	a.Complete = len(a.IncompleteReasons) == 0
	return a
}

func textFiles(n int, one, many string) string {
	return plural(n, "1 text file "+one, "%d text files "+many)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return fmt.Sprintf(many, n)
}

// sortFindings orders findings most severe first, then by file and line.
func sortFindings(findings []Finding) {
	sort.SliceStable(findings, func(i, j int) bool {
		a, b := findings[i], findings[j]
		if severityRank[a.Severity] != severityRank[b.Severity] {
			return severityRank[a.Severity] > severityRank[b.Severity]
		}
		if a.File != b.File {
			return a.File < b.File
		}
		return a.Line < b.Line
	})
}

var scriptExtensions = map[string]bool{".sh": true, ".bash": true, ".zsh": true, ".py": true, ".js": true, ".mjs": true, ".cjs": true, ".ts": true, ".rb": true, ".pl": true, ".ps1": true, ".bat": true, ".cmd": true, ".php": true, ".lua": true}

// fileKind classifies a skill file for the audit.
func fileKind(f File) string {
	switch {
	case f.Path == "SKILL.md":
		return "instructions"
	case f.Kind != "":
		return f.Kind
	case scriptExtensions[strings.ToLower(path.Ext(f.Path))] || strings.HasPrefix(string(f.data), "#!"):
		return "script"
	}
	return "text"
}

// textCheck is a fixed pattern check on text files. scriptsOnly checks run on scripts only.
type textCheck struct {
	re          *regexp.Regexp
	severity    string
	category    string
	title       string
	rationale   string
	scriptsOnly bool
	svgOnly     bool
	// skip drops matches that are not the issue (e.g. XML namespace URIs).
	skip func(match string) bool
}

var textChecks = []textCheck{
	// Any text file: SKILL.md and references steer the agent as much as scripts do.
	{re: regexp.MustCompile(`(?i)(curl|wget)[^\n|]*\|\s*(ba|z)?sh\b`), severity: SeverityHigh, category: "command_execution", title: "Downloads and runs a remote script", rationale: "Piping a download into a shell runs whatever the server sends at that moment, unreviewed."},
	{re: regexp.MustCompile(`(?i)base64\s+(-d|--decode)[^\n]*\|\s*(ba|z)?sh\b`), severity: SeverityCritical, category: "command_execution", title: "Decodes and runs hidden commands", rationale: "Encoded commands piped into a shell hide what runs from review."},
	{re: regexp.MustCompile(`(?i)\brm\s+-[a-z]*r[a-z]*f?\s+[~/$]`), severity: SeverityHigh, category: "destructive", title: "Deletes files outside its own folder", rationale: "Recursive deletes of home, root or variable paths can destroy user data."},
	{re: regexp.MustCompile(`(?i)\bsudo\b`), severity: SeverityMedium, category: "command_execution", title: "Asks for root", rationale: "Root commands can change the whole system."},
	{re: regexp.MustCompile(`(?i)~/\.ssh|id_rsa|id_ed25519|\.aws/credentials|\.netrc|\.git-credentials|keychain|\.gnupg`), severity: SeverityHigh, category: "credential_access", title: "Touches credential files", rationale: "Reading keys or credential stores can leak them."},
	{re: regexp.MustCompile(`(?i)ignore (all |any )?(previous|prior|above) instructions|disregard (your|the) (system|previous) (prompt|instructions)`), severity: SeverityHigh, category: "instructions", title: "Tries to override the agent's instructions", rationale: "Instruction overrides are how a skill hijacks the agent beyond its stated purpose."},
	{re: regexp.MustCompile(`(?i)(paste|send|share|upload)[^\n]{0,40}(api[ _-]?key|token|password|secret|credential)`), severity: SeverityHigh, category: "credential_access", title: "Asks for secrets", rationale: "A skill that asks for keys or passwords may be collecting them."},
	{re: regexp.MustCompile(`(?i)\b(crontab|launchctl|systemctl\s+enable|schtasks)\b|LaunchAgents|/etc/systemd|\.config/autostart`), severity: SeverityHigh, category: "persistence", title: "Installs something that runs on its own", rationale: "Scheduled or login-time jobs keep running after the task ends."},
	{re: regexp.MustCompile(`(?i)>>?\s*~?/?\.?(bashrc|zshrc|profile|bash_profile)\b`), severity: SeverityHigh, category: "persistence", title: "Edits shell start-up files", rationale: "Start-up files run on every new shell."},
	{re: regexp.MustCompile(`(?i)webhook\.site|ngrok\.(io|app)|requestbin|pipedream\.net|interact\.sh|burpcollaborator`), severity: SeverityHigh, category: "network", title: "Mentions a data-collection endpoint", rationale: "These services are commonly used to receive exfiltrated data."},
	{re: regexp.MustCompile(`(?i)\bhttp://[a-z0-9.-]+`), severity: SeverityLow, category: "network", title: "Uses plain http links", rationale: "Plain http can be read or altered in transit.",
		skip: func(m string) bool {
			host := strings.ToLower(strings.TrimPrefix(strings.ToLower(m), "http://"))
			// Namespace URIs are identifiers, not links; local addresses do not leave the machine.
			return host == "www.w3.org" || host == "localhost" || host == "127.0.0.1" || host == "ns.adobe.com" || host == "purl.org"
		}},
	{re: regexp.MustCompile(`(?i)\bgit\s+(-C\s+\S+\s+)?(pull|fetch|clone)\b`), severity: SeverityMedium, category: "network", title: "Pulls code from a remote repository", rationale: "Code pulled later was not part of this review and can change the skill after you approve it."},

	// Scripts: what the code can do when the agent runs it.
	{re: regexp.MustCompile(`\bchild_process\b|\bexecSync\s*\(|\bspawnSync\s*\(|\bexecFile(Sync)?\s*\(|\bsubprocess\.|\bos\.system\s*\(|\bos\.popen\s*\(|\bRuntime\.getRuntime\(\)\.exec|\bInvoke-Expression\b|\biex\b`), severity: SeverityMedium, category: "command_execution", title: "Runs other programs", rationale: "The script can start any command the agent's user can.", scriptsOnly: true},
	// Not $eval/$$eval/.eval (browser-automation helpers that run code in a page).
	{re: regexp.MustCompile(`(?:^|[^$.\w])eval\s*\(|\bnew\s+Function\s*\(|\bexec\s*\(\s*compile\s*\(`), severity: SeverityMedium, category: "command_execution", title: "Evaluates code built at run time", rationale: "Code built from strings at run time is not visible to review.", scriptsOnly: true},
	{re: regexp.MustCompile(`\bimport\s*\(\s*['"]https?://|\brequire\s*\(\s*['"]https?://`), severity: SeverityHigh, category: "command_execution", title: "Loads code from the internet", rationale: "Remote code runs without being part of this review.", scriptsOnly: true},
	{re: regexp.MustCompile(`\bfetch\s*\(|\bhttps?\.(request|get)\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\brequests\.(get|post|put|delete|request)\s*\(|\burllib\.|\bhttp\.client\b|\bnet\.connect\s*\(|\bsocket\.socket\s*\(|\bInvoke-WebRequest\b|\bcurl\b|\bwget\b`), severity: SeverityMedium, category: "network", title: "Makes network requests", rationale: "The script can send data to, or fetch data from, other machines.", scriptsOnly: true},
	{re: regexp.MustCompile(`\bprocess\.env\b|\bos\.environ\b|\bos\.getenv\s*\(|\$ENV\{|\$env:`), severity: SeverityLow, category: "credential_access", title: "Reads environment variables", rationale: "Environment variables often hold API keys and tokens.", scriptsOnly: true},
	{re: regexp.MustCompile(`\b(rmSync|rmdirSync|unlinkSync)\s*\(|\bfs\.(rm|rmdir|unlink)\s*\(|\bshutil\.rmtree\s*\(|\bos\.(remove|unlink|rmdir)\s*\(|\bRemove-Item\b`), severity: SeverityMedium, category: "destructive", title: "Deletes files", rationale: "Check what paths it deletes.", scriptsOnly: true},
	{re: regexp.MustCompile(`\b(writeFileSync|appendFileSync)\s*\(|\bfs\.(writeFile|appendFile)\s*\(|\bopen\s*\([^)]*['"][wa]b?['"]`), severity: SeverityLow, category: "file_write", title: "Writes files", rationale: "Check where it writes.", scriptsOnly: true},

	// SVG is text but can carry script.
	{re: regexp.MustCompile(`(?i)<script\b|\bon[a-z]+\s*=\s*['"]|javascript:`), severity: SeverityMedium, category: "command_execution", title: "SVG contains script", rationale: "Script in an SVG runs when the image is opened in a browser.", svgOnly: true},
}

var urlPattern = regexp.MustCompile(`https?://[A-Za-z0-9.-]+(:[0-9]+)?`)

// checkText runs the fixed checks on one text file: one finding per check, with the first match
// as evidence and a count of the rest.
func checkText(f File, kind string) []Finding {
	text := string(f.data)
	isSVG := strings.EqualFold(path.Ext(f.Path), ".svg")
	var out []Finding
	for _, c := range textChecks {
		if c.scriptsOnly && kind != "script" {
			continue
		}
		if c.svgOnly && !isSVG {
			continue
		}
		matches := c.re.FindAllStringIndex(text, -1)
		if c.skip != nil {
			kept := matches[:0]
			for _, m := range matches {
				if !c.skip(text[m[0]:m[1]]) {
					kept = append(kept, m)
				}
			}
			matches = kept
		}
		if len(matches) == 0 {
			continue
		}
		line, excerpt := lineAt(text, matches[0][0])
		rationale := c.rationale
		if len(matches) > 1 {
			rationale = fmt.Sprintf("%s (%d places in this file.)", rationale, len(matches))
		}
		out = append(out, Finding{Severity: c.severity, Category: c.category, Title: c.title, File: f.Path, Line: line, Evidence: excerpt, Rationale: rationale, Source: "check"})
	}
	if kind == "script" {
		out = append(out, Finding{Severity: SeverityInfo, Category: "script", Title: "Ships a script the agent may run", File: f.Path, Rationale: "Scripts run with the agent's permissions when a task uses the skill.", Source: "check"})
		if hosts := hostsIn(text); len(hosts) > 0 {
			out = append(out, Finding{Severity: SeverityInfo, Category: "network", Title: "Network destinations named in the script", File: f.Path, Evidence: strings.Join(hosts, ", "), Rationale: "Hosts the script refers to; check that each is expected.", Source: "check"})
		}
	}
	return out
}

func hostsIn(text string) []string {
	seen := map[string]bool{}
	var hosts []string
	for _, m := range urlPattern.FindAllString(text, -1) {
		u, err := url.Parse(m)
		if err != nil || u.Host == "" || seen[u.Host] {
			continue
		}
		seen[u.Host] = true
		hosts = append(hosts, u.Host)
		if len(hosts) == 20 {
			break
		}
	}
	sort.Strings(hosts)
	return hosts
}

// lineAt returns the 1-based line of offset and that line, trimmed and cut to 200 characters.
func lineAt(text string, offset int) (int, string) {
	line := strings.Count(text[:offset], "\n") + 1
	start := strings.LastIndex(text[:offset], "\n") + 1
	end := strings.IndexByte(text[offset:], '\n')
	if end < 0 {
		end = len(text)
	} else {
		end += offset
	}
	excerpt := strings.TrimSpace(text[start:end])
	if len(excerpt) > 200 {
		// Minified code: show the match's surroundings, not the start of a very long line.
		from := offset - 80
		if from < start {
			from = start
		}
		for from > start && !utf8.RuneStart(text[from]) {
			from--
		}
		excerpt = "…" + strings.TrimSpace(cutUTF8(text[from:end], 200)) + "…"
	}
	return line, excerpt
}
