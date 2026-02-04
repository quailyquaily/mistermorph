package memory

import (
	"context"
	"fmt"
)

type Identity struct {
	Enabled     bool
	ExternalKey string
	SubjectID   string
}

type IdentityResolver interface {
	ResolveTelegram(ctx context.Context, userID int64) (Identity, error)
}

type Resolver struct{}

func (r *Resolver) ResolveTelegram(_ context.Context, userID int64) (Identity, error) {
	if userID <= 0 {
		return Identity{Enabled: false}, nil
	}
	ext := fmt.Sprintf("telegram:%d", userID)
	subject := "ext:" + ext
	return Identity{Enabled: true, ExternalKey: ext, SubjectID: subject}, nil
}
