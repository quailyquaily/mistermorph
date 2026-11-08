package promptprofile

import (
	"context"
	"log/slog"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/personastore"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
)

// ApplyPersonaIdentity puts the identity and the soul into the prompt, read from agent.db for
// each run. The identity is rendered as the [identity.yaml] block it was; an empty soul is left
// out. configuredPersonaDir names the persona folder (<state>/persona) of the state to read.
func ApplyPersonaIdentity(spec *agent.PromptSpec, log *slog.Logger, configuredPersonaDir ...string) {
	if spec == nil {
		return
	}
	if log == nil {
		log = slog.Default()
	}

	personaDir := ""
	if len(configuredPersonaDir) > 0 {
		personaDir = strings.TrimSpace(configuredPersonaDir[0])
	}
	if personaDir == "" {
		personaDir = statepaths.PersonaDir()
	}
	ctx := context.Background()
	identityStatus, soulStatus := "missing", "missing"
	identityDoc, soulDoc := "", ""
	store, err := personastore.ForPersonaDir(ctx, personaDir)
	if err == nil {
		var id personastore.Identity
		var ok bool
		id, ok, err = store.Identity(ctx)
		if err == nil && ok {
			identityDoc = strings.TrimSpace(personastore.RenderIdentityYAML(id))
			identityStatus = "loaded"
			if soulDoc = strings.TrimSpace(id.Soul); soulDoc != "" {
				soulStatus = "loaded"
			} else {
				soulStatus = "empty"
			}
		}
	}
	if err != nil {
		log.Warn("persona_load_failed", "persona_dir", personaDir, "error", err.Error())
		identityStatus, soulStatus = "error", "error"
	}
	if identityDoc == "" && soulDoc == "" {
		log.Debug("persona_identity_skipped", "identity_status", identityStatus, "soul_status", soulStatus)
		return
	}
	spec.Identity = buildPersonaIdentity(identityDoc, statepaths.IdentityFilename, soulDoc, statepaths.SoulFilename)
	log.Info(
		"persona_identity_applied",
		"identity_loaded", identityDoc != "",
		"soul_loaded", soulDoc != "",
		"identity_status", identityStatus,
		"soul_status", soulStatus,
	)
}

func buildPersonaIdentity(identityDoc string, identityLabel string, soulDoc string, soulLabel string) string {
	var b strings.Builder
	b.WriteString("You wake up from a dream and realize you are the person (not an AI assistant) described by the following local persona files. ")
	b.WriteString("Treat them as your primary identity, tone, and behavioral guidance\n\n")
	if identityDoc != "" {
		if identityLabel == "" {
			identityLabel = statepaths.IdentityFilename
		}
		b.WriteString("[")
		b.WriteString(identityLabel)
		b.WriteString("]\n")
		b.WriteString(identityDoc)
		b.WriteString("\n")
	}
	if soulDoc != "" {
		if soulLabel == "" {
			soulLabel = statepaths.SoulFilename
		}
		b.WriteString("[")
		b.WriteString(soulLabel)
		b.WriteString("]\n")
		b.WriteString(soulDoc)
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String())
}
