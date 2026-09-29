package skillinstall

import (
	"fmt"
	"path"
	"sort"
	"strings"
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

// Finding is one issue found in a skill, by inspecting an image or font or by the model review.
type Finding struct {
	Severity  string `json:"severity"`
	Category  string `json:"category"`
	Title     string `json:"title"`
	File      string `json:"file,omitempty"`
	Line      int    `json:"line,omitempty"`
	Evidence  string `json:"evidence,omitempty"`
	Rationale string `json:"rationale,omitempty"`
	// Source is "check" (image and font inspection) or "review" (the model).
	Source string `json:"source"`
	// EvidenceVerified is set for review findings whose evidence appears in the named file.
	EvidenceVerified *bool `json:"evidence_verified,omitempty"`
}

// File audit statuses.
const (
	AuditReviewed       = "reviewed"        // the model read it in full
	AuditPartlyReviewed = "partly_reviewed" // the model read a truncated copy
	AuditNotReviewed    = "not_reviewed"    // the model did not read it
	AuditReviewFailed   = "review_failed"   // its review call failed
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
		case AuditNotReviewed:
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
		a.IncompleteReasons = append(a.IncompleteReasons, textFiles(notRead, "was not read by the model review", "were not read by the model review"))
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
