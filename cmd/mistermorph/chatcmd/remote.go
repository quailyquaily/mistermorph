package chatcmd

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/pagination"
	"github.com/quailyquaily/mistermorph/internal/runtimecommands"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/spf13/cobra"
)

func runRemoteChat(cmd *cobra.Command, c *remoteClient, id, version string) error {
	ctx, cancel := context.WithCancel(cmd.Context())
	defer cancel()
	if err := c.connect(ctx); err != nil {
		return fmt.Errorf("connect to Console: %w", err)
	}
	m := newSharedChatModel(ctx, c)
	m.version = version
	m.applySharedSettings(m.loadSharedSettings()().(sharedSettings))
	defer m.closeStreams()
	if home, err := os.UserHomeDir(); err == nil {
		m.historyPath = filepath.Join(home, ".mistermorph_chat_history")
		if err := m.loadHistory(); err != nil {
			fmt.Fprintf(cmd.ErrOrStderr(), "Cannot load input history: %v\n", err)
		}
	}
	if id != "" {
		msg := m.load(id, false)().(remoteLoaded)
		if msg.err != nil {
			return msg.err
		}
		m.applyLoaded(msg)

	}
	workspace := m.status.workspace
	if workspace == "" {
		workspace = m.defaultWorkspace
	}
	printChatSessionHeader(cmd.OutOrStdout(), m.provider, m.status.model, workspace, version)
	_, err := tea.NewProgram(m, tea.WithContext(ctx), tea.WithInput(cmd.InOrStdin()), tea.WithOutput(cmd.OutOrStdout())).Run()
	return err
}

type remoteDraft struct {
	text, workspace  string
	pastedTexts      map[string]string
	revision         uint64
	pending, unknown bool
	bound            string
}
type remoteLoaded struct {
	gen     uint64
	id      string
	topic   taskdomain.TopicInfo
	dir     string
	tasks   []taskdomain.TaskInfo
	cursor  string
	refresh bool
	err     error
	deleted bool
}
type remoteListed struct {
	gen  uint64
	dir  string
	page pagination.Page[taskdomain.TopicInfo]
	more bool
	err  error
}
type remoteTick struct {
	gen uint64
	seq uint64
}
type remoteWrite struct {
	op             uint64
	gen            uint64
	kind, id, text string
	revision       uint64
	task           daemonruntime.SubmitTaskResponse
	stop           daemonruntime.StopTaskResponse
	err            error
}
type sharedChat struct {
	settingsLoaded                                bool
	provider, version, fileStateDir, fileCacheDir string
	streams                                       map[string]*remoteStreamSub
	tickSeq                                       uint64
	ctx                                           context.Context
	client                                        *remoteClient
	gen                                           uint64
	cancel                                        context.CancelFunc
	viewCtx                                       context.Context
	id                                            string
	dir                                           string
	deleted                                       bool
	drafts                                        map[string]*remoteDraft
	hasChat                                       bool
	op                                            uint64
	operations                                    map[uint64]bool
	delay                                         time.Duration
	defaultModel                                  string
	defaultWorkspace                              string
	metadataLoading                               bool
	approvalLoading                               bool
	resolvedApprovals                             map[string]bool
}

