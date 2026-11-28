package consolecmd

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/ownertools"
	"github.com/quailyquaily/mistermorph/internal/solo"
	"github.com/quailyquaily/mistermorph/internal/workspace"
	"github.com/spf13/viper"
)

// Solo starting a work thread in a workspace is what authorizes that workspace for the thread: the
// thread's writes and commands there ask for no workspace approval, whatever Solo's own workspace
// is. A later switch to another workspace (workspace_use) asks for none either, in a thread as in
// any owner chat. What asks anywhere (the Guard, forced-approval tools) asks as in any topic.

// legacyWorkspaceSwitchReason is the reason the removed workspace approval was asked with (before
// FT196); no approval asked now names it.
const legacyWorkspaceSwitchReason = "workspace_switch_requires_approval"

// dispatch sends Solo a message that starts a thread in dir and returns the thread's card.
func (h soloHarness) dispatch(t *testing.T, dir string) daemonruntime.SoloThread {
	t.Helper()
	sent := h.chat(daemonruntime.ConsoleSoloTopicID, "solo-dispatch "+dir+" please do the work")
	h.client.wait(sent.ID, daemonruntime.TaskDone)
	for _, task := range h.soloTasks() {
		if rec, ok := solo.ThreadOf(task); ok && rec.Kind == daemonruntime.SoloRecordCard && rec.OriginTaskID == sent.ID {
			return rec
		}
	}
	t.Fatalf("no thread card for the dispatch %s", sent.ID)
	return daemonruntime.SoloThread{}
}

func (h soloHarness) pendingApprovals(t *testing.T) []daemonruntime.ApprovalInfo {
	t.Helper()
	var page daemonruntime.ApprovalListResponse
	h.client.ok("GET", "/approvals", nil, &page)
	return page.Items
}

