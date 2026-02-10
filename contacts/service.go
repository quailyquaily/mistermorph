package contacts

import (
	"context"
	"encoding/base64"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/internal/idempotency"
)

const (
	defaultFailureCooldown = 72 * time.Hour
)

type Sender interface {
	Send(ctx context.Context, contact Contact, decision ShareDecision) (accepted bool, deduped bool, err error)
}

type ServiceOptions struct {
	FailureCooldown time.Duration
}

type EnsureStore interface {
	Ensure(ctx context.Context) error
}

type ContactStore interface {
	GetContact(ctx context.Context, contactID string) (Contact, bool, error)
	PutContact(ctx context.Context, contact Contact) error
	ListContacts(ctx context.Context, status Status) ([]Contact, error)
}

type OutboxStore interface {
	GetBusOutboxRecord(ctx context.Context, channel string, idempotencyKey string) (BusOutboxRecord, bool, error)
	PutBusOutboxRecord(ctx context.Context, record BusOutboxRecord) error
}

type ServiceDeps struct {
	Ensure   EnsureStore
	Contacts ContactStore
	Outbox   OutboxStore
}

type Service struct {
	ensureStore     EnsureStore
	contactStore    ContactStore
	outboxStore     OutboxStore
	failureCooldown time.Duration
}

func NewService(store Store) *Service {
	return NewServiceWithOptions(store, ServiceOptions{})
}

func NewServiceWithOptions(store Store, opts ServiceOptions) *Service {
	return NewServiceWithDeps(ServiceDeps{
		Ensure:   store,
		Contacts: store,
		Outbox:   store,
	}, opts)
}

func NewServiceWithDeps(deps ServiceDeps, opts ServiceOptions) *Service {
	opts = normalizeServiceOptions(opts)
	return &Service{
		ensureStore:     deps.Ensure,
		contactStore:    deps.Contacts,
		outboxStore:     deps.Outbox,
		failureCooldown: opts.FailureCooldown,
	}
}

func (s *Service) ready() bool {
	return s != nil &&
		s.ensureStore != nil &&
		s.contactStore != nil &&
		s.outboxStore != nil
}

func normalizeServiceOptions(opts ServiceOptions) ServiceOptions {
	if opts.FailureCooldown <= 0 {
		opts.FailureCooldown = defaultFailureCooldown
	}
	return opts
}

func (s *Service) UpsertContact(ctx context.Context, contact Contact, now time.Time) (Contact, error) {
	if s == nil || !s.ready() {
		return Contact{}, fmt.Errorf("nil contacts service")
	}
	now = normalizeNow(now)
	if err := s.ensureStore.Ensure(ctx); err != nil {
		return Contact{}, err
	}
	contact = normalizeContact(contact, now)
	if strings.TrimSpace(contact.ContactID) == "" {
		contact.ContactID = deriveContactID(contact)
	}
	if strings.TrimSpace(contact.ContactID) == "" {
		return Contact{}, fmt.Errorf("contact_id is required")
	}

	existing, ok, err := s.contactStore.GetContact(ctx, contact.ContactID)
	if err != nil {
		return Contact{}, err
	}
	if ok && !existing.CreatedAt.IsZero() {
		contact.CreatedAt = existing.CreatedAt
	}
	if ok && strings.TrimSpace(contact.ContactNickname) == "" && strings.TrimSpace(existing.ContactNickname) != "" {
		contact.ContactNickname = strings.TrimSpace(existing.ContactNickname)
	}
	if ok && strings.TrimSpace(contact.PersonaBrief) == "" && strings.TrimSpace(existing.PersonaBrief) != "" {
		contact.PersonaBrief = strings.TrimSpace(existing.PersonaBrief)
	}
	if ok && strings.TrimSpace(contact.Pronouns) == "" && strings.TrimSpace(existing.Pronouns) != "" {
		contact.Pronouns = strings.TrimSpace(existing.Pronouns)
	}
	if ok && strings.TrimSpace(contact.Timezone) == "" && strings.TrimSpace(existing.Timezone) != "" {
		contact.Timezone = strings.TrimSpace(existing.Timezone)
	}
	if ok && strings.TrimSpace(contact.PreferenceContext) == "" && strings.TrimSpace(existing.PreferenceContext) != "" {
		contact.PreferenceContext = strings.TrimSpace(existing.PreferenceContext)
	}
	if ok && len(contact.PersonaTraits) == 0 && len(existing.PersonaTraits) > 0 {
		contact.PersonaTraits = map[string]float64{}
		for k, v := range existing.PersonaTraits {
			contact.PersonaTraits[k] = v
		}
	}
	if err := s.contactStore.PutContact(ctx, contact); err != nil {
		return Contact{}, err
	}
	return contact, nil
}