func newSharedChatModel(ctx context.Context, c *remoteClient) *chatModel {
	m := newChatModel(nil)
	m.textarea.CharLimit = 0
	m.sharedChat = &sharedChat{ctx: ctx, client: c, drafts: map[string]*remoteDraft{"": {}}, operations: map[uint64]bool{}, delay: 3 * time.Second}
	m.commandRegistry = chatcommands.NewRegistry()
	for _, command := range runtimecommands.Suggestions() {
		if !strings.Contains(command.Value, " ") {
			m.commandRegistry.Register(command.Value, command.Description, nil)
		}
	}
	for _, command := range []chatcommands.Command{
		{Name: "/agents", Description: "inspect subagent threads [id]"},
		{Name: "/agent", Description: "inspect subagent threads [id]"},
		{Name: "/subagents", Description: "inspect subagent threads [id]"},
		{Name: "/reset", Description: "reset the conversation context"},
		{Name: "/init", Description: "create AGENTS.md for this project"},
		{Name: "/update", Description: "regenerate this project’s AGENTS.md"},
		{Name: "/approve", Description: "approve the pending action"},
		{Name: "/deny", Description: "deny the pending action"},
		{Name: "/topics", Description: "list shared topics"},
		{Name: "/topic", Description: "new, switch, history, title, or delete a topic"},
		{Name: "/status", Description: "show full session details"},
		{Name: "/exit", Description: "exit the chat session"},
		{Name: "/quit", Description: "exit the chat session"},
	} {
		m.commandRegistry.Register(command.Name, command.Description, nil)
	}
	m.renew()
	return m
}
func (m *chatModel) renew() {
	m.closeStreams()
	if m.cancel != nil {
		m.cancel()
	}
	m.gen++
	m.viewCtx, m.cancel = context.WithCancel(m.ctx)
	m.loading = false
	m.metadataLoading = false
	m.approvalLoading = false
	m.approval = nil
	m.approvalParams = nil
}
func (m *chatModel) draft() *remoteDraft {
	d := m.drafts[m.id]
	if d == nil {
		d = &remoteDraft{}
		m.drafts[m.id] = d
	}
	return d
}
func (m *chatModel) save() {
	d := m.draft()
	d.pastedTexts = m.pastedTexts
	if d.text != m.textarea.Value() {
		d.text = m.textarea.Value()
		d.revision++
	}
}
func (m *chatModel) initShared() tea.Cmd {
	var settings tea.Cmd
	if !m.settingsLoaded {
		settings = m.loadSharedSettings()
	}
	if m.hasChat {
		return tea.Batch(textarea.Blink, settings, m.loadSharedMetadata(), m.printHistory(true), m.tick(), m.syncStreams(), m.syncSharedActivity(), m.loadSharedApproval())
	}
	return tea.Batch(m.newDraft(), textarea.Blink, settings)
}
func (m *chatModel) tick() tea.Cmd {
	m.tickSeq++
	seq := m.tickSeq
	g := m.gen
	return tea.Tick(m.delay, func(time.Time) tea.Msg { return remoteTick{g, seq} })
}
func (m *chatModel) load(id string, refresh bool) tea.Cmd {
	ctx, c, g := m.viewCtx, m.client, m.gen
	known := map[string]taskdomain.TaskInfo{}
	for k, v := range m.tasks {
		known[k] = v
	}
	m.loading = true
	return func() tea.Msg {
		r := remoteLoaded{gen: g, id: id, refresh: refresh}
		if r.err = c.request(ctx, "GET", topicPath(id), nil, &r.topic); r.err != nil {
			var e *remoteHTTPError
			r.deleted = errors.As(r.err, &e) && e.status == 404
			return r
		}
		if r.dir, r.err = c.workspace(ctx, id); r.err != nil {
			return r
		}
		cursor := ""
		seen := map[string]bool{}
		for {
			if seen[cursor] {
				r.err = errors.New("repeated history cursor")
				return r
			}
			seen[cursor] = true
			p, err := c.history(ctx, id, cursor)
			if err != nil {
				r.err = err
				return r
			}
			r.tasks = append(r.tasks, p.Items...)
			r.cursor = p.NextCursor
			boundary := false
			for _, t := range p.Items {
				if _, ok := known[t.ID]; ok {
					boundary = true
				}
			}
			if !refresh || boundary || !p.HasNext {
				break
			}
			if p.NextCursor == "" {
				r.err = errors.New("runtime omitted history cursor")
				return r
			}
			cursor = p.NextCursor
		}
		if refresh {
			for _, t := range known {
				if t.Status == taskdomain.TaskRunning || t.Status == taskdomain.TaskQueued || t.Status == taskdomain.TaskPending {
					var latest taskdomain.TaskInfo
					if r.err = c.request(ctx, "GET", "/tasks/"+url.PathEscape(t.ID), nil, &latest); r.err != nil {
						return r
					}
					r.tasks = append(r.tasks, latest)
				}
			}
		}
		return r
	}
}
func (m *chatModel) applyLoaded(r remoteLoaded) {
	if !r.refresh {
		m.save()
		m.id = r.id
		if m.drafts[""].bound == r.id {
			m.drafts[""] = &remoteDraft{}
		}
		m.textarea.SetValue(m.draft().text)
		m.pastedTexts = m.draft().pastedTexts
		if m.pastedTexts == nil {
			m.pastedTexts = make(map[string]string)
		}
		m.pickerClosed, m.pickerIndex = false, 0
		m.resetTopicHistory()
		m.status.model = m.defaultModel
		m.status.contextKnown, m.status.contextRatio = false, 0
		m.cursor = r.cursor
		m.hasChat = true
		m.listing = false
		m.renew()
	}
	m.topic = r.topic
	m.dir = r.dir
	m.status.topic = remoteLine(r.topic.Title)
	m.status.workspace = remoteLine(r.dir)
	m.deleted = false
	m.notice = ""
	m.delay = 3 * time.Second
	for _, t := range r.tasks {
		m.tasks[t.ID] = t
	}
	var latest *taskdomain.TaskInfo
	for _, task := range m.tasks {
		if task.Model != "" && (latest == nil || task.CreatedAt.After(latest.CreatedAt) || (task.CreatedAt.Equal(latest.CreatedAt) && task.ID > latest.ID)) {
			copy := task
			latest = &copy
		}
	}
	if latest != nil {
		m.status.model = remoteLine(latest.Model)
	}
}
func (m *chatModel) openList() tea.Cmd {
	m.save()
	m.renew()
	m.listing = true
	m.filter = ""
	m.topics = nil
	m.selected = 0
	m.listCursor = ""
	m.loading = true
	m.scopeReady = false
	m.notice = "resolving server workspace…"
	ctx, c, g, id, pending := m.viewCtx, m.client, m.gen, m.id, m.draft().workspace
	return func() tea.Msg {
		dir, err := c.scope(ctx, id, pending)
		r := remoteListed{gen: g, dir: dir, err: err}
		if err == nil {
			r.page, r.err = c.topics(ctx, dir, "")
		}
		return r
	}
}
func (m *chatModel) listPage(cursor string) tea.Cmd {
	if m.loading || !m.scopeReady {
		return nil
	}
	m.loading = true
	ctx, c, g, dir := m.viewCtx, m.client, m.gen, m.scope
	return func() tea.Msg {
		p, err := c.topics(ctx, dir, cursor)
		return remoteListed{gen: g, dir: dir, page: p, more: cursor != "", err: err}
	}
}
func (m *chatModel) newDraft() tea.Cmd {
	m.save()
	d := m.drafts[""]
	if d.bound != "" {
		m.renew()
		return m.load(d.bound, false)
	}
	if m.listing && d.workspace != m.scope {
		if d.text != "" || d.pending || d.unknown {
			m.notice = "existing new-topic draft belongs to another workspace; Esc to resume it or /topic new from chat"
			return nil
		}
		d.workspace = m.scope
	}
	m.renew()
	m.id = ""
	m.cursor = ""
	m.topic = taskdomain.TopicInfo{}
	m.dir = d.workspace
	m.textarea.SetValue(d.text)
	m.pastedTexts = d.pastedTexts
	if m.pastedTexts == nil {
		m.pastedTexts = make(map[string]string)
	}
	m.pickerClosed, m.pickerIndex = false, 0
	m.status.topic = ""
	m.status.model = m.defaultModel
	m.status.contextKnown, m.status.contextRatio = false, 0
	m.status.workspace = remoteLine(d.workspace)
	if d.workspace == "" {
		m.status.workspace = m.defaultWorkspace
	}
	m.listing = false
	m.hasChat = true
	m.deleted = false
	m.resetTopicHistory()
	m.notice = ""
	return nil
}
func (m *chatModel) write(kind, method, path string, body any) tea.Cmd {
	m.op++
	op, id, rev, text, c, ctx, gen := m.op, m.id, m.draft().revision, m.draft().text, m.client, m.ctx, m.gen
	m.operations[op] = true
	return func() tea.Msg {
		r := remoteWrite{op: op, gen: gen, kind: kind, id: id, revision: rev, text: text}
		var out any
		if kind == "submit" {
			out = &r.task
		} else if kind == "stop" {
			out = &r.stop
		}
		r.err = c.request(ctx, method, path, body, out)
		return r
	}
}
func (m *chatModel) submit(text string) tea.Cmd {
	d := m.draft()
	if m.id == "" && d.bound != "" {
		m.notice = "draft already created; /topic new resumes it"
		return nil
	}
	if m.deleted {
		m.notice = "topic deleted; sending disabled"
		return nil
	}
	if d.pending {
		m.notice = "waiting for submission acknowledgement"
		return nil
	}
	if m.id == "" && d.unknown {
		m.notice = "draft submission unresolved; inspect /topics before sending again"
		return nil
	}
	m.save()
	d.pending = true
	workspace := ""
	if m.id == "" {
		workspace = d.workspace
	}
	return m.write("submit", "POST", "/tasks", daemonruntime.SubmitTaskRequest{Task: text, TopicID: m.id, WorkspaceDir: workspace})
}

