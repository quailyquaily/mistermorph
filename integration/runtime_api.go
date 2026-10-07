package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/personautil"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

const (
	// runtimeAPIHistoryTurns caps how many earlier exchanges of a topic a chat message carries.
	runtimeAPIHistoryTurns = 20
	// runtimeAPITopicTitleRunes is the length of a new topic's title, taken from its first message.
	runtimeAPITopicTitleRunes = 48
)

// RuntimeAPIOptions configures ServeRuntimeAPI.
type RuntimeAPIOptions struct {
	// Registry is the tool registry every chat message runs with, such as rt.NewRegistry() with
	// the program's own tools added. Nil uses the built-in tools.
	Registry *tools.Registry
}

// ServeRuntimeAPI serves the runtime API on server.listen until ctx ends, so a Console can add this
// program as an endpoint: url "http://<server.listen>/runtime", auth_token server.auth_token.
//
// The Console lists the tasks the program persists (RunTaskWithOptions with PersistTask), and can
// chat with the program: each message runs through this Runtime, with the earlier exchanges of its
// topic as history. When ctx ends, ServeRuntimeAPI stops the tasks it started, waits for them and
// returns.
func (rt *Runtime) ServeRuntimeAPI(ctx context.Context, opts RuntimeAPIOptions) error {
	if err := rt.Err(); err != nil {
		return err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	snap := rt.snapshot()
	if snap.Server.Listen == "" {
		return errors.New("server.listen is not set")
	}
	api, err := rt.newRuntimeAPI(ctx, opts)
	if err != nil {
		return err
	}
	defer api.close()
	if _, err := daemonruntime.StartServer(ctx, snap.Logger, daemonruntime.ServerOptions{
		Listen: snap.Server.Listen,
		Routes: api.routes(),
	}); err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

// runtimeAPI runs the tasks submitted over the runtime API and keeps them, with the program's own
// persisted tasks, in one store under the integration target.
type runtimeAPI struct {
	rt       *Runtime
	snap     runtimeSnapshot
	registry *tools.Registry
	store    *daemonruntime.ConsoleFileStore
	ctx      context.Context
	cancel   context.CancelFunc
	seq      atomic.Uint64

	mu     sync.Mutex
	tasks  map[string]*runtimeAPITask
	topics map[string]*sync.Mutex
	wg     sync.WaitGroup
}

type runtimeAPITask struct {
	topicID string
	cancel  context.CancelFunc
}

func (rt *Runtime) newRuntimeAPI(ctx context.Context, opts RuntimeAPIOptions) (*runtimeAPI, error) {
	snap := rt.snapshot()
	if snap.Server.AuthToken == "" {
		return nil, errors.New("server.auth_token is required to serve the runtime API")
	}
	store, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{
		RootDir:        snap.Paths.TaskTargetDir(defaultIntegrationTaskTarget),
		Target:         defaultIntegrationTaskTarget,
		Persist:        true,
		JournalDir:     snap.Paths.JournalDir,
		RotateMaxBytes: snap.Registry.TasksRotateMaxBytes,
		// The program may be running its own tasks; recoverStaleTasks cancels only ours.
		SkipRecovery: true,
	})
	if err != nil {
		return nil, fmt.Errorf("open runtime API task store: %w", err)
	}
	apiCtx, cancel := context.WithCancel(ctx)
	api := &runtimeAPI{
		rt:       rt,
		snap:     snap,
		registry: opts.Registry,
		store:    store,
		ctx:      apiCtx,
		cancel:   cancel,
		tasks:    map[string]*runtimeAPITask{},
		topics:   map[string]*sync.Mutex{},
	}
	if err := api.recoverStaleTasks(); err != nil {
		cancel()
		return nil, err
	}
	return api, nil
}

// close stops the tasks the API started and waits for them to record how they ended.
func (a *runtimeAPI) close() {
	a.cancel()
	a.wg.Wait()
}

func (a *runtimeAPI) routes() daemonruntime.RoutesOptions {
	stateDir := a.snap.Paths.StateDir
	return daemonruntime.RoutesOptions{
		Mode:          defaultIntegrationTaskTarget,
		AgentNameFunc: func() string { return personautil.LoadAgentName(stateDir) },
		AuthToken:     a.snap.Server.AuthToken,
		RuntimePaths:  a.snap.Paths,
		HealthEnabled: true,
		Overview:      a.overview,
		TaskTopic: daemonruntime.TaskTopicRoutes{
			TaskReader:   a.store,
			TopicReader:  a.store,
			TopicDeleter: a.store,
			CreateTopic:  a.store.CreateNamedTopic,
			SetTopicTags: a.store.SetTopicTags,
			Submit:       a.submit,
			Stop:         a.stop,
		},
	}
}

func (a *runtimeAPI) overview(ctx context.Context) (map[string]any, error) {
	provider, model := "", ""
	if route, err := a.rt.resolveRunMainRoute(ctx, a.snap, ""); err == nil {
		provider = strings.TrimSpace(route.ClientConfig.Provider)
		model = strings.TrimSpace(route.ClientConfig.Model)
	}
	return map[string]any{
		"llm": map[string]any{
			"provider": provider,
			"model":    model,
		},
		"channel": map[string]any{
			"configured": false,
			"running":    defaultIntegrationTaskTarget,
		},
	}, nil
}

func (a *runtimeAPI) submit(_ context.Context, req daemonruntime.SubmitTaskRequest) (daemonruntime.SubmitTaskResponse, error) {
	task := strings.TrimSpace(req.Task)
	if task == "" {
		return daemonruntime.SubmitTaskResponse{}, daemonruntime.BadRequest("missing task")
	}
	if len(req.FileReferences) > 0 {
		return daemonruntime.SubmitTaskResponse{}, daemonruntime.BadRequest("this runtime does not take attached files")
	}
	topicID := strings.TrimSpace(req.TopicID)
	if topicID != "" && topicID != daemonruntime.ConsoleDefaultTopicID {
		if topic, ok := a.store.GetTopic(topicID); !ok || topic == nil || topic.DeletedAt != nil {
			return daemonruntime.SubmitTaskResponse{}, daemonruntime.BadRequest("topic not found")
		}
	}
	timeout := a.snap.TaskTimeout
	if raw := strings.TrimSpace(req.Timeout); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			return daemonruntime.SubmitTaskResponse{}, daemonruntime.BadRequest("invalid timeout (use Go duration like 2m, 30s)")
		}
		timeout = d
	}
	topicTitle := strings.TrimSpace(req.TopicTitle)
	if topicID == "" {
		id, err := uuid.NewV7()
		if err != nil {
			id = uuid.New()
		}
		topicID = id.String()
		if topicTitle == "" {
			topicTitle = runtimeAPITopicTitle(task)
		}
	}

	now := time.Now().UTC()
	taskID := daemonruntime.BuildTaskID(defaultIntegrationTaskTarget, now.UnixNano(), a.seq.Add(1))
	trigger := daemonruntime.TaskTrigger{Source: "ui", Event: "chat_submit", Ref: "runtime_api"}
	if req.Trigger != nil && strings.TrimSpace(req.Trigger.Source) != "" {
		trigger = taskdomain.NormalizeTaskTrigger(*req.Trigger)
	}
	if trigger.TraceID == "" {
		trigger.TraceID = taskID
	}
	model := strings.TrimSpace(req.Model)
	profile := strings.TrimSpace(req.LLMProfile)
	shownModel := model
	if shownModel == "" {
		route, err := a.rt.resolveRunMainRoute(context.Background(), a.snap, profile)
		if err != nil && profile != "" {
			return daemonruntime.SubmitTaskResponse{}, daemonruntime.BadRequest(strings.TrimSpace(err.Error()))
		}
		if err == nil {
			shownModel = strings.TrimSpace(route.ClientConfig.Model)
		}
	}
	job := runtimeAPIJob{
		id:      taskID,
		task:    task,
		model:   model,
		profile: profile,
		topicID: topicID,
		traceID: trigger.TraceID,
		timeout: timeout,
	}

	runCtx, err := a.admit(job)
	if err != nil {
		return daemonruntime.SubmitTaskResponse{}, err
	}
	info := daemonruntime.TaskInfo{
		ID:         taskID,
		Status:     daemonruntime.TaskQueued,
		Task:       task,
		Model:      shownModel,
		LLMProfile: job.profile,
		Timeout:    timeout.String(),
		CreatedAt:  now,
		TopicID:    topicID,
	}
	if err := a.store.UpsertWithTrigger(info, trigger, topicTitle); err != nil {
		a.release(taskID)
		return daemonruntime.SubmitTaskResponse{}, err
	}
	go a.run(runCtx, job)
	return daemonruntime.SubmitTaskResponse{ID: taskID, Status: daemonruntime.TaskQueued, TopicID: topicID}, nil
}

