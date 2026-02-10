package contactscmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/maep"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

func New() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "contacts",
		Short: "Manage business-layer contacts",
	}
	cmd.PersistentFlags().String("dir", "", "Contacts state directory (defaults to file_state_dir/contacts)")

	cmd.AddCommand(newSyncMAEPCmd())
	return cmd
}

func newSyncMAEPCmd() *cobra.Command {
	var maepDir string
	cmd := &cobra.Command{
		Use:   "sync-maep",
		Short: "Import MAEP contacts into contacts business store",
		RunE: func(cmd *cobra.Command, args []string) error {
			maepSvc := maepServiceFromDir(maepDir)
			maepContacts, err := maepSvc.ListContacts(cmd.Context())
			if err != nil {
				return err
			}
			svc := serviceFromCmd(cmd)
			existingContacts, err := svc.ListContacts(cmd.Context(), "")
			if err != nil {
				return err
			}
			existingByNodeID := map[string]string{}
			for _, item := range existingContacts {
				nodeID := strings.TrimSpace(item.MAEPNodeID)
				contactID := strings.TrimSpace(item.ContactID)
				if nodeID == "" || contactID == "" {
					continue
				}
				if _, ok := existingByNodeID[nodeID]; ok {
					continue
				}
				existingByNodeID[nodeID] = contactID
			}

			now := time.Now().UTC()
			imported := 0
			for _, item := range maepContacts {
				nodeID := strings.TrimSpace(item.NodeID)
				targetContactID := resolveSyncMAEPTargetContactID(existingByNodeID, nodeID, item.PeerID)
				dialAddress := ""
				if len(item.Addresses) > 0 {
					dialAddress = strings.TrimSpace(item.Addresses[0])
				}
				record := contacts.Contact{
					ContactID:       targetContactID,
					Kind:            contacts.KindAgent,
					Channel:         contacts.ChannelMAEP,
					ContactNickname: strings.TrimSpace(item.DisplayName),
					MAEPNodeID:      nodeID,
					MAEPDialAddress: dialAddress,
				}
				updated, err := svc.UpsertContact(cmd.Context(), record, now)
				if err != nil {
					return err
				}
				if nodeID != "" {
					existingByNodeID[nodeID] = strings.TrimSpace(updated.ContactID)
				}
				imported++
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "imported: %d\n", imported)
			return nil
		},
	}
	cmd.Flags().StringVar(&maepDir, "maep-dir", "", "MAEP state directory (defaults to file_state_dir/maep)")
	return cmd
}

func serviceFromCmd(cmd *cobra.Command) *contacts.Service {
	dir, _ := cmd.Flags().GetString("dir")
	dir = strings.TrimSpace(dir)
	if dir == "" {
		dir = statepaths.ContactsDir()
	} else {
		dir = pathutil.ExpandHomePath(dir)
	}
	return contacts.NewServiceWithOptions(
		contacts.NewFileStore(dir),
		contacts.ServiceOptions{
			FailureCooldown: configuredContactsFailureCooldown(),
		},
	)
}

func configuredContactsFailureCooldown() time.Duration {
	v := viper.GetDuration("contacts.proactive.failure_cooldown")
	if v <= 0 {
		return 72 * time.Hour
	}
	return v
}

func maepServiceFromDir(dir string) *maep.Service {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		dir = statepaths.MAEPDir()
	} else {
		dir = pathutil.ExpandHomePath(dir)
	}
	return maep.NewService(maep.NewFileStore(dir))
}

func chooseContactID(nodeID string, peerID string) string {
	nodeID = strings.TrimSpace(nodeID)
	if nodeID != "" {
		return nodeID
	}
	peerID = strings.TrimSpace(peerID)
	if peerID == "" {
		return ""
	}
	return "maep:" + peerID
}

func resolveSyncMAEPTargetContactID(existingByNodeID map[string]string, nodeID string, peerID string) string {
	nodeID = strings.TrimSpace(nodeID)
	if nodeID != "" && existingByNodeID != nil {
		if existing, ok := existingByNodeID[nodeID]; ok {
			existing = strings.TrimSpace(existing)
			if existing != "" {
				return existing
			}
		}
	}
	return chooseContactID(nodeID, peerID)
}
