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
					"%s\t%s\t%s\t%s\t%s\t%s\n",
					item.ContactID,
					item.Status,
					item.Kind,
					item.PeerID,
					item.TrustState,
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
	var peerID string
	var nodeID string
	var subjectID string
	var contactNickname string
	var personaBrief string
	var pronouns string
	var timezone string
	var preferenceContext string
	var displayName string
	var telegramUsername string
	var telegramNickname string
	var trustState string
	var depth float64
	var reciprocity float64
	var addresses []string
	var topicWeights []string
	var personaTraits []string
	var outputJSON bool

	cmd := &cobra.Command{
		Use:   "upsert [contact_id]",
		Short: "Create or update one contact",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			topicMap, err := parseFloatAssignments(topicWeights)
			if err != nil {
				return err
			}
			traitMap, err := parseFloatAssignments(personaTraits)
			if err != nil {
				return err
			}
			contactID := ""
			if len(args) > 0 {
				contactID = strings.TrimSpace(args[0])
			}
			telegramID := telegramContactID(telegramUsername)
			kindValue := contacts.Kind(strings.TrimSpace(strings.ToLower(kind)))
			nickname := strings.TrimSpace(contactNickname)
			if nickname == "" {
				nickname = strings.TrimSpace(displayName)
			}
			if nickname == "" {
				nickname = strings.TrimSpace(telegramNickname)
			}
			if kindValue == contacts.KindHuman && strings.TrimSpace(subjectID) == "" && telegramID != "" {
				subjectID = telegramID
			}
			if kindValue == contacts.KindHuman && contactID == "" && telegramID != "" {
				contactID = telegramID
			}
			svc := serviceFromCmd(cmd)
			updated, err := svc.UpsertContact(cmd.Context(), contacts.Contact{
				ContactID:          contactID,
				Kind:               kindValue,
				Status:             parseStatus(status),
				ContactNickname:    nickname,
				PersonaBrief:       strings.TrimSpace(personaBrief),
				Pronouns:           strings.TrimSpace(pronouns),
				Timezone:           strings.TrimSpace(timezone),
				PreferenceContext:  strings.TrimSpace(preferenceContext),
				PersonaTraits:      traitMap,
				SubjectID:          strings.TrimSpace(subjectID),
				NodeID:             strings.TrimSpace(nodeID),
				PeerID:             strings.TrimSpace(peerID),
				Addresses:          normalizeList(addresses),
				TrustState:         strings.TrimSpace(strings.ToLower(trustState)),
				UnderstandingDepth: depth,
				TopicWeights:       topicMap,
				ReciprocityNorm:    reciprocity,
			}, time.Now().UTC())
			if err != nil {
				return err
			}
			if outputJSON {
				return writeJSON(cmd.OutOrStdout(), updated)
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "contact_id: %s\nstatus: %s\nkind: %s\npeer_id: %s\ncontact_nickname: %s\n", updated.ContactID, updated.Status, updated.Kind, updated.PeerID, updated.ContactNickname)
			return nil
		},
	}
	cmd.Flags().StringVar(&kind, "kind", "agent", "Contact kind: agent|human")
	cmd.Flags().StringVar(&status, "status", "active", "Contact status: active|inactive")
	cmd.Flags().StringVar(&peerID, "peer-id", "", "MAEP peer_id for agent contact")
	cmd.Flags().StringVar(&nodeID, "node-id", "", "MAEP node_id for agent contact")
	cmd.Flags().StringVar(&subjectID, "subject-id", "", "Subject id for human contact")
	cmd.Flags().StringVar(&contactNickname, "contact-nickname", "", "Contact nickname")
	cmd.Flags().StringVar(&personaBrief, "persona-brief", "", "Personality summary for this contact")
	cmd.Flags().StringVar(&pronouns, "pronouns", "", "Pronouns for this contact (for example: she/her, they/them)")
	cmd.Flags().StringVar(&timezone, "timezone", "", "IANA timezone (for example: Asia/Shanghai, America/New_York)")
	cmd.Flags().StringVar(&preferenceContext, "preference-context", "", "Long-form preference/context notes for this contact")
	cmd.Flags().StringVar(&displayName, "display-name", "", "Legacy alias of --contact-nickname")
	cmd.Flags().StringVar(&telegramUsername, "telegram-username", "", "Telegram username for human contact (maps to tg:@<username>)")
	cmd.Flags().StringVar(&telegramNickname, "telegram-nickname", "", "Telegram nickname (fallback for contact_nickname)")
	cmd.Flags().StringVar(&trustState, "trust-state", "verified", "Trust state (verified recommended)")
	cmd.Flags().Float64Var(&depth, "understanding-depth", 30, "Understanding depth [0,100]")
	cmd.Flags().Float64Var(&reciprocity, "reciprocity", 0.5, "Reciprocity score [0,1]")
	cmd.Flags().StringArrayVar(&addresses, "address", nil, "Dial address for MAEP peer (repeatable)")
	cmd.Flags().StringArrayVar(&topicWeights, "topic-weight", nil, "Topic affinity (repeatable): topic=score")
	cmd.Flags().StringArrayVar(&personaTraits, "persona-trait", nil, "Persona trait weight (repeatable): trait=score")
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
	var includeTOFU bool
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
				nodeID := strings.TrimSpace(item.NodeID)
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
				trust := strings.TrimSpace(strings.ToLower(string(item.TrustState)))
				if trust != "verified" && !(includeTOFU && trust == "tofu") {
					continue
				}
				nodeID := strings.TrimSpace(item.NodeID)
				targetContactID := resolveSyncMAEPTargetContactID(existingByNodeID, nodeID, item.PeerID)
				record := contacts.Contact{
					ContactID:          targetContactID,
					Kind:               contacts.KindAgent,
					Status:             contacts.StatusActive,
					ContactNickname:    strings.TrimSpace(item.DisplayName),
					NodeID:             nodeID,
					PeerID:             strings.TrimSpace(item.PeerID),
					Addresses:          normalizeList(item.Addresses),
					TrustState:         trust,
					UnderstandingDepth: 30,
					ReciprocityNorm:    0.5,
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
	cmd.Flags().BoolVar(&includeTOFU, "include-tofu", false, "Include TOFU contacts (default only verified)")
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

func telegramContactID(username string) string {
	username = strings.TrimSpace(username)
	if username == "" {
		return ""
	}
	username = strings.TrimPrefix(username, "@")
	username = strings.TrimSpace(username)
	if username == "" {
		return ""
	}
	return "tg:@" + username
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

func parseFloatAssignments(values []string) (map[string]float64, error) {
	if len(values) == 0 {
		return nil, nil
	}
	out := map[string]float64{}
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		idx := strings.Index(value, "=")
		if idx <= 0 || idx == len(value)-1 {
			return nil, fmt.Errorf("invalid assignment %q (want key=value)", raw)
		}
		key := strings.TrimSpace(value[:idx])
		number := strings.TrimSpace(value[idx+1:])
		f, err := strconv.ParseFloat(number, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid number in %q: %w", raw, err)
		}
		out[key] = f
	}
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