type runtimeAPIJob struct {
	id      string
	task    string
	model   string
	profile string
	topicID string
	traceID string
	timeout time.Duration
}

// admit reserves a place for the job, within server.max_queue tasks queued or running.
func (a *runtimeAPI) admit(job runtimeAPIJob) (context.Context, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ctx.Err() != nil {
		return nil, errors.New("runtime API is shutting down")
	}
	if limit := a.snap.Server.MaxQueue; limit > 0 && len(a.tasks) >= limit {
		return nil, fmt.Errorf("task queue is full (%d)", limit)
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.tasks[job.id] = &runtimeAPITask{topicID: job.topicID, cancel: cancel}
	a.wg.Add(1)
	return ctx, nil
}

func (a *runtimeAPI) release(taskID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if task, ok := a.tasks[taskID]; ok {
		task.cancel()
		delete(a.tasks, taskID)
		a.wg.Done()
	}
}

// topicLock keeps the messages of one topic in order: each waits for the one before it.
func (a *runtimeAPI) topicLock(topicID string) *sync.Mutex {
	a.mu.Lock()
	defer a.mu.Unlock()
	lock, ok := a.topics[topicID]
	if !ok {
		lock = &sync.Mutex{}
		a.topics[topicID] = lock
	}
	return lock
}

func (a *runtimeAPI) run(ctx context.Context, job runtimeAPIJob) {
	defer a.release(job.id)
	lock := a.topicLock(job.topicID)
	lock.Lock()
	defer lock.Unlock()
	if ctx.Err() != nil {
		a.finish(job.id, nil, ctx.Err(), true)
		return
	}

	history := a.history(job.topicID, job.id)
	startedAt := time.Now().UTC()
	_ = a.store.Update(job.id, func(info *daemonruntime.TaskInfo) {
		info.Status = daemonruntime.TaskRunning
		info.StartedAt = &startedAt
	})
	if job.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, job.timeout)
		defer cancel()
	}
	result, err := a.rt.RunTaskWithOptions(ctx, job.task, RunTaskOptions{
		Agent:      agent.RunOptions{Model: job.model, History: history},
		LLMProfile: job.profile,
		TaskID:     job.id,
		TopicID:    job.topicID,
		TraceID:    job.traceID,
		Registry:   a.registry,
	})
	a.finish(job.id, result.Final, err, taskdomain.EndedByCancellation(ctx, err))
}

