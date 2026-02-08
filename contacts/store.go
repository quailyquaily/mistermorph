package contacts

import "context"

type Store interface {
	Ensure(ctx context.Context) error

	GetContact(ctx context.Context, contactID string) (Contact, bool, error)
	PutContact(ctx context.Context, contact Contact) error
	ListContacts(ctx context.Context, status Status) ([]Contact, error)

	GetCandidate(ctx context.Context, itemID string) (ShareCandidate, bool, error)
	PutCandidate(ctx context.Context, candidate ShareCandidate) error
	ListCandidates(ctx context.Context) ([]ShareCandidate, error)

	GetSessionState(ctx context.Context, sessionID string) (SessionState, bool, error)
	PutSessionState(ctx context.Context, state SessionState) error
	ListSessionStates(ctx context.Context) ([]SessionState, error)

	GetBusInboxRecord(ctx context.Context, channel string, platformMessageID string) (BusInboxRecord, bool, error)
	PutBusInboxRecord(ctx context.Context, record BusInboxRecord) error
	GetBusOutboxRecord(ctx context.Context, channel string, idempotencyKey string) (BusOutboxRecord, bool, error)
	PutBusOutboxRecord(ctx context.Context, record BusOutboxRecord) error
	GetBusDeliveryRecord(ctx context.Context, channel string, idempotencyKey string) (BusDeliveryRecord, bool, error)
	PutBusDeliveryRecord(ctx context.Context, record BusDeliveryRecord) error

	AppendAuditEvent(ctx context.Context, event AuditEvent) error
	ListAuditEvents(ctx context.Context, tickID string, contactID string, action string, limit int) ([]AuditEvent, error)
}
