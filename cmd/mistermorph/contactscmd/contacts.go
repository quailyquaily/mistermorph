package contactscmd

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
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

	cmd.AddCommand(newListCmd())
	cmd.AddCommand(newUpsertCmd())
	cmd.AddCommand(newSetStatusCmd())
	cmd.AddCommand(newSyncMAEPCmd())
	return cmd
}

func newListCmd() *cobra.Command {
	var status string
	var outputJSON bool
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List contacts",
		RunE: func(cmd *cobra.Command, args []string) error {
			svc := serviceFromCmd(cmd)
			records, err := svc.ListContacts(cmd.Context(), parseStatus(status))
			if err != nil {
				return err
			}
			sort.Slice(records, func(i, j int) bool {
				if records[i].Status != records[j].Status {
					return records[i].Status < records[j].Status
				}
				return strings.TrimSpace(records[i].ContactID) < strings.TrimSpace(records[j].ContactID)
			})
			if outputJSON {
				return writeJSON(cmd.OutOrStdout(), records)
			}
			if len(records) == 0 {
				_, _ = fmt.Fprintln(cmd.OutOrStdout(), "no contacts")
				return nil
			}
			for _, item := range records {
				_, _ = fmt.Fprintf(
					cmd.OutOrStdout(),
					"%s\t%s\t%s\t%s\t%s\n",
					item.ContactID,
					item.Status,
					item.Kind,
					item.Channel,
					item.ContactNickname,
				)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&status, "status", "all", "Filter by status: all|active|inactive")
	cmd.Flags().BoolVar(&outputJSON, "json", false, "Print as JSON")
	return cmd
}

func newUpsertCmd() *cobra.Command {
	var kind string
	var status string
	var channel string
	var contactNickname string
	var personaBrief string
	var telegramUsername string
	var privateChatID string
	var groupChatIDs []string
	var maepNodeID string
	var maepDialAddress string
	var topicPreferences []string
	var outputJSON bool

	cmd := &cobra.Command{
		Use:   "upsert [contact_id]",
		Short: "Create or update one contact",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			contactID := ""
			if len(args) > 0 {
				contactID = strings.TrimSpace(args[0])
			}

			privateID, err := parseOptionalInt64(privateChatID)
			if err != nil {
				return err
			}
			groupIDs, err := parseInt64List(groupChatIDs)
			if err != nil {
				return err
			}

			svc := serviceFromCmd(cmd)
			updated, err := svc.UpsertContact(cmd.Context(), contacts.Contact{
				ContactID:        contactID,
				Kind:             contacts.Kind(strings.TrimSpace(strings.ToLower(kind))),
				Status:           parseStatus(status),
				Channel:          strings.TrimSpace(strings.ToLower(channel)),
				ContactNickname:  strings.TrimSpace(contactNickname),
				PersonaBrief:     strings.TrimSpace(personaBrief),
				TGUsername:       strings.TrimSpace(telegramUsername),
				PrivateChatID:    privateID,
				GroupChatIDs:     groupIDs,
				MAEPNodeID:       strings.TrimSpace(maepNodeID),
				MAEPDialAddress:  strings.TrimSpace(maepDialAddress),
				TopicPreferences: normalizeList(topicPreferences),
			}, time.Now().UTC())
			if err != nil {
				return err
			}
			if outputJSON {
				return writeJSON(cmd.OutOrStdout(), updated)
			}
			_, _ = fmt.Fprintf(
				cmd.OutOrStdout(),
				"contact_id: %s\nstatus: %s\nkind: %s\nchannel: %s\nnickname: %s\n",
				updated.ContactID,
				updated.Status,
				updated.Kind,
				updated.Channel,
				updated.ContactNickname,
			)
			return nil
		},
	}
	cmd.Flags().StringVar(&kind, "kind", "agent", "Contact kind: agent|human")
	cmd.Flags().StringVar(&status, "status", "active", "Contact status: active|inactive")
	cmd.Flags().StringVar(&channel, "channel", "", "Contact channel: telegram|maep|slack|discord")
	cmd.Flags().StringVar(&contactNickname, "nickname", "", "Contact nickname")
	cmd.Flags().StringVar(&personaBrief, "persona-brief", "", "Personality summary for this contact")
	cmd.Flags().StringVar(&telegramUsername, "telegram-username", "", "Telegram username for contact (without @)")
	cmd.Flags().StringVar(&privateChatID, "private-chat-id", "", "Telegram private chat id")
	cmd.Flags().StringArrayVar(&groupChatIDs, "group-chat-id", nil, "Telegram group/supergroup chat id (repeatable)")
	cmd.Flags().StringVar(&maepNodeID, "maep-node-id", "", "MAEP node_id (maep:<peer_id>)")
	cmd.Flags().StringVar(&maepDialAddress, "maep-dial-address", "", "MAEP dial multiaddr")
	cmd.Flags().StringArrayVar(&topicPreferences, "topic", nil, "Topic preference (repeatable)")
	cmd.Flags().BoolVar(&outputJSON, "json", false, "Print as JSON")
	return cmd
}

func newSetStatusCmd() *cobra.Command {
	var outputJSON bool
	cmd := &cobra.Command{
		Use:   "set-status <contact_id> <status>",
		Short: "Move a contact between active/inactive",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			contactID := strings.TrimSpace(args[0])
			if contactID == "" {
				return fmt.Errorf("contact_id is required")
			}
			status := parseStatus(args[1])
			if status != contacts.StatusActive && status != contacts.StatusInactive {
				return fmt.Errorf("invalid status %q (want active|inactive)", args[1])
			}
			svc := serviceFromCmd(cmd)
			updated, err := svc.SetContactStatus(cmd.Context(), contactID, status)
			if err != nil {
				return err
			}
			if outputJSON {
				return writeJSON(cmd.OutOrStdout(), updated)
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "contact_id: %s\nstatus: %s\n", updated.ContactID, updated.Status)
			return nil
		},
	}
	cmd.Flags().BoolVar(&outputJSON, "json", false, "Print as JSON")
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
					Status:          contacts.StatusActive,
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

func parseStatus(raw string) contacts.Status {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case "active":
		return contacts.StatusActive
	case "inactive":
		return contacts.StatusInactive
	default:
		return ""
	}
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

func normalizeList(items []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(items))
	for _, raw := range items {
		item := strings.TrimSpace(raw)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func parseOptionalInt64(raw string) (int64, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, nil
	}
	v, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid int64 %q: %w", raw, err)
	}
	return v, nil
}

func parseInt64List(values []string) ([]int64, error) {
	if len(values) == 0 {
		return nil, nil
	}
	seen := map[int64]bool{}
	out := make([]int64, 0, len(values))
	for _, raw := range values {
		v, err := parseOptionalInt64(raw)
		if err != nil {
			return nil, err
		}
		if v == 0 || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