func (a *runtimeAPI) finish(taskID string, final *agent.Final, runErr error, canceled bool) {
	finishedAt := time.Now().UTC()
	err := a.store.Update(taskID, func(info *daemonruntime.TaskInfo) {
		info.FinishedAt = &finishedAt
		switch {
		case runErr == nil:
			info.Status = daemonruntime.TaskDone
			info.Error = ""
			info.Result = map[string]any{"final": final}
		case canceled:
			info.Status = daemonruntime.TaskCanceled
			info.Error = strings.TrimSpace(runErr.Error())
		default:
			info.Status = daemonruntime.TaskFailed
			info.Error = strings.TrimSpace(runErr.Error())
		}
	})
	if err != nil && a.snap.Logger != nil {
		a.snap.Logger.Warn("runtime_api_task_update_failed", "task_id", taskID, "error", err.Error())
	}
}

func (a *runtimeAPI) stop(_ context.Context, req daemonruntime.StopTaskRequest) (daemonruntime.StopTaskResponse, error) {
	taskID := strings.TrimSpace(req.TaskID)
	topicID := strings.TrimSpace(req.TopicID)
	if taskID == "" && topicID == "" {
		return daemonruntime.StopTaskResponse{}, daemonruntime.BadRequest("task_id or topic_id is required")
	}
	found := false
	a.mu.Lock()
	for id, task := range a.tasks {
		if (taskID != "" && id == taskID) || (taskID == "" && task.topicID == topicID) {
			task.cancel()
			found = true
		}
	}
	a.mu.Unlock()
	resp := daemonruntime.StopTaskResponse{Status: "not_found", Found: found, TaskID: taskID, TopicID: topicID}
	if found {
		resp.Status = "stopping"
	}
	return resp, nil
}

