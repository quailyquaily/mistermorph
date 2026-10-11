// Package xchannel runs Morph as an X (Twitter) account: direct messages through the shared
// accountdm engine, and public mentions through socialpost. Every X API call is billed, so polling
// is slow by default and the day's usage is shown in the overview. See
// docs/feat/feat_20261011_x_bluesky_channels.md.
package xchannel

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/socialpost"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/internal/runtimelock"
	"github.com/quailyquaily/mistermorph/internal/xapi"
	"github.com/quailyquaily/mistermorph/internal/xlogin"
)

// Connection states shown in the overview.
const (
	StatusConnecting   = "connecting"
	StatusOnline       = "online"
	StatusDisconnected = "disconnected"
	StatusReauth       = "reauth_needed"
	StatusNoCredits    = "out_of_credits"
)

const (
	maxBackoff = 15 * time.Minute
	// replayWindow is how old a message may be and still be answered after a start.
	replayWindow    = 24 * time.Hour
	maxImageBytes   = int64(5 << 20)
	defaultDMPoll   = 60 * time.Second
	defaultPostPoll = 120 * time.Second
	dmPageSize      = 20
	mentionPageSize = 20
)

// RunOptions configure the X runtime.
type RunOptions struct {
	accountdm.Options
	ClientID     string
	ClientSecret string
	RefreshToken string
	BaseURL      string

	DMEnabled        bool
	DMPollInterval   time.Duration
	DMAllowedUserIDs []string
	// Owners get heartbeat notifications: user IDs or @usernames.
	Owners []string

	MentionsEnabled        bool
	MentionsPollInterval   time.Duration
	MentionsAllowedUserIDs []string
	MentionsBlockedUserIDs []string
	ThreadContextDepth     int
	MaxReplyPosts          int
	MaxPostsPerDay         int
	AllowLinksInPosts      bool

	OnStatusChange func(status string)
	RuntimeLabel   string

	client *xapi.Client
	now    func() time.Time
}