func (s *Service) ListContacts(ctx context.Context, status Status) ([]Contact, error) {
	if s == nil || !s.ready() {
		return nil, fmt.Errorf("nil contacts service")
	}
	return s.contactStore.ListContacts(ctx, status)
}

func (s *Service) GetContact(ctx context.Context, contactID string) (Contact, bool, error) {
	if s == nil || !s.ready() {
		return Contact{}, false, fmt.Errorf("nil contacts service")
	}
	contactID = strings.TrimSpace(contactID)
	if contactID == "" {
		return Contact{}, false, fmt.Errorf("contact_id is required")
	}
	return s.contactStore.GetContact(ctx, contactID)
}

func (s *Service) SetContactStatus(ctx context.Context, contactID string, status Status) (Contact, error) {
	if s == nil || !s.ready() {
		return Contact{}, fmt.Errorf("nil contacts service")
	}
	contactID = strings.TrimSpace(contactID)
	if contactID == "" {
		return Contact{}, fmt.Errorf("contact_id is required")
	}
	status = normalizeStatus(status)
	if err := s.ensureStore.Ensure(ctx); err != nil {
		return Contact{}, err
	}

	contact, ok, err := s.contactStore.GetContact(ctx, contactID)
	if err != nil {
		return Contact{}, err
	}
	if !ok {
		return Contact{}, fmt.Errorf("contact not found: %s", contactID)
	}
	contact.Status = status
	if err := s.contactStore.PutContact(ctx, contact); err != nil {
		return Contact{}, err
	}
	return contact, nil
}

