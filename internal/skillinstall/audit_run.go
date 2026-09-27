package skillinstall

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"
)

// The model reads text files in batches, each a separate call with no tools. SKILL.md goes first,
// then scripts, then other text. Files past the last batch are only pattern-checked, and a file
// longer than a batch is cut; either way the assessment is then not complete.
const (
	reviewBatchBytes      = 128 * 1024
	maxReviewBatches      = 8
	maxReviewConcurrency  = 3
	maxFindingsPerBatch   = 30
	maxReviewEvidenceSize = 300
)

type auditResult struct {
	findings     []Finding
	audits       []FileAudit
	review       *Review
	reviewErrors []string
	reviewRan    bool
}

// runAudit checks every file with fixed checks, inspects images and fonts, has the model review
// the text files, and never runs anything from the skill.
func runAudit(ctx context.Context, review ReviewFunc, source Source, files []File) auditResult {
	var res auditResult
	auditIndex := map[string]int{}
	var textFiles []File
	for _, f := range files {
		kind := fileKind(f)
		fa := FileAudit{Path: f.Path, Kind: kind}
		if kind == "image" || kind == "font" {
			status, note, findings := inspectAsset(f)
			fa.Status, fa.Note = status, note
			res.findings = append(res.findings, findings...)
		} else {
			fa.Status = AuditPatternChecked
			res.findings = append(res.findings, checkText(f, kind)...)
			textFiles = append(textFiles, f)
		}
		auditIndex[f.Path] = len(res.audits)
		res.audits = append(res.audits, fa)
	}

	if review != nil && len(textFiles) > 0 {
		res.reviewRan = true
		batches := planReviewBatches(textFiles)
		allPaths := make([]string, 0, len(files))
		for _, f := range files {
			allPaths = append(allPaths, f.Path)
		}
		contents := map[string]string{}
		for _, f := range textFiles {
			contents[f.Path] = string(f.data)
		}

		type batchResult struct {
			review Review
			err    error
		}
		results := make([]batchResult, len(batches))
		var wg sync.WaitGroup
		sem := make(chan struct{}, maxReviewConcurrency)
		for i, batch := range batches {
			wg.Add(1)
			go func(i int, batch []ReviewFile) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				r, err := review(ctx, ReviewInput{Source: source, Files: batch, AllFiles: allPaths, Part: i + 1, Parts: len(batches)})
				results[i] = batchResult{review: r, err: err}
			}(i, batch)
		}
		wg.Wait()

		for i, batch := range batches {
			r := results[i]
			if r.err != nil {
				names := make([]string, 0, len(batch))
				for _, rf := range batch {
					res.audits[auditIndex[rf.Path]].Status = AuditReviewFailed
					res.audits[auditIndex[rf.Path]].Note = r.err.Error()
					names = append(names, rf.Path)
				}
				res.reviewErrors = append(res.reviewErrors, fmt.Sprintf("the review of %s failed: %s", listSome(names, 3), truncate(r.err.Error(), 300)))
				continue
			}
			inBatch := map[string]bool{}
			for _, rf := range batch {
				inBatch[rf.Path] = true
				fa := &res.audits[auditIndex[rf.Path]]
				fa.Status = AuditReviewed
				if rf.Truncated {
					fa.Status = AuditPartlyReviewed
					fa.Note = fmt.Sprintf("the model read the first %d bytes", len(rf.Content))
				}
				if rf.Path == "SKILL.md" {
					res.review = &Review{Summary: truncate(r.review.Summary, 800), Capabilities: capList(r.review.Capabilities, 12, 200)}
				}
			}
			for j, f := range r.review.Findings {
				if j == maxFindingsPerBatch {
					break
				}
				if v, ok := validateReviewFinding(f, inBatch, contents); ok {
					res.findings = append(res.findings, v)
				}
			}
		}
	}
	sortFindings(res.findings)
	return res
}

// planReviewBatches groups text files into batches of about reviewBatchBytes: SKILL.md first,
// then scripts, then other text. Files that do not fit into maxReviewBatches are left out.
func planReviewBatches(files []File) [][]ReviewFile {
	rank := func(f File) int {
		switch fileKind(f) {
		case "instructions":
			return 0
		case "script":
			return 1
		}
		return 2
	}
	ordered := make([]File, 0, len(files))
	for r := 0; r <= 2; r++ {
		for _, f := range files {
			if rank(f) == r {
				ordered = append(ordered, f)
			}
		}
	}
	var batches [][]ReviewFile
	var current []ReviewFile
	size := 0
	for _, f := range ordered {
		rf := ReviewFile{Path: f.Path, Kind: fileKind(f), Content: string(f.data)}
		if len(rf.Content) > reviewBatchBytes {
			rf.Content = cutUTF8(rf.Content, reviewBatchBytes)
			rf.Truncated = true
		}
		if size+len(rf.Content) > reviewBatchBytes && len(current) > 0 {
			batches = append(batches, current)
			current, size = nil, 0
		}
		if len(batches) == maxReviewBatches {
			break
		}
		current = append(current, rf)
		size += len(rf.Content)
	}
	if len(current) > 0 && len(batches) < maxReviewBatches {
		batches = append(batches, current)
	}
	return batches
}

// validateReviewFinding keeps a model finding only in the shape the card relies on: a known
// severity, a file from its batch, and evidence checked against that file.
func validateReviewFinding(f Finding, inBatch map[string]bool, contents map[string]string) (Finding, bool) {
	title := truncate(strings.TrimSpace(f.Title), 160)
	rationale := truncate(strings.TrimSpace(f.Rationale), 600)
	if title == "" {
		title = truncate(rationale, 120)
	}
	if title == "" {
		return Finding{}, false
	}
	severity, ok := normalizeSeverity(f.Severity)
	if !ok {
		rationale = strings.TrimSpace(rationale + " (The review gave no valid severity; shown as medium.)")
	}
	out := Finding{
		Severity:  severity,
		Category:  truncate(firstNonEmpty(strings.ToLower(strings.TrimSpace(f.Category)), "other"), 40),
		Title:     title,
		Rationale: rationale,
		Evidence:  truncate(strings.TrimSpace(f.Evidence), maxReviewEvidenceSize),
		Source:    "review",
	}
	if file := strings.TrimSpace(f.File); inBatch[file] {
		out.File = file
	}
	if out.Evidence != "" {
		verified := out.File != "" && strings.Contains(collapseSpace(contents[out.File]), collapseSpace(out.Evidence))
		out.EvidenceVerified = &verified
	}
	return out, true
}

func collapseSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// cutUTF8 cuts s to at most n bytes without splitting a character.
func cutUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// listSome names up to n items and counts the rest.
func listSome(items []string, n int) string {
	if len(items) <= n {
		return strings.Join(items, ", ")
	}
	return fmt.Sprintf("%s and %d more", strings.Join(items[:n], ", "), len(items)-n)
}
