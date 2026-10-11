// Package bluesky runs Morph as a Bluesky account: direct messages through the shared accountdm
// engine, and public mentions through socialpost. See
// docs/feat/feat_20261011_x_bluesky_channels.md.
package bluesky

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
	"github.com/quailyquaily/mistermorph/internal/blueskyapi"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/accountdm"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/socialpost"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/internal/runtimelock"
	"github.com/quailyquaily/mistermorph/internal/textsplit"
)

// Connection states shown in the overview.
const (
	StatusConnecting   = "connecting"
	StatusOnline       = "online"
	StatusDisconnected = "disconnected"
	StatusReauth       = "reauth_needed"
)

const (
	maxBackoff = 5 * time.Minute
	// replayWindow is how old an unread message or mention may be and still be answered after a
	// start; older ones are only marked read.
	replayWindow    = 24 * time.Hour
	maxImageBytes   = int64(5 << 20)
	defaultDMPoll   = 10 * time.Second
	defaultPostPoll = 30 * time.Second
)

// RunOptions configure the Bluesky runtime.
type RunOptions struct {
	accountdm.Options
	ServiceURL  string
	Identifier  string
	AppPassword string

	DMEnabled        bool
	DMPollInterval   time.Duration
	DMAllowedUserIDs []string
	// Owners get heartbeat notifications: handles or DIDs.
	Owners []string

	MentionsEnabled        bool
	MentionsPollInterval   time.Duration
	MentionsAllowedUserIDs []string
	MentionsBlockedUserIDs []string
	ThreadContextDepth     int
	MaxReplyPosts          int

	// OnStatusChange, if set, hears each connection status change.
	OnStatusChange func(status string)
	// RuntimeLabel names this process in the poller lock ("morph bluesky", "console").
	RuntimeLabel string

	client *blueskyapi.Client
	now    func() time.Time
}