// Run serves the account until ctx ends. Only one process may serve an account at a time.
func Run(ctx context.Context, d accountdm.Dependencies, opts RunOptions) error {
	if !opts.DMEnabled && !opts.MentionsEnabled {
		return fmt.Errorf("x: both x.dm.enabled and x.mentions.enabled are off")
	}
	client := opts.client
	if client == nil {
		if strings.TrimSpace(opts.ClientID) == "" {
			return fmt.Errorf("missing x.client_id: register an app in the X Developer Console, then log in (`morph x login`, or Console > Settings > Channels > X)")
		}
		if !xlogin.Configured(d.RuntimePaths.StateDir, opts.RefreshToken) {
			return fmt.Errorf("x is not logged in: run `morph x login`, or log in from Console > Settings > Channels > X")
		}
		var err error
		client, err = xapi.NewClient(xapi.Options{
			ClientID: opts.ClientID, ClientSecret: opts.ClientSecret, RefreshToken: opts.RefreshToken, BaseURL: opts.BaseURL,
			Store: xlogin.Store{StateDir: d.RuntimePaths.StateDir},
		})
		if err != nil {
			return err
		}
	}
	logger, err := d.Logger()
	if err != nil {
		return err
	}
	if logger == nil {
		logger = slog.Default()
	}
	logger = logger.With("channel", "x")
	now := opts.now
	if now == nil {
		now = time.Now
	}
	status := &statusTracker{onChange: opts.OnStatusChange, logger: logger}
	status.set(StatusConnecting)
	me, err := whoAmI(ctx, client, status, logger)
	if err != nil {
		return err
	}
	lock, err := runtimelock.Acquire(d.RuntimePaths.StateDir, "x-"+me.ID, firstNonEmpty(opts.RuntimeLabel, "morph x"))
	if err != nil {
		return err
	}
	defer lock.Release()
	state := newState(filepath.Join(d.RuntimePaths.StateDir, "x", "state.json"))
	resolve := func(ids []string) []string { return resolveUsers(ctx, client, ids, logger) }

	if opts.TaskStore == nil {
		store, err := daemonruntime.NewTaskViewForTarget("x", opts.ServerMaxQueue, daemonruntime.TaskViewConfig{
			PersistenceTargets: d.TaskPersistenceTargets, TasksDir: d.RuntimePaths.TasksDir,
			JournalDir: d.RuntimePaths.JournalDir, RotateMaxBytes: d.TaskRotateMaxBytes,
		})
		if err != nil {
			return err
		}
		opts.TaskStore = store
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	if opts.DMEnabled {
		transport := &dmTransport{
			client: client, me: me, logger: logger.With("mode", "dm"), now: now, status: status, state: state,
			poll:    durationOr(opts.DMPollInterval, defaultDMPoll),
			allowed: toSet(resolve(opts.DMAllowedUserIDs)), owners: resolve(opts.Owners),
		}
		engineOpts := opts.Options
		engineOpts.Channel = busruntime.ChannelX
		engineOpts.Transport = transport
		engineOpts.PromptBlocks = func(spec *agent.PromptSpec) { promptprofile.AppendXRuntimeBlocks(spec) }
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- accountdm.Run(runCtx, d, engineOpts)
		}()
	}
	if opts.MentionsEnabled {
		source := &postSource{
			client: client, me: me, logger: logger.With("mode", "mentions"), now: now, status: status, state: state,
			poll: durationOr(opts.MentionsPollInterval, defaultPostPoll), allowLinks: opts.AllowLinksInPosts,
		}
		maxPosts := max(opts.MaxReplyPosts, 1)
		postOpts := socialpost.Options{
			Channel: "x", Source: source,
			AllowedUserIDs: resolve(opts.MentionsAllowedUserIDs), BlockedUserIDs: resolve(opts.MentionsBlockedUserIDs),
			ThreadContextDepth: opts.ThreadContextDepth, MaxReplyPosts: maxPosts, MaxPostsPerDay: opts.MaxPostsPerDay,
			PromptBlocks: func(spec *agent.PromptSpec) {
				promptprofile.AppendSocialPostRuntimeBlocks(spec, promptprofile.SocialPostPolicy{
					Platform: "X", PostLimit: "280 characters (CJK characters count double)", MaxPosts: maxPosts, AllowLinks: opts.AllowLinksInPosts,
				})
			},
			TaskTimeout: opts.TaskTimeout, MaxConcurrency: opts.MaxConcurrency, AgentLimits: opts.AgentLimits,
			EngineToolsConfig: opts.EngineToolsConfig, InspectPrompt: opts.InspectPrompt, InspectRequest: opts.InspectRequest,
			FileCacheDir: opts.FileCacheDir, TaskStore: opts.TaskStore, ServerMaxQueue: opts.ServerMaxQueue,
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- socialpost.Run(runCtx, d.CommonDependencies, postOpts)
		}()
	}
	go func() {
		wg.Wait()
		close(errCh)
	}()
	var firstErr error
	for err := range errCh {
		if err != nil && !errors.Is(err, context.Canceled) && firstErr == nil {
			firstErr = err
		}
		cancel()
	}
	return firstErr
}