func isSharedTaskCommand(name string) bool {
	switch name {
	case "/reset", "/init", "/update", "/models", "/skills", "/think", "/ctx":
		return true
	default:
		return false
	}
}

func (m *chatModel) command(text string) tea.Cmd {
	name, args := chatcommands.ParseCommand(text)
	name = chatcommands.NormalizeCommand(name)
	text = strings.TrimSpace(name + " " + args)
	switch name {
	case "/quit", "/exit", "/topics", "/status", "/stop", "/reset", "/approve", "/deny", "/help":
		text = name
	}
	switch {
	case text == "/quit" || text == "/exit":
		m.cancel()
		m.closeStreams()
		return tea.Quit
	case text == "/topics":
		return m.openList()
	case text == "/topic new":
		return m.newDraft()
	case text == "/topic":
		return m.enqueueTranscript("/topic new · switch <id> · history [more] · title regenerate · delete")
	case strings.HasPrefix(text, "/topic switch "):
		m.renew()
		return m.load(strings.TrimSpace(strings.TrimPrefix(text, "/topic switch ")), false)
	case text == "/topic history":
		return m.printHistory(true)
	case text == "/topic history more":
		if m.id == "" || m.cursor == "" || m.loading {
			return nil
		}
		m.loading = true
		ctx, c, g, id, cursor := m.viewCtx, m.client, m.gen, m.id, m.cursor
		return func() tea.Msg { p, err := c.history(ctx, id, cursor); return remoteOlder{gen: g, page: p, err: err} }
	case text == "/workspace":
		if m.id == "" {
			path := m.draft().workspace
			if path == "" {
				path = m.defaultWorkspace + " (server default)"
			}
			return m.enqueueTranscript(formatChatCommandOutput("/workspace", remoteDisplay("Workspace: "+path), m.commandRegistry))
		}
		ctx, c, g, id := m.viewCtx, m.client, m.gen, m.id
		return func() tea.Msg {
			path, err := c.workspace(ctx, id)
			return remoteStatus{gen: g, command: "/workspace", text: "Workspace: " + path, err: err}
		}
	case text == "/workspace detach" || strings.HasPrefix(text, "/workspace attach "):
		path := strings.TrimSpace(strings.TrimPrefix(text, "/workspace attach "))
		if text == "/workspace detach" {
			path = ""
		}
		if m.id == "" {
			m.draft().workspace = path
			m.dir = path
			m.status.workspace = remoteLine(path)
			if path == "" {
				m.status.workspace = m.defaultWorkspace
			}
			m.notice = "draft workspace updated (validated by server on send)"
			return nil
		}
		if path == "" {
			return m.write("workspace", "DELETE", "/workspace?topic_id="+url.QueryEscape(m.id), nil)
		}
		return m.write("workspace", "PUT", "/workspace", map[string]string{"topic_id": m.id, "workspace_dir": path})
	case text == "/status":
		workspace := m.status.workspace
		header := fmt.Sprintf("Endpoint: %s\nTopic: %s\nWorkspace: %s\nFile state: %s\nFile cache: %s\nVersion: %s", m.client.base, m.id, workspace, m.fileStateDir, m.fileCacheDir, m.version)
		model := m.status.model
		if m.id == "" {
			return m.enqueueTranscript(formatChatCommandOutput("/status", remoteDisplay(header+"\nModel: "+model+"\nContext: unknown"), m.commandRegistry))
		}
		ctx, c, g, id := m.viewCtx, m.client, m.gen, m.id
		return func() tea.Msg {
			var metadata daemonruntime.TopicMetadata
			err := c.request(ctx, "GET", "/topic/"+url.PathEscape(id)+"/metadata", nil, &metadata)
			usage := "unknown"
			if metadata.Context.Available {
				usage = fmt.Sprintf("%.1f%%", metadata.Context.UsageRatio*100)
			}
			if metadata.Context.Model != "" {
				model = metadata.Context.Model
			}
			return remoteStatus{gen: g, command: "/status", text: header + "\nModel: " + model + "\nContext: " + usage, err: err}
		}
	case text == "/stop" || text == "/topic title regenerate" || text == "/topic delete":
		if m.id == "" {
			m.notice = "send a message first to create a topic"
			return nil
		}
		if text == "/topic delete" {
			m.confirm = m.id
			m.notice = "Delete topic and stop its running tasks? y / n"
			return nil
		}
		if text == "/stop" {
			return m.write("stop", "POST", topicPath(m.id)+"/stop", nil)
		}
		return m.write("title", "POST", topicPath(m.id)+"/regenerate-title", nil)
	case text == "/reset" && m.id == "":
		m.textarea.Reset()
		m.save()
		return m.enqueueTranscript(formatChatCommandOutput("/reset", "Session reset.", m.commandRegistry))
	case text == "/approve" || text == "/deny":
		return m.decideSharedApproval(text == "/approve")
	case text == "/help":
		return m.enqueueTranscript(formatChatCommandOutput("/help", "", m.commandRegistry) + "\n\n/topic new|switch <id>|history [more]|title regenerate|delete")
	default:
		if isChatAgentCommand(name) {
			return m.openAgentBrowser(strings.TrimSpace(args))
		}
		if isSharedTaskCommand(name) {
			if name == "/ctx" && m.id == "" {
				m.notice = "send a message first to create a topic"
				return nil
			}
			return m.submit(text)
		}
		m.notice = "unknown command; /help lists available commands"
		return nil
	}
}