// history is the topic's earlier finished exchanges, oldest first, as user and assistant turns.
func (a *runtimeAPI) history(topicID, currentTaskID string) []llm.Message {
	items := a.store.List(daemonruntime.TaskListOptions{
		TopicID: topicID,
		Status:  daemonruntime.TaskDone,
		Limit:   runtimeAPIHistoryTurns + 1,
	})
	sort.SliceStable(items, func(i, j int) bool { return items[i].CreatedAt.Before(items[j].CreatedAt) })
	out := make([]llm.Message, 0, 2*len(items))
	for _, item := range items {
		if item.ID == currentTaskID {
			continue
		}
		output := runtimeAPITaskOutput(item.Result)
		if strings.TrimSpace(item.Task) == "" || output == "" {
			continue
		}
		out = append(out,
			llm.Message{Role: "user", Content: item.Task},
			llm.Message{Role: "assistant", Content: output},
		)
	}
	if limit := 2 * runtimeAPIHistoryTurns; len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

// recoverStaleTasks cancels the tasks a previous run of the API left queued or running. Tasks the
// program persists itself are left alone: they may still be running.
func (a *runtimeAPI) recoverStaleTasks() error {
	now := time.Now().UTC()
	for _, status := range []daemonruntime.TaskStatus{daemonruntime.TaskQueued, daemonruntime.TaskRunning} {
		for _, item := range a.store.List(daemonruntime.TaskListOptions{Status: status, Limit: 1000}) {
			if trigger, ok := a.store.GetTrigger(item.ID); ok && trigger.Source == defaultIntegrationTaskTarget {
				continue
			}
			if err := a.store.Update(item.ID, func(info *daemonruntime.TaskInfo) {
				info.Status = daemonruntime.TaskCanceled
				info.Error = "runtime restarted"
				info.FinishedAt = &now
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

// runtimeAPITaskOutput reads the final output from a task result, whether it holds the agent's
// final answer (tasks run over the API) or a plain output summary (tasks the program persisted).
func runtimeAPITaskOutput(result any) string {
	if result == nil {
		return ""
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return ""
	}
	var parsed struct {
		Final  *struct{ Output any } `json:"final"`
		Output any                   `json:"output"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return ""
	}
	if parsed.Final != nil {
		return integrationFinalOutput(&agent.Final{Output: parsed.Final.Output})
	}
	if s, ok := parsed.Output.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func runtimeAPITopicTitle(task string) string {
	line := strings.TrimSpace(strings.SplitN(task, "\n", 2)[0])
	runes := []rune(line)
	if len(runes) > runtimeAPITopicTitleRunes {
		return strings.TrimSpace(string(runes[:runtimeAPITopicTitleRunes])) + "…"
	}
	return line
}
