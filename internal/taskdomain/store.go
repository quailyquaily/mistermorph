package taskdomain

type TaskListOptions struct {
	Status  TaskStatus
	Limit   int
	TopicID string
	Cursor  string
	// AllTopics, with no TopicID, includes the tasks in the runtime's own topics (Awareness, the
	// Agent Link agents'), which a list without a topic otherwise leaves out.
	AllTopics bool
}

type TaskReader interface {
	List(opts TaskListOptions) []TaskInfo
	Get(id string) (*TaskInfo, bool)
}

// TaskTriggerReader reports what started a task, for task readers that keep it.
type TaskTriggerReader interface {
	GetTrigger(taskID string) (TaskTrigger, bool)
}

type TaskUpdater interface {
	Update(id string, fn func(*TaskInfo)) error
}

type TaskWriter interface {
	Upsert(info TaskInfo) error
	TaskUpdater
}

type TaskView interface {
	TaskReader
	TaskWriter
}

type TaskEventRecorder interface {
	RecordTaskUpsert(info TaskInfo, trigger TaskTrigger) error
	RecordTaskUpdate(id string, trigger TaskTrigger, fn func(*TaskInfo)) error
}

func RecordTaskUpsert(store TaskWriter, info TaskInfo, trigger TaskTrigger) error {
	if store == nil {
		return nil
	}
	if recorder, ok := store.(TaskEventRecorder); ok {
		return recorder.RecordTaskUpsert(info, trigger)
	}
	return store.Upsert(info)
}

func RecordTaskUpdate(store TaskUpdater, id string, trigger TaskTrigger, fn func(*TaskInfo)) error {
	if store == nil || fn == nil {
		return nil
	}
	if recorder, ok := store.(TaskEventRecorder); ok {
		return recorder.RecordTaskUpdate(id, trigger, fn)
	}
	return store.Update(id, fn)
}
