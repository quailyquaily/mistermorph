package cron

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Warnings returns, by job ID, short plain-text notes on jobs that are stored as written but
// will not do what they say. They are worked out when the list is read and never stored:
//
//   - a job that joins "all" of several "each" inputs which no single run leads to: it waits for
//     all of them in one chain of jobs, and never starts;
//   - a one-time schedule whose runs failed until no try was left (see OnceRetryDelays).
func (s *Store) Warnings(ctx context.Context, tasks []Task) map[string][]string {
	out := JoinWarnings(tasks)
	for _, task := range tasks {
		if strings.TrimSpace(task.LastRunStatus) != RunStatusFailed {
			continue
		}
		for _, trigger := range TriggersForTask(task) {
			if trigger.Kind != TriggerSchedule || strings.TrimSpace(trigger.At) == "" {
				continue
			}
			loc, err := taskLocation(trigger.TZ)
			if err != nil {
				continue
			}
			at, err := time.ParseInLocation(TimestampLayout, strings.TrimSpace(trigger.At), loc)
			if err != nil {
				continue
			}
			retry, err := s.OnceRetryState(ctx, task.ID, trigger.ID, at.UTC())
			if err != nil || !retry.GaveUp() {
				continue
			}
			id := strings.TrimSpace(task.ID)
			out[id] = append(out[id], fmt.Sprintf("Its one-time schedule (%s) failed %d times and is not tried again. Set a new time or run the job by hand.",
				strings.TrimSpace(trigger.At), retry.Failures))
		}
	}
	return out
}

// JoinWarnings returns, by job ID, the warning of each job that joins "all" of several "each"
// inputs that share no common upstream job. Such a job starts when every input has a done run in
// one chain of jobs, the chain one run started; a run of job R leads to the jobs that use R with
// mode "each", to the jobs R needs fresh, and on from those. When no job leads to all the
// inputs (an input leads to itself), no chain can hold them all and the job never starts.
func JoinWarnings(tasks []Task) map[string][]string {
	out := map[string][]string{}
	// leadsFrom[x] lists the jobs a run of x may bring into its chain directly.
	leadsFrom := map[string][]string{}
	for _, task := range tasks {
		id := strings.TrimSpace(task.ID)
		for _, use := range task.Uses {
			used := strings.TrimSpace(use.JobID)
			switch use.Mode {
			case UseEach:
				leadsFrom[used] = append(leadsFrom[used], id)
			case UseFresh:
				leadsFrom[id] = append(leadsFrom[id], used)
			}
		}
	}
	reach := map[string]map[string]bool{}
	reachable := func(from string) map[string]bool {
		if seen, ok := reach[from]; ok {
			return seen
		}
		seen := map[string]bool{from: true}
		queue := []string{from}
		for len(queue) > 0 {
			next := queue[0]
			queue = queue[1:]
			for _, to := range leadsFrom[next] {
				if !seen[to] {
					seen[to] = true
					queue = append(queue, to)
				}
			}
		}
		reach[from] = seen
		return seen
	}
	for _, task := range tasks {
		inputs := EachInputs(task)
		if len(inputs) < 2 || JoinForTask(task) != JoinAll {
			continue
		}
		common := false
		for _, origin := range tasks {
			from := reachable(strings.TrimSpace(origin.ID))
			all := true
			for _, input := range inputs {
				all = all && from[input]
			}
			if all {
				common = true
				break
			}
		}
		if !common {
			id := strings.TrimSpace(task.ID)
			out[id] = append(out[id], fmt.Sprintf("This job never starts: join is \"all\", but no single run leads to all of its \"each\" inputs (%s). Set join to \"any\", or make the inputs follow one common job.",
				strings.Join(inputs, ", ")))
		}
	}
	return out
}
