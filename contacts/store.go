package contacts

import "context"

type Store interface {
	Ensure(ctx context.Context) error

	GetContact(ctx context.Context, contactID string) (Contact, bool, error)
	PutContact(ctx context.Context, contact Contact) error
	ListContacts(ctx context.Context, status Status) ([]Contact, error)

	GetBusInboxRecord(ctx context.Context, channel string, platformMessageID string) (BusInboxRecord, bool, error)
	PutBusInboxRecord(ctx context.Context, record BusInboxRecord) error
	GetBusOutboxRecord(ctx context.Context, channel string, idempotencyKey string) (BusOutboxRecord, bool, error)
	PutBusOutboxRecord(ctx context.Context, record BusOutboxRecord) error
}