// SendDecision sends one prepared decision through sender and persists outcome effects
// (cooldown/last_shared/share_count/retain_score).
func (s *Service) SendDecision(ctx context.Context, now time.Time, decision ShareDecision, sender Sender) (ShareOutcome, error) {
	if s == nil || !s.ready() {
		return ShareOutcome{}, fmt.Errorf("nil contacts service")
	}
	if sender == nil {
		return ShareOutcome{}, fmt.Errorf("sender is required")
	}
	now = normalizeNow(now)
	if err := s.ensureStore.Ensure(ctx); err != nil {
		return ShareOutcome{}, err
	}

	decision.ContactID = strings.TrimSpace(decision.ContactID)
	if decision.ContactID == "" {
		return ShareOutcome{}, fmt.Errorf("contact_id is required")
	}
	contact, ok, err := s.contactStore.GetContact(ctx, decision.ContactID)
	if err != nil {
		return ShareOutcome{}, err
	}
	if !ok {
		return ShareOutcome{}, fmt.Errorf("contact not found: %s", decision.ContactID)
	}

	if strings.TrimSpace(decision.PeerID) == "" {
		decision.PeerID = strings.TrimSpace(contact.PeerID)
	}
	decision.Topic = strings.TrimSpace(decision.Topic)
	if decision.Topic == "" {
		decision.Topic = "share.proactive.v1"
	}
	decision.ContentType = strings.TrimSpace(decision.ContentType)
	if decision.ContentType == "" {
		decision.ContentType = "text/plain"
	}
	decision.PayloadBase64 = strings.TrimSpace(decision.PayloadBase64)
	if decision.PayloadBase64 == "" {
		return ShareOutcome{}, fmt.Errorf("payload_base64 is required")
	}
	if _, err := base64.RawURLEncoding.DecodeString(decision.PayloadBase64); err != nil {
		return ShareOutcome{}, fmt.Errorf("payload_base64 decode failed: %w", err)
	}
	decision.ItemID = strings.TrimSpace(decision.ItemID)
	if decision.ItemID == "" {
		decision.ItemID = "manual_" + uuid.NewString()
	}
	decision.IdempotencyKey = strings.TrimSpace(decision.IdempotencyKey)
	if decision.IdempotencyKey == "" {
		decision.IdempotencyKey = idempotency.ManualContactKey(contact.ContactID)
	}

	outcome, attempted, err := s.sendWithBusOutbox(ctx, now, contact, decision, sender)
	if err != nil {
		return ShareOutcome{}, err
	}
	if attempted {
		if outcome.Error != "" {
			cooldown := now.Add(s.failureCooldown)
			contact.CooldownUntil = &cooldown
		} else {
			ts := now
			contact.LastSharedAt = &ts
			contact.LastInteractionAt = &ts
			contact.LastSharedItemID = decision.ItemID
			contact.ShareCount++
		}
		contact = recomputeRetainScore(contact, now)
		if err := s.contactStore.PutContact(ctx, contact); err != nil {
			return ShareOutcome{}, err
		}
	}
	return outcome, nil
}

func resolveDecisionChannel(contact Contact, decision ShareDecision) (string, error) {
	for _, endpoint := range contact.ChannelEndpoints {
		channel, err := normalizeBusChannel(endpoint.Channel)
		if err != nil {
			return "", err
		}
		if channel == ChannelTelegram {
			return channel, nil
		}
	}
	if hasTelegramTarget(contact) {
		return ChannelTelegram, nil
	}
	if strings.TrimSpace(decision.PeerID) != "" || strings.TrimSpace(contact.PeerID) != "" {
		return ChannelMAEP, nil
	}
	return "", fmt.Errorf("unable to resolve delivery channel for contact_id=%s", contact.ContactID)
}