// neverPending waits for a thread's task to end done and fails if it ever waited for an approval.
func (h soloHarness) neverPending(t *testing.T, taskID string) daemonruntime.TaskInfo {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var task daemonruntime.TaskInfo
		h.client.ok("GET", "/tasks/"+taskID, nil, &task)
		if task.Status == daemonruntime.TaskPending || task.ApprovalRequestID != "" || task.PendingAt != nil {
			var approval daemonruntime.ApprovalInfo
			h.client.request("GET", "/approvals/"+task.ApprovalRequestID, nil, &approval)
			t.Fatalf("task %s waits for an approval: %+v (%+v)", taskID, task, approval)
		}
		switch task.Status {
		case daemonruntime.TaskDone:
			if pending := h.pendingApprovals(t); len(pending) != 0 {
				t.Fatalf("pending approvals = %+v", pending)
			}
			return task
		case daemonruntime.TaskFailed, daemonruntime.TaskCanceled:
			t.Fatalf("task %s: status=%s error=%q", taskID, task.Status, task.Error)
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("task %s did not end", taskID)
	return daemonruntime.TaskInfo{}
}

// threadWorkDone checks what "thread-work" leaves in dir: a written file and a command's output
// that names dir as its working directory.
func threadWorkDone(t *testing.T, dir string) {
	t.Helper()
	if out, err := os.ReadFile(filepath.Join(dir, "out.txt")); err != nil || string(out) != "made by the thread" {
		t.Fatalf("out.txt in %s = %q, %v", dir, out, err)
	}
	pwd, err := os.ReadFile(filepath.Join(dir, "pwd.txt"))
	if err != nil {
		t.Fatalf("pwd.txt in %s: %v", dir, err)
	}
	want, _ := filepath.EvalSymlinks(dir)
	if got, _ := filepath.EvalSymlinks(strings.TrimSpace(string(pwd))); got != want {
		t.Fatalf("command ran in %q, want %s", pwd, dir)
	}
}

func TestSoloThreadWorksInItsWorkspaceWithoutApproval(t *testing.T) {
	cases := map[string]func(t *testing.T, h soloHarness) string{
		"another workspace":    func(t *testing.T, h soloHarness) string { return t.TempDir() },
		"Solo's own workspace": func(t *testing.T, h soloHarness) string { return h.soloWS },
		"a folder inside Solo's workspace": func(t *testing.T, h soloHarness) string {
			dir := filepath.Join(h.soloWS, "services", "api")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			return dir
		},
		"a folder inside another workspace": func(t *testing.T, h soloHarness) string {
			dir := filepath.Join(t.TempDir(), "pkg")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			return dir
		},
	}
	for name, pick := range cases {
		t.Run(name, func(t *testing.T) {
			h := newSoloHarness(t)
			h.provider.setThreadTask("thread-work write the report")
			dir := pick(t, h)

			// A new thread: its first write and its first command run at once.
			first := h.dispatch(t, dir)
			if first.WorkspaceDir != dir {
				t.Fatalf("thread workspace = %q, want %s", first.WorkspaceDir, dir)
			}
			h.neverPending(t, first.TaskID)
			threadWorkDone(t, dir)
			if card := h.waitRecord(t, daemonruntime.SoloThreadCardID(first.TaskID), daemonruntime.SoloThreadDone); !strings.Contains(card.Summary, "Thread work done") {
				t.Fatalf("card = %+v", card)
			}

			// More work for the same thread, and a second thread in the same workspace: the same.
			for _, file := range []string{"out.txt", "pwd.txt"} {
				if err := os.Remove(filepath.Join(dir, file)); err != nil {
					t.Fatal(err)
				}
			}
			again, err := h.rt.startSoloThread(context.Background(), ownertools.ThreadRequest{TopicID: first.TopicID, Task: "thread-work write it again", WorkspaceDir: dir})
			if err != nil || !again.Continued || again.TopicID != first.TopicID {
				t.Fatalf("continue the thread = %+v, %v", again, err)
			}
			h.neverPending(t, again.TaskID)
			threadWorkDone(t, dir)
			if err := os.Remove(filepath.Join(dir, "out.txt")); err != nil {
				t.Fatal(err)
			}
			second := h.dispatch(t, dir)
			if second.TopicID == first.TopicID || second.WorkspaceDir != dir {
				t.Fatalf("second thread = %+v", second)
			}
			h.neverPending(t, second.TaskID)
			threadWorkDone(t, dir)
			h.rt.soloSyncs.Wait()
		})
	}
}

// switchedWorkDone checks what "thread-switch" leaves: switched.txt and a command's output naming
// the workspace it switched to as its working directory, and neither in the run's own workspace.
func switchedWorkDone(t *testing.T, switched, own string) {
	t.Helper()
	if out, err := os.ReadFile(filepath.Join(switched, "switched.txt")); err != nil || string(out) != "made after the switch" {
		t.Fatalf("switched.txt in %s = %q, %v", switched, out, err)
	}
	pwd, err := os.ReadFile(filepath.Join(switched, "switched-pwd.txt"))
	if err != nil {
		t.Fatalf("switched-pwd.txt in %s: %v", switched, err)
	}
	want, _ := filepath.EvalSymlinks(switched)
	if got, _ := filepath.EvalSymlinks(strings.TrimSpace(string(pwd))); got != want {
		t.Fatalf("command ran in %q, want %s", pwd, switched)
	}
	for _, file := range []string{"switched.txt", "switched-pwd.txt"} {
		if _, err := os.Stat(filepath.Join(own, file)); err == nil {
			t.Fatalf("%s landed in the run's own workspace %s", file, own)
		}
	}
}

// A thread that switches to another workspace on its own (workspace_use) writes and runs a command
// there at once, asking nothing; the thread's topic keeps its workspace, and its next task works
// there.
func TestSoloThreadSwitchToAnotherWorkspaceAsksNothing(t *testing.T) {
	h := newSoloHarness(t)
	project, unrelated := t.TempDir(), t.TempDir()
	h.provider.setThreadTask("thread-switch " + unrelated + " and work there")
	thread := h.dispatch(t, project)
	h.neverPending(t, thread.TaskID)
	switchedWorkDone(t, unrelated, project)
	if card := h.waitRecord(t, daemonruntime.SoloThreadCardID(thread.TaskID), daemonruntime.SoloThreadDone); !strings.Contains(card.Summary, "Switched work done") {
		t.Fatalf("card = %+v", card)
	}
	var ws daemonruntime.WorkspaceResolution
	h.client.ok("GET", "/workspace?topic_id="+thread.TopicID, nil, &ws)
	if ws.WorkspaceDir != project {
		t.Fatalf("thread workspace after the switch = %+v, want %s", ws, project)
	}
	next, err := h.rt.startSoloThread(context.Background(), ownertools.ThreadRequest{TopicID: thread.TopicID, Task: "thread-work write the report", WorkspaceDir: project})
	if err != nil {
		t.Fatal(err)
	}
	h.neverPending(t, next.TaskID)
	threadWorkDone(t, project)
	h.rt.soloSyncs.Wait()
}

// ownerTopic is one of the owner's ordinary Console topics, with dir attached as its workspace.
func (h soloHarness) ownerTopic(t *testing.T, dir string) string {
	t.Helper()
	topic, err := h.rt.store.CreateNamedTopic("Project")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.rt.currentWorkspaceStore().Set(buildConsoleConversationKey(topic.ID), workspace.Attachment{WorkspaceDir: dir}); err != nil {
		t.Fatal(err)
	}
	return topic.ID
}

// The owner's own Console chat switching workspace mid-run writes and runs a command in the new
// one at once, asking nothing, and the topic keeps its attachment.
func TestOwnerChatSwitchToAnotherWorkspaceAsksNothing(t *testing.T) {
	h := newSoloHarness(t)
	project, unrelated := t.TempDir(), t.TempDir()
	topicID := h.ownerTopic(t, project)
	sent := h.chat(topicID, "thread-switch "+unrelated+" and work there")
	h.neverPending(t, sent.ID)
	switchedWorkDone(t, unrelated, project)
	if dir, err := workspace.LookupWorkspaceDir(h.rt.currentWorkspaceStore(), buildConsoleConversationKey(topicID)); err != nil || dir != project {
		t.Fatalf("attachment after the switch = %q, %v", dir, err)
	}
}

// workspace_use still refuses what it refused before: a missing folder and the agent's state folder
// (and, through ownertools' tests, unknown and deny_paths folders). The run stays in its own
// workspace, so the write and the command after the refused switch land there.
func TestOwnerChatRefusedSwitchStaysInTheTopicWorkspace(t *testing.T) {
	for name, target := range map[string]func(h soloHarness) string{
		"missing folder": func(soloHarness) string { return filepath.Join(t.TempDir(), "gone") },
		"state folder":   func(h soloHarness) string { return h.stateDir },
	} {
		t.Run(name, func(t *testing.T) {
			h := newSoloHarness(t)
			project := t.TempDir()
			topicID := h.ownerTopic(t, project)
			dir := target(h)
			sent := h.chat(topicID, "thread-switch "+dir+" and work there")
			h.neverPending(t, sent.ID)
			if _, err := os.Stat(filepath.Join(dir, "switched.txt")); err == nil {
				t.Fatalf("wrote in the refused folder %s", dir)
			}
			if out, err := os.ReadFile(filepath.Join(project, "switched.txt")); err != nil || string(out) != "made after the switch" {
				t.Fatalf("switched.txt in the topic's workspace = %q, %v", out, err)
			}
		})
	}
}

// With the Guard on, a switched thread's command still asks, for the Guard's reason (the switch adds
// none), and the run resumed after the approval runs it in the workspace it had switched to.
func TestSoloThreadGuardApprovalAfterASwitchResumesThere(t *testing.T) {
	h := newSoloHarnessWith(t, func(reader *viper.Viper) {
		reader.Set("guard.enabled", true)
		reader.Set("guard.approvals.enabled", true)
	})
	project, unrelated := t.TempDir(), t.TempDir()
	h.provider.setThreadTask("thread-switch " + unrelated + " and work there")
	thread := h.dispatch(t, project)

	pending := h.client.wait(thread.TaskID, daemonruntime.TaskPending)
	var approval daemonruntime.ApprovalInfo
	h.client.ok("GET", "/approvals/"+pending.ApprovalRequestID, nil, &approval)
	if approval.TaskID != thread.TaskID || approval.ToolName != "bash" {
		t.Fatalf("approval = %+v", approval)
	}
	if reasons := strings.Join(approval.Reasons, " "); strings.Contains(reasons, legacyWorkspaceSwitchReason) || strings.Contains(reasons, unrelated) {
		t.Fatalf("the Guard's approval names the workspace: %q", reasons)
	}
	// The write after the switch needed nothing; the command has not run.
	if out, err := os.ReadFile(filepath.Join(unrelated, "switched.txt")); err != nil || string(out) != "made after the switch" {
		t.Fatalf("switched.txt = %q, %v", out, err)
	}
	if _, err := os.Stat(filepath.Join(unrelated, "switched-pwd.txt")); err == nil {
		t.Fatal("the command ran before the Guard's approval")
	}
	h.client.ok("POST", "/approvals/"+pending.ApprovalRequestID+"/approve", map[string]string{"actor": "owner"}, nil)
	h.client.wait(thread.TaskID, daemonruntime.TaskDone)
	switchedWorkDone(t, unrelated, project)
	h.rt.soloSyncs.Wait()
}

// The Guard's approvals are its own: with the Guard on, a thread's command asks for the Guard's
// reason (not the workspace's), in Solo's own workspace as in another, and the run resumed after
// the approval finishes in the thread's workspace.
func TestSoloThreadGuardApprovalStillAsks(t *testing.T) {
	for _, where := range []string{"another workspace", "Solo's own workspace"} {
		t.Run(where, func(t *testing.T) {
			h := newSoloHarnessWith(t, func(reader *viper.Viper) {
				reader.Set("guard.enabled", true)
				reader.Set("guard.approvals.enabled", true)
			})
			h.provider.setThreadTask("thread-work write the report")
			dir := h.soloWS
			if where == "another workspace" {
				dir = t.TempDir()
			}
			thread := h.dispatch(t, dir)

			pending := h.client.wait(thread.TaskID, daemonruntime.TaskPending)
			var approval daemonruntime.ApprovalInfo
			h.client.ok("GET", "/approvals/"+pending.ApprovalRequestID, nil, &approval)
			if approval.TaskID != thread.TaskID || approval.ToolName != "bash" {
				t.Fatalf("approval = %+v", approval)
			}
			if reasons := strings.Join(approval.Reasons, " "); strings.Contains(reasons, legacyWorkspaceSwitchReason) {
				t.Fatalf("the Guard's approval names the workspace: %q", reasons)
			}
			// The write before the command needed nothing; the command has not run.
			if out, err := os.ReadFile(filepath.Join(dir, "out.txt")); err != nil || string(out) != "made by the thread" {
				t.Fatalf("out.txt = %q, %v", out, err)
			}
			if _, err := os.Stat(filepath.Join(dir, "pwd.txt")); err == nil {
				t.Fatal("the command ran before the Guard's approval")
			}
			h.client.ok("POST", "/approvals/"+pending.ApprovalRequestID+"/approve", map[string]string{"actor": "owner"}, nil)
			h.client.wait(thread.TaskID, daemonruntime.TaskDone)
			threadWorkDone(t, dir)
			h.rt.soloSyncs.Wait()
		})
	}
}
