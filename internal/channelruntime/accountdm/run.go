// Package accountdm is the task engine shared by channels that only have private chats with one
// bound account: WeChat and WhatsApp. A channel package supplies the Transport (how messages are
// polled and sent); this package runs the tasks, commands, approvals and history the same way the
// other channels do.
package accountdm

import (
	"context"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

type HandleModelCommandFunc func(text string) (string, bool, error)
type HandleSkillCommandFunc func(currentLoaded []string) (string, error)

type Dependencies struct {
	depsutil.CommonDependencies
	HandleModelCommand HandleModelCommandFunc
	HandleSkillCommand HandleSkillCommandFunc
}

// Inbound is one private message a transport received.
type Inbound struct {
	AccountID        string
	PeerID           string
	MessageID        string
	SentAt           time.Time
	DisplayName      string
	Text             string
	ReplyToMessageID string
	// Media is what the message carried besides text. It is downloaded only for a message that
	// starts a task: not for a replay, nor for a user the allowlist keeps out.
	Media []Media
	// Unsupported marks a message the channel cannot pass to the agent: it is answered once with a
	// short notice instead of starting a task.
	Unsupported bool
}

// Media is one inbound attachment. Kind is image, file, audio or video.
type Media struct {
	Kind     string
	Name     string
	MIMEType string
	// Fetch downloads the bytes and returns them with their MIME type ("" when unknown).
	Fetch func(ctx context.Context) ([]byte, string, error)
}

// OutboundFile is a local file to send, already checked to be under file_cache_dir.
type OutboundFile struct {
	Path     string
	Name     string
	MIMEType string
	Caption  string
}

// unsupportedNotice answers a message the agent cannot read.
const unsupportedNotice = "I can't read this kind of message here."

// Transport is a channel's connection to its platform.
type Transport interface {
	// Run polls until ctx ends, passing each message to deliver in order, and returns why it stopped.
	Run(ctx context.Context, deliver func(context.Context, Inbound) error) error
	// SendText sends one message of at most MaxTextLength characters to peerID.
	SendText(ctx context.Context, accountID, peerID, text, replyTo string) error
	// AccountID is the bound bot or agent, "" until it is known.
	AccountID() string
	// MaxTextLength is the longest text one message may hold.
	MaxTextLength() int
	// SendFile sends a local file to peerID: an image or video as one, anything else as a file.
	SendFile(ctx context.Context, accountID, peerID string, file OutboundFile) error
	// MaxFileBytes is the largest file SendFile takes.
	MaxFileBytes() int64
	// Typing shows "typing" to peerID until stop is called; a transport that cannot returns a no-op.
	Typing(ctx context.Context, accountID, peerID string) (stop func())
	// Overview is the channel's entry in the runtime overview (connected, status, account).
	Overview() map[string]any
}

type Options struct {
	Channel           busruntime.Channel
	Transport         Transport
	PromptBlocks      func(spec *agent.PromptSpec)
	TaskTimeout       time.Duration
	MaxConcurrency    int
	FileCacheDir      string
	ServerListen      string
	ServerAuthToken   string
	ServerMaxQueue    int
	BusMaxInFlight    int
	AgentLimits       agent.Limits
	EngineToolsConfig agent.EngineToolsConfig
	InspectPrompt     bool
	InspectRequest    bool
	TaskStore         daemonruntime.TaskView
	Poke              daemonruntime.PokeFunc
	CronRun           daemonruntime.CronRunFunc
}

func Run(ctx context.Context, d Dependencies, opts Options) error {
	if err := d.CommonDependencies.Validate(); err != nil {
		return err
	}
	return runLoop(ctx, d, normalizeOptions(opts))
}