func (s *Service) sendWithBusOutbox(ctx context.Context, now time.Time, contact Contact, decision ShareDecision, sender Sender) (ShareOutcome, bool, error) {
	if s == nil || s.outboxStore == nil {
		return ShareOutcome{}, false, fmt.Errorf("outbox store is required")
	}
	channel, err := resolveDecisionChannel(contact, decision)
	if err != nil {
		return ShareOutcome{}, false, err
	}
	if _, keyErr := busOutboxRecordKey(channel, decision.IdempotencyKey); keyErr != nil {
		return ShareOutcome{}, false, keyErr
	}

	outcome := ShareOutcome{
		ContactID:      decision.ContactID,
		PeerID:         decision.PeerID,
		ItemID:         decision.ItemID,
		IdempotencyKey: decision.IdempotencyKey,
		SentAt:         now,
	}

	existing, exists, err := s.outboxStore.GetBusOutboxRecord(ctx, channel, decision.IdempotencyKey)
	if err != nil {
		return ShareOutcome{}, false, err
	}
	if exists {
		if existing.Status == BusDeliveryStatusSent {
			outcome.Accepted = existing.Accepted
			outcome.Deduped = true
			if existing.SentAt != nil {
				outcome.SentAt = existing.SentAt.UTC()
			}
			return outcome, false, nil
		}
	}

	baseRecord := BusOutboxRecord{
		Channel:        channel,
		IdempotencyKey: decision.IdempotencyKey,
		ContactID:      decision.ContactID,
		PeerID:         decision.PeerID,
		ItemID:         decision.ItemID,
		Topic:          decision.Topic,
		ContentType:    decision.ContentType,
		PayloadBase64:  decision.PayloadBase64,
	}
	var current *BusOutboxRecord
	if exists {
		current = &existing
	}
	pendingRecord, err := NextOutboxRecord(current, baseRecord, OutboxTransition{
		Type: OutboxTransitionStartAttempt,
	}, now)
	if err != nil {
		return ShareOutcome{}, false, err
	}
	if err := s.outboxStore.PutBusOutboxRecord(ctx, pendingRecord); err != nil {
		return ShareOutcome{}, false, err
	}

	accepted, deduped, sendErr := sender.Send(ctx, contact, decision)
	if sendErr != nil {
		outcome.Error = sendErr.Error()
		failedRecord, err := NextOutboxRecord(&pendingRecord, baseRecord, OutboxTransition{
			Type:      OutboxTransitionMarkFailed,
			ErrorText: outcome.Error,
		}, now)
		if err != nil {
			return ShareOutcome{}, false, err
		}
		if err := s.outboxStore.PutBusOutboxRecord(ctx, failedRecord); err != nil {
			return ShareOutcome{}, false, err
		}
		return outcome, true, nil
	}

	outcome.Accepted = accepted
	outcome.Deduped = deduped
	sentRecord, err := NextOutboxRecord(&pendingRecord, baseRecord, OutboxTransition{
		Type:     OutboxTransitionMarkSent,
		Accepted: accepted,
		Deduped:  deduped,
	}, now)
	if err != nil {
		return ShareOutcome{}, false, err
	}
	if err := s.outboxStore.PutBusOutboxRecord(ctx, sentRecord); err != nil {
		return ShareOutcome{}, false, err
	}
	return outcome, true, nil
}

func hasTelegramTarget(contact Contact) bool {
	for _, endpoint := range contact.ChannelEndpoints {
		if strings.ToLower(strings.TrimSpace(endpoint.Channel)) != ChannelTelegram {
			continue
		}
		if endpoint.ChatID != 0 || strings.TrimSpace(endpoint.Address) != "" {
			return true
		}
	}
	for _, raw := range []string{contact.SubjectID, contact.ContactID} {
		v := strings.TrimSpace(strings.ToLower(raw))
		if strings.HasPrefix(v, "tg:@") {
			return true
		}
		if strings.HasPrefix(v, "tg:") && strings.TrimSpace(v[len("tg:"):]) != "" {
			return true
		}
	}
	return false
}

func recomputeRetainScore(contact Contact, now time.Time) Contact {
	depthNorm := clamp(contact.UnderstandingDepth/100.0, 0, 1)
	reciprocityNorm := clamp(contact.ReciprocityNorm, 0, 1)
	recentAt := contact.UpdatedAt
	if contact.LastInteractionAt != nil && contact.LastInteractionAt.After(recentAt) {
		recentAt = *contact.LastInteractionAt
	}
	if contact.LastSharedAt != nil && contact.LastSharedAt.After(recentAt) {
		recentAt = *contact.LastSharedAt
	}
	if recentAt.IsZero() {
		recentAt = now
	}
	ageHours := now.Sub(recentAt).Hours()
	if ageHours < 0 {
		ageHours = 0
	}
	recencyNorm := clamp(math.Exp(-ageHours/(24.0*14.0)), 0, 1)
	contact.RetainScore = clamp(0.45*depthNorm+0.35*recencyNorm+0.20*reciprocityNorm, 0, 1)
	return contact
}

func deriveContactID(contact Contact) string {
	if v := strings.TrimSpace(contact.SubjectID); v != "" {
		return v
	}
	if v := strings.TrimSpace(contact.NodeID); v != "" {
		return v
	}
	if v := strings.TrimSpace(contact.PeerID); v != "" {
		return "maep:" + v
	}
	return ""
}

func normalizeNow(now time.Time) time.Time {
	if now.IsZero() {
		return time.Now().UTC()
	}
	return now.UTC()
}