// Run serves the account until ctx ends. Only one process may serve an account at a time.
func Run(ctx context.Context, d accountdm.Dependencies, opts RunOptions) error {
	if !opts.DMEnabled && !opts.MentionsEnabled {
		return fmt.Errorf("bluesky: both bluesky.dm.enabled and bluesky.mentions.enabled are off")
	}
	identifier := strings.TrimPrefix(strings.TrimSpace(opts.Identifier), "@")
	client := opts.client
	if client == nil {
		if identifier == "" || strings.TrimSpace(opts.AppPassword) == "" {
			return fmt.Errorf("missing bluesky.identifier or bluesky.app_password: create an app password with direct-message access (Settings > Privacy and security > App passwords), or set MISTER_MORPH_BLUESKY_APP_PASSWORD")
		}
		var err error
		client, err = blueskyapi.NewClient(blueskyapi.Options{
			ServiceURL: opts.ServiceURL, Identifier: identifier, AppPassword: opts.AppPassword,
			Store: sessionStore{path: filepath.Join(pathutil.ResolveStateDir(d.RuntimePaths.StateDir), "auth", "bluesky.json")},
		})
		if err != nil {
			return err
		}
	}
	lock, err := runtimelock.Acquire(d.RuntimePaths.StateDir, "bluesky-"+safeLockName(identifier), firstNonEmpty(opts.RuntimeLabel, "morph bluesky"))
	if err != nil {
		return err
	}
	defer lock.Release()
	logger, err := d.Logger()
	if err != nil {
		return err
	}
	if logger == nil {
		logger = slog.Default()
	}
	logger = logger.With("channel", "bluesky")
	now := opts.now
	if now == nil {
		now = time.Now
	}
	status := &statusTracker{onChange: opts.OnStatusChange, logger: logger}
	status.set(StatusConnecting)
	if err := connect(ctx, client, status, logger); err != nil {
		return err
	}
	resolve := func(ids []string) []string { return resolveUsers(ctx, client, ids, logger) }

	if opts.TaskStore == nil {
		store, err := daemonruntime.NewTaskViewForTarget("bluesky", opts.ServerMaxQueue, daemonruntime.TaskViewConfig{
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
			client: client, logger: logger.With("mode", "dm"), now: now, status: status,
			poll:    durationOr(opts.DMPollInterval, defaultDMPoll),
			allowed: toSet(resolve(opts.DMAllowedUserIDs)), owners: resolve(opts.Owners),
			convos: map[string]string{},
		}
		engineOpts := opts.Options
		engineOpts.Channel = busruntime.ChannelBluesky
		engineOpts.Transport = transport
		engineOpts.PromptBlocks = func(spec *agent.PromptSpec) { promptprofile.AppendBlueskyRuntimeBlocks(spec) }
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- accountdm.Run(runCtx, d, engineOpts)
		}()
	}
	if opts.MentionsEnabled {
		source := &postSource{
			client: client, logger: logger.With("mode", "mentions"), now: now, status: status,
			poll: durationOr(opts.MentionsPollInterval, defaultPostPoll),
		}
		maxPosts := max(opts.MaxReplyPosts, 1)
		postOpts := socialpost.Options{
			Channel: "bluesky", Source: source,
			AllowedUserIDs: resolve(opts.MentionsAllowedUserIDs), BlockedUserIDs: resolve(opts.MentionsBlockedUserIDs),
			ThreadContextDepth: opts.ThreadContextDepth, MaxReplyPosts: maxPosts,
			PromptBlocks: func(spec *agent.PromptSpec) {
				promptprofile.AppendSocialPostRuntimeBlocks(spec, promptprofile.SocialPostPolicy{
					Platform: "Bluesky", PostLimit: "300 characters", MaxPosts: maxPosts, AllowLinks: true,
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
	var firstErr error
	go func() {
		wg.Wait()
		close(errCh)
	}()
	for err := range errCh {
		if err != nil && !errors.Is(err, context.Canceled) && firstErr == nil {
			firstErr = err
		}
		cancel()
	}
	return firstErr
}

// connect logs in, retrying a network failure with backoff. Refused credentials end the run.
func connect(ctx context.Context, client *blueskyapi.Client, status *statusTracker, logger *slog.Logger) error {
	backoff := time.Second
	for {
		err := client.Connect(ctx)
		if err == nil {
			status.set(StatusOnline)
			logger.Info("session_ready", "did", client.DID(), "handle", client.Handle())
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if blueskyapi.IsUnauthorized(err) {
			status.set(StatusReauth)
			return fmt.Errorf("bluesky: the identifier or app password was refused: %w", err)
		}
		status.set(StatusDisconnected)
		logger.Warn("login_failed", "retry_in", backoff.String(), "error", err.Error())
		if err := sleep(ctx, backoff); err != nil {
			return err
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// resolveUsers turns handles and DIDs into peer IDs (DIDs without colons); a handle that does not
// resolve is dropped with a warning.
func resolveUsers(ctx context.Context, client *blueskyapi.Client, ids []string, logger *slog.Logger) []string {
	var out []string
	for _, raw := range ids {
		id := strings.TrimPrefix(strings.TrimSpace(raw), "@")
		if id == "" {
			continue
		}
		if blueskyapi.IsDID(id) {
			out = append(out, blueskyapi.PeerID(blueskyapi.DIDFromPeer(id)))
			continue
		}
		did, err := client.ResolveHandle(ctx, id)
		if err != nil || did == "" {
			logger.Warn("handle_unresolved", "handle", id, "error", fmt.Sprint(err))
			continue
		}
		out = append(out, blueskyapi.PeerID(did))
	}
	return out
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

// noteError records what an API error says about the connection.
func (s *statusTracker) noteError(err error) {
	switch {
	case err == nil:
		s.set(StatusOnline)
	case blueskyapi.IsUnauthorized(err):
		s.set(StatusReauth)
	default:
		s.set(StatusDisconnected)
	}
}

// sessionStore keeps the session in file_state_dir/auth/bluesky.json, beside the other logins.
type sessionStore struct{ path string }

func (s sessionStore) Load() (blueskyapi.Session, bool) {
	var session blueskyapi.Session
	ok, err := fsstore.ReadJSON(s.path, &session)
	return session, ok && err == nil
}

func (s sessionStore) Save(session blueskyapi.Session) error {
	return fsstore.WriteJSONAtomic(s.path, session, fsstore.FileOptions{DirPerm: 0o700, FilePerm: 0o600})
}

// dmTransport is the accountdm transport for direct messages.
type dmTransport struct {
	client  *blueskyapi.Client
	logger  *slog.Logger
	now     func() time.Time
	status  *statusTracker
	poll    time.Duration
	allowed map[string]bool
	owners  []string

	mu     sync.Mutex
	convos map[string]string // peer -> convo ID
}

func (t *dmTransport) AccountID() string { return blueskyapi.PeerID(t.client.DID()) }

func (t *dmTransport) Owners() []string { return append([]string(nil), t.owners...) }

func (t *dmTransport) MaxTextLength() int { return blueskyapi.MaxMessageGraphemes }

func (t *dmTransport) MaxFileBytes() int64 { return 0 }

func (t *dmTransport) Typing(context.Context, string, string) func() { return func() {} }

func (t *dmTransport) SendFile(context.Context, string, string, accountdm.OutboundFile) error {
	return fmt.Errorf("bluesky direct messages cannot carry files")
}

func (t *dmTransport) Overview() map[string]any {
	status := t.status.get()
	connected := status == StatusOnline
	return map[string]any{
		"configured": true, "running": "bluesky", "connected": connected, "status": status, "account": t.client.Handle(),
		"bluesky_configured": true, "bluesky_running": true, "bluesky_connected": connected, "bluesky_status": status,
	}
}

// Run polls unread conversations and requests, delivering each message from the other member that
// is new since the start (or at most a day old), then marks the conversation read.
func (t *dmTransport) Run(ctx context.Context, deliver func(context.Context, accountdm.Inbound) error) error {
	startedAt := t.now()
	backoff := t.poll
	for {
		err := t.pollOnce(ctx, startedAt, deliver)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		t.status.noteError(err)
		wait := t.poll
		if err != nil {
			if blueskyapi.IsMissingScope(err) {
				t.logger.Error("dm_access_refused", "hint", "create the app password with \"Allow access to your direct messages\" ticked", "error", err.Error())
			} else {
				t.logger.Warn("poll_failed", "retry_in", backoff.String(), "error", err.Error())
			}
			wait = backoff
			backoff = min(backoff*2, maxBackoff)
		} else {
			backoff = t.poll
		}
		if err := sleep(ctx, wait); err != nil {
			return err
		}
	}
}

func (t *dmTransport) pollOnce(ctx context.Context, startedAt time.Time, deliver func(context.Context, accountdm.Inbound) error) error {
	self := t.client.DID()
	convos, _, err := t.client.ListConvos(ctx, "", true)
	if err != nil {
		return err
	}
	requests, _, err := t.client.ListConvoRequests(ctx, "")
	if err != nil {
		return err
	}
	for _, convo := range append(convos, requests...) {
		if convo.IsGroup() || convo.ID == "" {
			continue
		}
		other, ok := convo.Other(self)
		if !ok {
			continue
		}
		peer := blueskyapi.PeerID(other.DID)
		t.mu.Lock()
		t.convos[peer] = convo.ID
		t.mu.Unlock()
		if !t.admits(peer, other) {
			continue
		}
		if convo.Status == "request" {
			if err := t.client.AcceptConvo(ctx, convo.ID); err != nil {
				t.logger.Warn("accept_failed", "convo_id", convo.ID, "error", err.Error())
				continue
			}
		} else if convo.UnreadCount == 0 {
			continue
		}
		if err := t.deliverConvo(ctx, convo, other, startedAt, deliver); err != nil {
			return err
		}
	}
	return nil
}

func (t *dmTransport) admits(peer string, profile blueskyapi.ProfileBasic) bool {
	if len(t.allowed) > 0 && !t.allowed[peer] {
		t.logger.Debug("dm_not_allowed", "peer", peer)
		return false
	}
	if profile.IsBot() && !t.allowed[peer] {
		// An unlisted bot is not answered, so two agents never talk to each other in a loop.
		t.logger.Debug("dm_from_bot_skipped", "peer", peer)
		return false
	}
	return true
}

func (t *dmTransport) deliverConvo(ctx context.Context, convo blueskyapi.Convo, other blueskyapi.ProfileBasic, startedAt time.Time, deliver func(context.Context, accountdm.Inbound) error) error {
	messages, err := t.client.GetMessages(ctx, convo.ID, min(max(convo.UnreadCount, 1)+5, 50))
	if err != nil {
		return err
	}
	sort.SliceStable(messages, func(i, j int) bool { return messages[i].Rev < messages[j].Rev })
	account := t.AccountID()
	peer := blueskyapi.PeerID(other.DID)
	last := ""
	for _, msg := range messages {
		if !msg.IsText() || msg.Sender.DID != other.DID {
			continue
		}
		last = msg.ID
		if sentAt := msg.Time(); !sentAt.IsZero() && startedAt.Sub(sentAt) > replayWindow {
			continue
		}
		replyTo := ""
		if msg.ReplyTo != nil {
			replyTo = msg.ReplyTo.MessageID
		}
		in := accountdm.Inbound{
			AccountID: account, PeerID: peer, MessageID: msg.ID, SentAt: msg.Time(),
			DisplayName: other.Name(), Text: msg.Text, ReplyToMessageID: replyTo,
		}
		if strings.TrimSpace(in.Text) == "" {
			in.Unsupported = true
		}
		if err := deliver(ctx, in); err != nil {
			t.logger.Warn("deliver_failed", "message_id", msg.ID, "error", err.Error())
		}
	}
	if last != "" {
		if err := t.client.UpdateRead(ctx, convo.ID, last); err != nil {
			t.logger.Warn("mark_read_failed", "convo_id", convo.ID, "error", err.Error())
		}
	}
	return nil
}

// SendText sends a message to the peer's conversation, opening it when needed.
func (t *dmTransport) SendText(ctx context.Context, _ string, peerID, text, replyTo string) error {
	convoID, err := t.convoFor(ctx, peerID)
	if err != nil {
		return err
	}
	_, err = t.client.SendMessage(ctx, convoID, text, t.client.Facets(ctx, text), replyTo)
	if err != nil && replyTo != "" {
		// A quote of a message that is gone; send it plainly.
		_, err = t.client.SendMessage(ctx, convoID, text, t.client.Facets(ctx, text), "")
	}
	if blueskyapi.IsUnauthorized(err) {
		t.status.set(StatusReauth)
	}
	return err
}

func (t *dmTransport) convoFor(ctx context.Context, peerID string) (string, error) {
	t.mu.Lock()
	convoID := t.convos[peerID]
	t.mu.Unlock()
	if convoID != "" {
		return convoID, nil
	}
	convo, err := t.client.GetConvoForMembers(ctx, blueskyapi.DIDFromPeer(peerID))
	if err != nil {
		return "", fmt.Errorf("open bluesky conversation with %s: %w", blueskyapi.DIDFromPeer(peerID), err)
	}
	t.mu.Lock()
	t.convos[peerID] = convo.ID
	t.mu.Unlock()
	return convo.ID, nil
}

// postRef is what a reply to a post needs.
type postRef struct {
	Post blueskyapi.StrongRef
	Root blueskyapi.StrongRef
}

// postSource polls the account's mentions, replies and quotes.
type postSource struct {
	client *blueskyapi.Client
	logger *slog.Logger
	now    func() time.Time
	status *statusTracker
	poll   time.Duration
}

func (s *postSource) SelfID() string { return blueskyapi.PeerID(s.client.DID()) }

func (s *postSource) Run(ctx context.Context, deliver func(context.Context, socialpost.Post) error) error {
	startedAt := s.now()
	backoff := s.poll
	for {
		err := s.pollOnce(ctx, startedAt, deliver)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.status.noteError(err)
		wait := s.poll
		if err != nil {
			s.logger.Warn("poll_failed", "retry_in", backoff.String(), "error", err.Error())
			wait = backoff
			backoff = min(backoff*2, maxBackoff)
		} else {
			backoff = s.poll
		}
		if err := sleep(ctx, wait); err != nil {
			return err
		}
	}
}

func (s *postSource) pollOnce(ctx context.Context, startedAt time.Time, deliver func(context.Context, socialpost.Post) error) error {
	notifications, _, err := s.client.ListNotifications(ctx, []string{"mention", "reply", "quote"}, 50, "")
	if err != nil {
		return err
	}
	var latest time.Time
	var fresh []blueskyapi.Notification
	for _, n := range notifications {
		indexed, _ := time.Parse(time.RFC3339Nano, n.IndexedAt)
		if indexed.After(latest) {
			latest = indexed
		}
		if n.IsRead || startedAt.Sub(n.Time()) > replayWindow {
			continue
		}
		fresh = append(fresh, n)
	}
	// Oldest first, so a thread's posts are answered in order.
	sort.SliceStable(fresh, func(i, j int) bool { return fresh[i].Time().Before(fresh[j].Time()) })
	for _, n := range fresh {
		post, ok := s.toPost(n)
		if !ok {
			continue
		}
		if err := deliver(ctx, post); err != nil {
			s.logger.Warn("deliver_failed", "post_uri", n.URI, "error", err.Error())
		}
	}
	if !latest.IsZero() {
		if err := s.client.UpdateSeen(ctx, latest); err != nil {
			s.logger.Warn("update_seen_failed", "error", err.Error())
		}
	}
	return nil
}

func (s *postSource) toPost(n blueskyapi.Notification) (socialpost.Post, bool) {
	record, ok := n.Post()
	if !ok || n.URI == "" || n.CID == "" {
		return socialpost.Post{}, false
	}
	self := blueskyapi.StrongRef{URI: n.URI, CID: n.CID}
	root := self
	if record.Reply != nil && record.Reply.Root.URI != "" {
		root = record.Reply.Root
	}
	post := socialpost.Post{
		ID: n.URI, ThreadID: root.URI,
		AuthorID: blueskyapi.PeerID(n.Author.DID), AuthorHandle: n.Author.Handle, AuthorName: n.Author.DisplayName,
		AuthorIsBot: n.Author.IsBot(), Text: record.Text, CreatedAt: n.Time(),
		Ref: postRef{Post: self, Root: root},
	}
	if hasImages(n.Record) {
		uri := n.URI
		post.Images = []socialpost.Image{{Fetch: func(ctx context.Context) ([]byte, string, error) {
			return s.firstImage(ctx, uri)
		}}}
	}
	return post, true
}

// firstImage downloads the first image of the post at uri.
func (s *postSource) firstImage(ctx context.Context, uri string) ([]byte, string, error) {
	chain, err := s.client.GetThread(ctx, uri, 0)
	if err != nil {
		return nil, "", err
	}
	post := chain[len(chain)-1]
	if len(post.Images) == 0 {
		return nil, "", fmt.Errorf("the post has no image")
	}
	return s.client.DownloadImage(ctx, post.Images[0].Fullsize, maxImageBytes)
}

func hasImages(record []byte) bool {
	return strings.Contains(string(record), "app.bsky.embed.images")
}

func (s *postSource) Thread(ctx context.Context, post socialpost.Post, depth int) ([]socialpost.Post, error) {
	if depth <= 0 {
		return nil, nil
	}
	chain, err := s.client.GetThread(ctx, post.ID, depth)
	if err != nil {
		return nil, err
	}
	out := make([]socialpost.Post, 0, len(chain))
	for _, item := range chain[:len(chain)-1] {
		out = append(out, socialpost.Post{
			ID: item.URI, ThreadID: post.ThreadID,
			AuthorID: blueskyapi.PeerID(item.Author.DID), AuthorHandle: item.Author.Handle, AuthorName: item.Author.DisplayName,
			AuthorIsBot: item.Author.IsBot(), Text: item.Text, CreatedAt: item.CreatedAt,
		})
	}
	return out, nil
}

// Reply posts parts as a chain: the first under the mention, each next under the previous one.
func (s *postSource) Reply(ctx context.Context, post socialpost.Post, parts []string) error {
	ref, ok := post.Ref.(postRef)
	if !ok {
		return fmt.Errorf("bluesky: post %s cannot be replied to", post.ID)
	}
	parent := ref.Post
	for _, part := range parts {
		created, err := s.client.CreatePost(ctx, part, s.client.Facets(ctx, part), &blueskyapi.ReplyRef{Root: ref.Root, Parent: parent})
		if err != nil {
			s.status.noteError(err)
			return err
		}
		parent = created
	}
	return nil
}

// Split cuts text into posts of at most 300 characters, at most maxPosts of them; the last is cut
// with an ellipsis when the text is longer.
func (s *postSource) Split(text string, maxPosts int) []string {
	return splitPosts(text, blueskyapi.MaxPostGraphemes, maxPosts)
}

func splitPosts(text string, limit, maxPosts int) []string {
	parts := textsplit.Split(text, limit)
	if len(parts) <= maxPosts {
		return parts
	}
	parts = parts[:maxPosts]
	last := []rune(strings.TrimSpace(parts[maxPosts-1]))
	if len(last) > limit-1 {
		last = last[:limit-1]
	}
	parts[maxPosts-1] = string(last) + "…"
	return parts
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

func safeLockName(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(value) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
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