// whoAmI reads the authorized account, retrying a network failure; a refused token ends the run.
func whoAmI(ctx context.Context, client *xapi.Client, status *statusTracker, logger *slog.Logger) (xapi.User, error) {
	backoff := time.Second
	for {
		me, err := client.Me(ctx)
		if err == nil && me.ID != "" {
			status.set(StatusOnline)
			logger.Info("account_ready", "user_id", me.ID, "username", me.Username)
			return me, nil
		}
		if ctx.Err() != nil {
			return xapi.User{}, ctx.Err()
		}
		switch {
		case xapi.IsUnauthorized(err):
			status.set(StatusReauth)
			return xapi.User{}, fmt.Errorf("x: the login was refused; log in again (`morph x login`, or Console > Settings > Channels > X): %w", err)
		case xapi.IsOutOfCredits(err):
			status.set(StatusNoCredits)
			return xapi.User{}, fmt.Errorf("x: the account has no API credits left: %w", err)
		}
		status.set(StatusDisconnected)
		logger.Warn("account_lookup_failed", "retry_in", backoff.String(), "error", fmt.Sprint(err))
		if err := sleep(ctx, backoff); err != nil {
			return xapi.User{}, err
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// resolveUsers turns @usernames into user IDs; numeric IDs pass as they are.
func resolveUsers(ctx context.Context, client *xapi.Client, ids []string, logger *slog.Logger) []string {
	var out []string
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if isNumeric(id) {
			out = append(out, id)
			continue
		}
		user, err := client.UserByUsername(ctx, id)
		if err != nil || user.ID == "" {
			logger.Warn("username_unresolved", "username", id, "error", fmt.Sprint(err))
			continue
		}
		out = append(out, user.ID)
	}
	return out
}

func isNumeric(value string) bool {
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return value != ""
}

type statusTracker struct {
	value    atomic.Value
	onChange func(string)
	logger   *slog.Logger
}

func (s *statusTracker) set(status string) {
	if previous, _ := s.value.Swap(status).(string); previous != status {
		s.logger.Info("connection_status", "status", status)
		if s.onChange != nil {
			s.onChange(status)
		}
	}
}

func (s *statusTracker) get() string {
	status, _ := s.value.Load().(string)
	return status
}

// noteError records what an API error says about the connection, and returns how long to wait
// before trying again: a refused token or spent credits wait the longest.
func (s *statusTracker) noteError(err error, base time.Duration, backoff *time.Duration) time.Duration {
	switch {
	case err == nil:
		s.set(StatusOnline)
		*backoff = base
		return base
	case xapi.IsUnauthorized(err):
		s.set(StatusReauth)
		return maxBackoff
	case xapi.IsOutOfCredits(err):
		s.set(StatusNoCredits)
		return maxBackoff
	}
	s.set(StatusDisconnected)
	wait := *backoff
	*backoff = min(*backoff*2, maxBackoff)
	return wait
}

// state is what the runtime keeps in file_state_dir/x/state.json: where the mention and message
// polls stopped, and who wrote first (X lets an automated account message only those).
type state struct {
	mu   sync.Mutex
	path string
	data stateFile
}

type stateFile struct {
	MentionsSinceID string          `json:"mentions_since_id,omitempty"`
	LastDMEventID   string          `json:"last_dm_event_id,omitempty"`
	DMPeers         map[string]bool `json:"dm_peers,omitempty"`
}

func newState(path string) *state {
	s := &state{path: path}
	_, _ = fsstore.ReadJSON(path, &s.data)
	if s.data.DMPeers == nil {
		s.data.DMPeers = map[string]bool{}
	}
	return s
}

func (s *state) update(fn func(*stateFile)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.data)
	_ = fsstore.WriteJSONAtomic(s.path, s.data, fsstore.FileOptions{DirPerm: 0o700, FilePerm: 0o600})
}

func (s *state) read() stateFile {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.data
	out.DMPeers = make(map[string]bool, len(s.data.DMPeers))
	for id := range s.data.DMPeers {
		out.DMPeers[id] = true
	}
	return out
}

// dmTransport is the accountdm transport for direct messages.
type dmTransport struct {
	client  *xapi.Client
	me      xapi.User
	logger  *slog.Logger
	now     func() time.Time
	status  *statusTracker
	state   *state
	poll    time.Duration
	allowed map[string]bool
	owners  []string
}

func (t *dmTransport) AccountID() string { return t.me.ID }

func (t *dmTransport) Owners() []string { return append([]string(nil), t.owners...) }

func (t *dmTransport) MaxTextLength() int { return xapi.MaxDMLength }

func (t *dmTransport) MaxFileBytes() int64 { return 0 }

func (t *dmTransport) Typing(context.Context, string, string) func() { return func() {} }

func (t *dmTransport) SendFile(context.Context, string, string, accountdm.OutboundFile) error {
	return fmt.Errorf("x direct messages from Morph cannot carry files")
}

func (t *dmTransport) Overview() map[string]any {
	status := t.status.get()
	connected := status == StatusOnline
	return map[string]any{
		"configured": true, "running": "x", "connected": connected, "status": status, "account": "@" + t.me.Username,
		"x_configured": true, "x_running": true, "x_connected": connected, "x_status": status,
		"x_usage": t.client.Usage(),
	}
}

// Run polls the latest messages, delivering those from others that are newer than the last poll
// (or, on the first poll, at most a day old).
func (t *dmTransport) Run(ctx context.Context, deliver func(context.Context, accountdm.Inbound) error) error {
	startedAt := t.now()
	backoff := t.poll
	for {
		err := t.pollOnce(ctx, startedAt, deliver)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		wait := t.status.noteError(err, t.poll, &backoff)
		if err != nil {
			t.logger.Warn("poll_failed", "retry_in", wait.String(), "error", err.Error())
		}
		if err := sleep(ctx, wait); err != nil {
			return err
		}
	}
}

func (t *dmTransport) pollOnce(ctx context.Context, startedAt time.Time, deliver func(context.Context, accountdm.Inbound) error) error {
	events, includes, err := t.client.DMEvents(ctx, dmPageSize)
	if err != nil {
		return err
	}
	last := t.state.read().LastDMEventID
	var fresh []xapi.DMEvent
	for _, event := range events {
		if last != "" && compareIDs(event.ID, last) <= 0 {
			break
		}
		fresh = append(fresh, event)
	}
	if len(events) > 0 {
		newest := events[0].ID
		t.state.update(func(s *stateFile) {
			if compareIDs(newest, s.LastDMEventID) > 0 {
				s.LastDMEventID = newest
			}
		})
	}
	sort.SliceStable(fresh, func(i, j int) bool { return compareIDs(fresh[i].ID, fresh[j].ID) < 0 })
	for _, event := range fresh {
		if event.EventType != "MessageCreate" || event.SenderID == "" || event.SenderID == t.me.ID {
			continue
		}
		if sentAt := event.Time(); !sentAt.IsZero() && startedAt.Sub(sentAt) > replayWindow {
			continue
		}
		t.state.update(func(s *stateFile) { s.DMPeers[event.SenderID] = true })
		if len(t.allowed) > 0 && !t.allowed[event.SenderID] {
			t.logger.Debug("dm_not_allowed", "sender_id", event.SenderID)
			continue
		}
		name := ""
		if user, ok := includes.User(event.SenderID); ok {
			name = firstNonEmpty(user.Name, user.Username)
		}
		in := accountdm.Inbound{
			AccountID: t.me.ID, PeerID: event.SenderID, MessageID: event.ID, SentAt: event.Time(),
			DisplayName: name, Text: event.Text,
		}
		if strings.TrimSpace(in.Text) == "" {
			in.Unsupported = true
		}
		if err := deliver(ctx, in); err != nil {
			t.logger.Warn("deliver_failed", "event_id", event.ID, "error", err.Error())
		}
	}
	return nil
}

// SendText sends a direct message. X lets an automated account message only people who wrote to
// it first, so a message to anyone else is refused here.
func (t *dmTransport) SendText(ctx context.Context, _ string, peerID, text, _ string) error {
	if !t.state.read().DMPeers[peerID] {
		return fmt.Errorf("x: user %s has not sent this account a direct message, and X lets automated accounts message only people who wrote first", peerID)
	}
	err := t.client.SendDM(ctx, peerID, text)
	if xapi.IsUnauthorized(err) {
		t.status.set(StatusReauth)
	} else if xapi.IsOutOfCredits(err) {
		t.status.set(StatusNoCredits)
	}
	return err
}

// postSource polls the account's mentions.
type postSource struct {
	client     *xapi.Client
	me         xapi.User
	logger     *slog.Logger
	now        func() time.Time
	status     *statusTracker
	state      *state
	poll       time.Duration
	allowLinks bool
}

func (s *postSource) SelfID() string { return s.me.ID }

func (s *postSource) Run(ctx context.Context, deliver func(context.Context, socialpost.Post) error) error {
	backoff := s.poll
	for {
		err := s.pollOnce(ctx, deliver)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		wait := s.status.noteError(err, s.poll, &backoff)
		if err != nil {
			s.logger.Warn("poll_failed", "retry_in", wait.String(), "error", err.Error())
		}
		if err := sleep(ctx, wait); err != nil {
			return err
		}
	}
}

// pollOnce reads mentions since the last poll. The first poll ever only records where to start:
// mentions made before the channel ran are not answered.
func (s *postSource) pollOnce(ctx context.Context, deliver func(context.Context, socialpost.Post) error) error {
	since := s.state.read().MentionsSinceID
	posts, includes, newest, err := s.client.Mentions(ctx, s.me.ID, since, mentionPageSize)
	if err != nil {
		return err
	}
	if newest != "" {
		s.state.update(func(f *stateFile) {
			if compareIDs(newest, f.MentionsSinceID) > 0 {
				f.MentionsSinceID = newest
			}
		})
	}
	if since == "" {
		s.logger.Info("mentions_baseline", "since_id", newest)
		return nil
	}
	sort.SliceStable(posts, func(i, j int) bool { return compareIDs(posts[i].ID, posts[j].ID) < 0 })
	for _, post := range posts {
		if err := deliver(ctx, s.toPost(post, includes)); err != nil {
			s.logger.Warn("deliver_failed", "post_id", post.ID, "error", err.Error())
		}
	}
	return nil
}

func (s *postSource) toPost(post xapi.Post, includes xapi.Includes) socialpost.Post {
	author, _ := includes.User(post.AuthorID)
	out := socialpost.Post{
		ID: post.ID, ThreadID: firstNonEmpty(post.ConversationID, post.ID),
		AuthorID: post.AuthorID, AuthorHandle: author.Username, AuthorName: author.Name,
		Text: post.Text, CreatedAt: post.Time(),
	}
	for _, media := range includes.MediaFor(post) {
		if media.Type != "photo" || media.URL == "" {
			continue
		}
		mediaURL := media.URL
		out.Images = append(out.Images, socialpost.Image{Fetch: func(ctx context.Context) ([]byte, string, error) {
			return s.client.DownloadImage(ctx, mediaURL, maxImageBytes)
		}})
	}
	return out
}

// Thread follows the reply chain up from post, one lookup per post, since each is billed.
func (s *postSource) Thread(ctx context.Context, post socialpost.Post, depth int) ([]socialpost.Post, error) {
	if depth <= 0 {
		return nil, nil
	}
	posts, _, err := s.client.Posts(ctx, []string{post.ID})
	if err != nil || len(posts) == 0 {
		return nil, err
	}
	var chain []socialpost.Post
	parentID := posts[0].RepliedTo()
	for parentID != "" && len(chain) < depth {
		parents, includes, err := s.client.Posts(ctx, []string{parentID})
		if err != nil || len(parents) == 0 {
			break
		}
		parent := s.toPost(parents[0], includes)
		parent.ThreadID = post.ThreadID
		parent.Images = nil
		chain = append(chain, parent)
		parentID = parents[0].RepliedTo()
	}
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	return chain, nil
}

// Reply posts parts as a chain: the first under the mention, each next under the previous one.
func (s *postSource) Reply(ctx context.Context, post socialpost.Post, parts []string) error {
	parent := post.ID
	for _, part := range parts {
		id, err := s.client.Reply(ctx, parent, part)
		if err != nil {
			if xapi.IsOutOfCredits(err) {
				s.status.set(StatusNoCredits)
			}
			return err
		}
		parent = id
	}
	return nil
}

// Split cuts text into posts; without links allowed, URLs are taken out first, since a post with a
// link costs far more.
func (s *postSource) Split(text string, maxPosts int) []string {
	if !s.allowLinks {
		text = xapi.StripLinks(text)
	}
	return xapi.SplitPosts(text, maxPosts)
}

// compareIDs orders X's numeric IDs (snowflakes), which are longer as they are newer.
func compareIDs(a, b string) int {
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

func durationOr(value, fallback time.Duration) time.Duration {
	if value <= 0 {
		return fallback
	}
	return value
}

func toSet(ids []string) map[string]bool {
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
