package chatcmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/chattrace"
	"github.com/quailyquaily/mistermorph/internal/clifmt"
)

func (m *chatModel) renderSharedTrace(task string, snapshot chattrace.Snapshot, full bool) string {
	if m.traceSeq == nil {
		m.traceSeq = map[string]uint64{}
		m.traceActivity = map[string]string{}
	}
	previous := m.traceSeq[task]
	var out strings.Builder
	replayPlan, replayDone := "", ""
	missing := uint64(0)
	last := previous
	for _, entry := range snapshot.Entries {
		if entry.Seq > last {
			missing += entry.Seq - last - 1
			last = entry.Seq
		}
	}
	if snapshot.Omitted > 0 && full {
		fmt.Fprintf(&out, "… %d earlier execution records omitted\n\n", snapshot.Omitted)
	} else if missing > 0 {
		fmt.Fprintf(&out, "… %d execution records omitted\n\n", missing)
	}
	for _, entry := range snapshot.Entries {
		fresh := entry.Seq > previous
		if !fresh && !full {
			continue
		}
		if fresh {
			m.traceSeq[task] = entry.Seq
		}
		e := entry.Event
		e.ToolName = remoteLine(e.ToolName)
		if e.Kind == agent.EventKindSubtaskStart || e.Kind == agent.EventKindSubtaskDone || e.RunID != "" && e.RunID != task {
			if fresh {
				ctx := context.Background()
				cancel := func() {}
				if !entry.Deadline.IsZero() {
					ctx, cancel = context.WithDeadline(ctx, entry.Deadline)
				}
				m.agents.handleEventAt(ctx, e, entry.At)
				cancel()
			}
			continue
		}
		if entry.Plan != nil {
			key := task + ":plan"
			plan := formatChatPlan(entry.Plan)
			if plan != "" && ((!full && m.printed[key] != plan) || (full && replayPlan != plan)) {
				out.WriteString(plan + "\n\n")
				m.printed[key] = plan
				replayPlan = plan
			}
			completed := 0
			for i, step := range entry.Plan.Steps {
				if step.Status == agent.PlanStatusCompleted {
					completed++
				} else if fresh {
					m.traceActivity[task] = formatChatPlanActivity(i, len(entry.Plan.Steps), step.Step)
					break
				}
			}
			if len(entry.Plan.Steps) > 0 && completed == len(entry.Plan.Steps) {
				if full && replayDone != plan || !full && m.printed[key+":done"] != plan {
					fmt.Fprintf(&out, "%s Plan complete · %d steps\n\n", chatSuccessStyle.Render("✓"), completed)
				}
				m.printed[key+":done"] = plan
				replayDone = plan
				if fresh {
					m.traceActivity[task] = "waiting for model"
				}
			}
			continue
		}
		switch e.Kind {
		case agent.EventKindLLMStart:
			if fresh {
				m.traceActivity[task] = "waiting for model"
			}
		case agent.EventKindContextCompactionStart:
			if fresh {
				m.traceActivity[task] = "compacting context"
			}
		case agent.EventKindToolStart:
			if fresh {
				m.traceActivity[task] = formatChatToolActivity(agent.ToolCall{Name: e.ToolName, Params: e.Args})
			}
		case agent.EventKindToolDone:
			if fresh {
				m.traceActivity[task] = "waiting for model"
			}
			if e.ToolName == "plan_create" && e.Error == "" {
				continue
			}
			call := agent.ToolCall{Name: e.ToolName, Params: e.Args}
			marker := chatSuccessStyle.Render("✓")
			if e.Error != "" {
				marker = chatErrorStyle.Render("×")
			}
			fmt.Fprintf(&out, "%s %s\n", marker, chatSecondaryStyle.Render(formatChatToolTranscript(call, m.contentWidth())))
			for _, line := range formatChatToolOutput(call, remoteDisplay(e.Text), m.contentWidth()) {
				fmt.Fprintln(&out, chatMutedStyle.Render(line))
			}
			if e.Error != "" {
				fmt.Fprintln(&out, chatErrorStyle.Render(remoteDisplay(e.Error)))
			}
			out.WriteString("\n")
			if entry.File != nil {
				out.WriteString(clifmt.RenderDiff(remoteDisplay(entry.File.Path), remoteDisplay(entry.File.Before), remoteDisplay(entry.File.After)) + "\n")
			}
		case agent.EventKindLLMRetry:
			if fresh {
				m.traceActivity[task] = remoteLine(e.Text)
			}
			fmt.Fprintln(&out, chatSecondaryStyle.Render("↻ "+remoteDisplay(e.Text))+"\n")
		case agent.EventKindContextCompactionDone:
			if e.Reason != agent.ContextCompactionReasonManual {
				out.WriteString(taskruntime.ContextCompactionDoneText + "\n\n")
			}
			if fresh {
				m.traceActivity[task] = "waiting for model"
			}
		case agent.EventKindContextCompactionFailed:
			fmt.Fprintln(&out, remoteDisplay(strings.TrimSpace(e.Summary+" "+e.Error))+"\n")
		}
	}
	return out.String()
}
