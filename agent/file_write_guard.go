package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

const (
	// maxFileWriteInterventions is how many times in one run the engine sends a final back
	// because a requested file is missing.
	maxFileWriteInterventions = 3
	// maxFileWriteNoProgress is how many of those it sends while the set of missing files
	// stays the same.
	maxFileWriteNoProgress = 2
)

// ErrFileWriteUnsatisfied is the error of a run that ended without writing a file its task
// asked for. The error is a *FileWriteUnsatisfiedError.
var ErrFileWriteUnsatisfied = errors.New("requested file write not satisfied")

// MissingFileWrite is one file the task asked for that is not there.
type MissingFileWrite struct {
	// Path is the destination as the task wrote it.
	Path string
	// Checked are the locations the engine looked at.
	Checked []string
	// Problem is why the file does not count, when it is not simply absent.
	Problem string
}

func (m MissingFileWrite) String() string {
	detail := "not found"
	if m.Problem != "" {
		detail = m.Problem
	}
	if len(m.Checked) > 0 {
		detail += "; checked " + strings.Join(m.Checked, ", ")
	}
	return fmt.Sprintf("%q (%s)", m.Path, detail)
}

// FileWriteUnsatisfiedError says which requested files a run left unwritten and why the
// engine stopped asking for them.
type FileWriteUnsatisfiedError struct {
	Missing []MissingFileWrite
	// Reason is why the engine gave up.
	Reason string
	// Interventions is how many times the run was asked to write the files.
	Interventions int
}

func (e *FileWriteUnsatisfiedError) Error() string {
	parts := make([]string, 0, len(e.Missing))
	for _, m := range e.Missing {
		parts = append(parts, m.String())
	}
	return fmt.Sprintf("%s: %s: %s. The task names these as files to write; "+
		"write them at exactly these paths, or reword the task if they are not file destinations",
		ErrFileWriteUnsatisfied.Error(), e.Reason, strings.Join(parts, "; "))
}

func (e *FileWriteUnsatisfiedError) Is(target error) bool { return target == ErrFileWriteUnsatisfied }

// fileWriteGuardState is the completion guard's memory of one run. It is kept across an
// approval pause, so that a resumed run does not get its reminders back.
type fileWriteGuardState struct {
	// Interventions counts the reminders sent in this run.
	Interventions int `json:"interventions,omitempty"`
	// Unchanged counts the reminders sent for LastMissing.
	Unchanged int `json:"unchanged,omitempty"`
	// LastMissing is the set of missing paths at the last reminder.
	LastMissing []string `json:"last_missing,omitempty"`
}

func cloneFileWriteGuardState(s fileWriteGuardState) fileWriteGuardState {
	s.LastMissing = slices.Clone(s.LastMissing)
	return s
}

