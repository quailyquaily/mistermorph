package tools

import "context"

type Tool interface {
	Name() string
	Description() string
	ParameterSchema() string
	Execute(ctx context.Context, params map[string]any) (string, error)
}