type remoteOlder struct {
	gen  uint64
	page pagination.Page[taskdomain.TaskInfo]
	err  error
}
type remoteStatus struct {
	gen           uint64
	command, text string
	err           error
}

func (m *chatModel) updateShared(msg tea.Msg) (tea.Cmd, bool) {
	if m.updateTopicNavigation(msg) {
		return nil, true
	}
	switch r := msg.(type) {
	case sharedApproval:
		m.applySharedApproval(r)
		return nil, true
	case sharedApprovalDecision:
		return m.applySharedApprovalDecision(r), true
	case sharedSettings:
		m.applySharedSettings(r)
		return nil, true
	case sharedMetadata:
		if r.gen != m.gen || r.id != m.id {
			return nil, true
		}
		m.metadataLoading = false
		if r.err == nil {
			context := r.metadata.Context
			m.status.contextKnown = context.Available && context.ContextWindowTokens > 0
			m.status.contextRatio = context.UsageRatio
			if context.Model != "" {
				m.status.model = remoteLine(context.Model)
			}
		}
		return nil, true
	case remoteStreamEvent:
		return m.streamUpdate(r), true
	case remoteStatus:
		if r.gen == m.gen {
			if r.err != nil {
				m.notice = r.err.Error()
			} else {
				return m.enqueueTranscript(formatChatCommandOutput(r.command, remoteDisplay(r.text), m.commandRegistry)), true
			}
		}
		return nil, true
	case remoteOlder:
		if r.gen != m.gen {
			return nil, true
		}
		m.loading = false
		if r.err != nil {
			m.notice = r.err.Error()
			return m.tick(), true
		}
		for _, t := range r.page.Items {
			m.tasks[t.ID] = t
		}
		m.cursor = r.page.NextCursor
		return tea.Batch(m.printHistory(true), m.tick(), m.syncStreams()), true
	case remoteTick:
		if r.seq != m.tickSeq {
			return nil, true
		}
		if r.gen != m.gen || m.listing || m.id == "" {
			return nil, true
		}
		if m.loading {
			return m.tick(), true
		}
		return m.load(m.id, true), true
	case remoteLoaded:
		if r.gen != m.gen {
			return nil, true
		}
		m.loading = false
		if r.err != nil {
			m.notice = "stale: " + r.err.Error()
			if r.refresh && r.deleted {
				m.deleted = true
				m.notice = "topic deleted; sending disabled"
				m.closeStreams()
			}
			m.delay = min(30*time.Second, m.delay*2)
			return tea.Batch(m.tick(), m.syncStreams()), true
		}
		// Binding the first send to its server topic continues the current chat;
		// only an explicit topic selection replays history with a heading.
		created := !m.listing && m.id == "" && m.draft().bound == r.id
		m.applyLoaded(r)
		return tea.Batch(m.printHistory(!r.refresh && !created), m.tick(), m.syncStreams(), m.loadSharedMetadata(), m.loadSharedApproval()), true
	case remoteListed:
		if r.gen != m.gen || !m.listing {
			return nil, true
		}
		m.loading = false
		if r.err != nil {
			m.notice = r.err.Error()
			return nil, true
		}
		old := topicListRow{}
		rows := m.listRows()
		if m.selected >= 0 && m.selected < len(rows) {
			old = rows[m.selected]
		}
		m.scopeReady = true
		m.scope = r.dir
		if !r.more {
			m.topics = nil
		}
		seen := map[string]bool{}
		for _, t := range m.topics {
			seen[t.ID] = true
		}
		for _, t := range r.page.Items {
			if !seen[t.ID] {
				m.topics = append(m.topics, t)
				seen[t.ID] = true
			}
		}
		sort.Slice(m.topics, func(i, j int) bool {
			a, b := m.topics[i], m.topics[j]
			if a.UpdatedAt.Equal(b.UpdatedAt) {
				return a.ID > b.ID
			}
			return a.UpdatedAt.After(b.UpdatedAt)
		})
		m.listCursor = r.page.NextCursor
		m.notice = "connected"
		rows = m.listRows()
		m.selected = min(max(0, m.selected), max(0, len(rows)-1))
		for i, row := range rows {
			if (old.id != "" && row.id == old.id) || (old.action != "" && row.action == old.action) {
				m.selected = i
				break
			}
		}
		return nil, true
	case remoteWrite:
		if !m.operations[r.op] {
			return nil, true
		}
		delete(m.operations, r.op)
		d := m.drafts[r.id]
		if r.kind == "submit" {
			d.pending = false
			if r.err != nil {
				var he *remoteHTTPError
				d.unknown = !errors.As(r.err, &he) || he.status >= 500
				if r.id == m.id {
					m.notice = r.err.Error() + "; submission may be unknown: refresh history, do not automatically retry"
				}
				return nil, true
			}
			if r.task.ID == "" || r.task.TopicID == "" {
				d.unknown = true
				m.notice = "submission result unknown: runtime omitted task/topic ID"
				return nil, true
			}
			if d.revision == r.revision && d.text == r.text {
				d.text = ""
				d.pastedTexts = make(map[string]string)
				d.revision++
				if m.id == r.id {
					m.textarea.SetValue("")
					m.pastedTexts = d.pastedTexts
				}
			}
			if r.id == "" {
				d.bound = r.task.TopicID
				m.drafts[r.task.TopicID] = d
				d.workspace = ""
				if m.id != "" {
					m.drafts[""] = &remoteDraft{}
				}
			}
			if m.id == r.id && !m.listing && r.gen == m.gen {
				m.renew()
				return m.load(r.task.TopicID, r.id != ""), true
			}
			return nil, true
		}
		if m.id != r.id || r.gen != m.gen {
			return nil, true
		}
		if r.err != nil {
			m.notice = r.err.Error()
			return nil, true
		}
		if r.kind == "delete" {
			m.deleted = true
			m.hasChat = false
			m.save()
			m.id = ""
			m.textarea.SetValue(m.drafts[""].text)
			m.drafts[""].workspace = m.dir
			m.pastedTexts = m.drafts[""].pastedTexts
			if m.pastedTexts == nil {
				m.pastedTexts = make(map[string]string)
			}
			return m.openList(), true
		}
		m.notice = r.kind + " succeeded"
		var feedback tea.Cmd
		if r.kind == "stop" {
			m.notice = ""
			feedback = m.enqueueTranscript(formatChatCommandOutput("/stop", remoteDisplay(strings.TrimSpace(r.stop.Message+"\n"+r.stop.Progress)), m.commandRegistry))
		}
		if !m.listing {
			m.renew()
			return tea.Batch(feedback, m.load(m.id, true)), true
		}
		return feedback, true
	case tea.KeyPressMsg:
		key := r.String()
		if !m.listing && m.confirm == "" {
			return nil, false
		}
		if key == "ctrl+c" && m.listing {
			if m.filter != "" {
				m.filter = ""
				m.selected = 0
				return nil, true
			}
			m.cancel()
			m.closeStreams()
			return tea.Quit, true
		}
		if m.confirm != "" {
			id := m.confirm
			m.confirm = ""
			if key == "y" && id == m.id {
				return m.write("delete", "DELETE", topicPath(id), nil), true
			}
			m.notice = "delete canceled"
			return nil, true
		}
		if m.listing {
			rows := m.listRows()
			switch key {
			case "esc":
				if m.hasChat {
					if m.id == "" && m.drafts[""].bound != "" {
						m.renew()
						return m.load(m.drafts[""].bound, false), true
					}
					m.renew()
					m.listing = false
					m.notice = ""
					m.textarea.SetValue(m.draft().text)
					return tea.Batch(m.tick(), m.syncStreams()), true
				}
			case "enter":
				if !m.loading && m.selected >= 0 && m.selected < len(rows) {
					row := rows[m.selected]
					switch row.action {
					case "new":
						return m.newDraft(), true
					case "more":
						return m.listPage(m.listCursor), true
					}
					m.renew()
					return m.load(row.id, false), true
				}
			case "ctrl+n":
				if !m.loading && m.scopeReady {
					return m.newDraft(), true
				}
			case "ctrl+l":
				if m.listCursor != "" {
					return m.listPage(m.listCursor), true
				}
			case "ctrl+s":
				return m.enqueueTranscript(remoteDisplay(fmt.Sprintf("endpoint: %s\nworkspace: %s\n%s", m.client.base, m.scope, m.notice))), true
			case "ctrl+r":
				if !m.loading {
					if !m.scopeReady {
						return m.openList(), true
					}
					return m.listPage(""), true
				}
			default:
				if r.Text != "" {
					m.filter += r.Text
					m.selected = 0
				}
			}
			return nil, true
		}
	}
	return nil, false
}

func remoteLine(text string) string {
	return strings.Join(strings.Fields(remoteDisplay(text)), " ")
}