// checkRequestedWrites is the completion guard of a final. It returns "" and nil when the
// final may go out, a reminder to send to the model when the run gets another chance to
// write the missing files, or the error that ends the run.
func (e *Engine) checkRequestedWrites(ctx context.Context, st *engineLoopState, step int) (string, error) {
	if len(st.requestedWrites) == 0 {
		return "", nil
	}
	roots := pathroots.Resolve(ctx, e.engineToolsConfig.PathRoots)
	missing, skipped := missingRequestedWrites(roots, st.requestedWrites)
	if len(skipped) > 0 {
		st.log.Info("file_write_requirement_skipped", "step", step, "paths", strings.Join(skipped, ", "), "reason", "is_directory")
	}
	if len(missing) == 0 {
		return "", nil
	}
	paths := make([]string, 0, len(missing))
	for _, m := range missing {
		paths = append(paths, m.Path)
	}
	joined := strings.Join(paths, ", ")
	guard := &st.fileWrite
	fail := func(event string, reason string) (string, error) {
		st.log.Warn(event, "step", step, "paths", joined, "interventions", guard.Interventions)
		return "", &FileWriteUnsatisfiedError{Missing: missing, Reason: reason, Interventions: guard.Interventions}
	}

	var writers []string
	if _, ok := e.registry.Get("write_file"); ok {
		writers = append(writers, "write_file")
	}
	shellToolNames := availableShellToolNames(e.registry)
	if len(writers) == 0 && len(shellToolNames) == 0 {
		return fail("file_write_unavailable", "no tool that can write files is available to this run")
	}

	if !slices.Equal(guard.LastMissing, paths) {
		guard.LastMissing = paths
		guard.Unchanged = 0
	}
	if guard.Unchanged >= maxFileWriteNoProgress {
		return fail("file_write_no_progress", fmt.Sprintf("no progress after %d reminders", guard.Unchanged))
	}
	if guard.Interventions >= maxFileWriteInterventions {
		return fail("file_write_retries_exhausted", fmt.Sprintf("still missing after %d reminders", guard.Interventions))
	}
	guard.Interventions++
	guard.Unchanged++
	st.log.Info("file_write_required", "step", step, "paths", joined,
		"intervention", guard.Interventions, "unchanged", guard.Unchanged)

	var next string
	switch {
	case len(writers) > 0 && len(shellToolNames) > 0:
		next = fmt.Sprintf("Next, call the write_file tool (preferred) or one of the available shell tools (%s) to create/update them.", strings.Join(shellToolNames, ", "))
	case len(writers) > 0:
		next = "Next, call the write_file tool (preferred) to create/update them."
	case len(shellToolNames) == 1:
		next = fmt.Sprintf("Next, call the %s tool to create/update them.", shellToolNames[0])
	default:
		next = fmt.Sprintf("Next, call one of the available shell tools (%s) to create/update them.", strings.Join(shellToolNames, ", "))
	}
	reminder := fmt.Sprintf("You must write the requested file(s) before finishing: %s. %s The file content should be the final markdown/report (do not include meta text like 'Writing to ...').", joined, next)
	if guard.Unchanged > 1 {
		details := make([]string, 0, len(missing))
		for _, m := range missing {
			details = append(details, m.String())
		}
		reminder += fmt.Sprintf(" The same file(s) were still missing after the last reminder: %s. Use exactly the requested path(s); a file written under another name or folder does not count. This is the last reminder before the run fails.", strings.Join(details, "; "))
	}
	return reminder, nil
}

// missingRequestedWrites returns the requested files that are not there. A requirement is
// met only by a file that is not a directory. A requested path that is an existing
// directory was a directory destination, not a file to write, so it is returned in skipped
// and asks for nothing. An empty requirement asks for nothing either.
func missingRequestedWrites(roots pathroots.PathRoots, paths []string) (missing []MissingFileWrite, skipped []string) {
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		candidates := fileWriteCandidates(roots, p)
		found, isDir := false, false
		problem := ""
		for _, candidate := range candidates {
			info, err := os.Stat(candidate)
			switch {
			case err == nil && info.IsDir():
				isDir = true
			case err == nil:
				found = true
			case !errors.Is(err, os.ErrNotExist) && problem == "":
				problem = "cannot be checked: " + err.Error()
			}
		}
		switch {
		case found:
		case isDir:
			skipped = append(skipped, p)
		default:
			missing = append(missing, MissingFileWrite{Path: p, Checked: candidates, Problem: problem})
		}
	}
	return missing, skipped
}

// fileWriteCandidates lists where a requested path may have been written: where write_file
// and the shell tools resolve it (the workspace, else the file cache dir), the other
// allowed base dirs, and the process working directory.
func fileWriteCandidates(roots pathroots.PathRoots, p string) []string {
	p = strings.TrimSpace(pathutil.ExpandHomePath(p))
	var out []string
	add := func(candidate string) {
		abs, err := filepath.Abs(candidate)
		if err != nil {
			abs = filepath.Clean(candidate)
		}
		if !slices.Contains(out, abs) {
			out = append(out, abs)
		}
	}
	slashed := strings.TrimLeft(strings.ReplaceAll(p, `\`, "/"), "/")
	for _, alias := range []string{"workspace_dir", "file_cache_dir", "file_state_dir"} {
		if len(slashed) <= len(alias) || !strings.EqualFold(slashed[:len(alias)+1], alias+"/") {
			continue
		}
		if base := roots.BaseDir(alias); base != "" {
			add(filepath.Join(base, filepath.FromSlash(slashed[len(alias)+1:])))
			return out
		}
	}
	if filepath.IsAbs(p) {
		add(p)
		return out
	}
	if base := roots.DefaultFileDir(); base != "" {
		add(filepath.Join(base, p))
	}
	for _, base := range roots.AllowedBaseDirs() {
		add(filepath.Join(base, p))
	}
	add(p)
	return out
}
