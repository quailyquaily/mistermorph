package slack

import (
	"context"
	"fmt"

	"github.com/quailyquaily/mistermorph/internal/slackclient"
	slacktools "github.com/quailyquaily/mistermorph/tools/slack"
)

type slackToolAPI struct {
	api *slackAPI
}

func newSlackToolAPI(api *slackAPI) slacktools.API {
	if api == nil {
		return nil
	}
	return &slackToolAPI{api: api}
}

func (a *slackToolAPI) AddReaction(ctx context.Context, channelID, messageTS, emoji string) error {
	if a == nil || a.api == nil {
		return fmt.Errorf("slack api not available")
	}
	return a.api.addReaction(ctx, channelID, messageTS, emoji)
}

func (a *slackToolAPI) SendFile(ctx context.Context, channelID, threadTS, filePath, filename, title, initialComment string) error {
	if a == nil || a.api == nil {
		return fmt.Errorf("slack api not available")
	}
	return slackclient.New(a.api.http, a.api.baseURL, a.api.botToken).UploadFile(ctx, channelID, threadTS, filePath, filename, title, initialComment)
}
