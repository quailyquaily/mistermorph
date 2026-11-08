package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/clifmt"
	"github.com/quailyquaily/mistermorph/internal/personastore"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/spf13/cobra"
)

var installIdentityYAMLFenceRE = regexp.MustCompile("(?is)```(?:yaml|yml)\\s*\\n([\\s\\S]*?)\\n```")
var installIdentityYAMLLineRE = regexp.MustCompile(`^\s*(name|creature|vibe|emoji)\s*:\s*(.*)\s*$`)

type installIdentityProfile struct {
	Name     string
	Creature string
	Vibe     string
	Emoji    string
}

type installSoulPresetOption struct {
	Choice      string
	Title       string
	Description string
}

var installSystemEditorOpener = openInstallSystemEditor

func runInstallIdentitySetup(in io.Reader, out io.Writer, path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	reader := bufio.NewReader(in)
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	defaults := parseInstallIdentityProfile(string(raw))
	next := defaults
	if next.Name, err = promptLineWithDefault(reader, out, "Identity name", defaults.Name); err != nil {
		return err
	}
	if next.Creature, err = promptLineWithDefault(reader, out, "Identity creature", defaults.Creature); err != nil {
		return err
	}
	if next.Vibe, err = promptLineWithDefault(reader, out, "Identity vibe", defaults.Vibe); err != nil {
		return err
	}
	if next.Emoji, err = promptLineWithDefault(reader, out, "Identity emoji", defaults.Emoji); err != nil {
		return err
	}
	return writeInstallFilePreserveMode(path, []byte(buildInstallIdentityYAML(next)+"\n"))
}

func runInstallSoulSetup(in io.Reader, out io.Writer, path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	reader := bufio.NewReader(in)
	choice, err := promptInstallSoulPreset(reader, out)
	if err != nil {
		return err
	}
	if choice == "custom" {
		fmt.Fprintf(out, "Opening system editor for %s\n", path)
		return installSystemEditorOpener(path)
	}
	body, err := loadEmbeddedSoulTemplateByID(choice)
	if err != nil {
		return err
	}
	return writeInstallFilePreserveMode(path, []byte(body))
}

func promptInstallSoulPreset(reader *bufio.Reader, out io.Writer) (string, error) {
	options, err := loadInstallSoulPresetOptions()
	if err != nil {
		return "", err
	}
	fmt.Fprintln(out, "")
	fmt.Fprintln(out, "Select soul.md style:")
	for i, option := range options {
		fmt.Fprintf(out, "  %d. %s\n", i+1, option.Title)
		fmt.Fprintf(out, "     %s\n", option.Description)
	}
	for {
		fmt.Fprint(out, "Choice: ")
		raw, err := readTrimmedLine(reader)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(raw) == "" {
			fmt.Fprintln(out, "Choice is required.")
			continue
		}
		if idx, err := parseInstallSoulPresetIndex(raw); err == nil {
			if idx >= 1 && idx <= len(options) {
				return options[idx-1].Choice, nil
			}
		}
		if choice, ok := matchInstallSoulPresetChoice(options, raw); ok {
			return choice, nil
		}
		fmt.Fprintf(out, "Invalid choice %q. Use a preset number or one of: %s\n", raw, installSoulPresetChoiceList(options))
	}
}

func parseInstallSoulPresetIndex(raw string) (int, error) {
	return strconv.Atoi(strings.TrimSpace(raw))
}

func matchInstallSoulPresetChoice(options []installSoulPresetOption, raw string) (string, bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return "", false
	}
	for _, option := range options {
		choice := strings.ToLower(strings.TrimSpace(option.Choice))
		title := strings.ToLower(strings.TrimSpace(option.Title))
		if value == choice || value == title {
			return option.Choice, true
		}
		if option.Choice == "custom" && value == "customize" {
			return option.Choice, true
		}
	}
	return "", false
}

func installSoulPresetChoiceList(options []installSoulPresetOption) string {
	choices := make([]string, 0, len(options))
	for _, option := range options {
		choices = append(choices, option.Choice)
	}
	return strings.Join(choices, "/")
}

func writeInstallFilePreserveMode(path string, body []byte) error {
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	return os.WriteFile(path, body, mode)
}

func parseInstallIdentityProfile(raw string) installIdentityProfile {
	profile := installIdentityProfile{}
	content := strings.ReplaceAll(raw, "\r\n", "\n")
	match := installIdentityYAMLFenceRE.FindStringSubmatch(content)
	if len(match) >= 2 {
		content = match[1]
	}
	for _, line := range strings.Split(content, "\n") {
		lineMatch := installIdentityYAMLLineRE.FindStringSubmatch(line)
		if len(lineMatch) != 3 {
			continue
		}
		value := parseInstallYAMLScalar(lineMatch[2])
		switch lineMatch[1] {
		case "name":
			profile.Name = value
		case "creature":
			profile.Creature = value
		case "vibe":
			profile.Vibe = value
		case "emoji":
			profile.Emoji = value
		}
	}
	return profile
}

func parseInstallYAMLScalar(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	if len(value) >= 2 && ((strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`)) || (strings.HasPrefix(value, `'`) && strings.HasSuffix(value, `'`))) {
		value = value[1 : len(value)-1]
	}
	return value
}

func installYAMLString(value string) string {
	return fmt.Sprintf("%q", strings.TrimSpace(value))
}

func buildInstallIdentityYAML(values installIdentityProfile) string {
	return strings.Join([]string{
		"name: " + installYAMLString(values.Name),
		"name_alts: []",
		"creature: " + installYAMLString(values.Creature),
		"vibe: " + installYAMLString(values.Vibe),
		"emoji: " + installYAMLString(values.Emoji),
	}, "\n")
}

// installPersona writes the identity and the soul preset into agent.db in dir, steps 2 and 3 of
// the setup flow. An identity already there (or imported from the files an older version wrote)
// is kept, and so is its soul. Interactive setup edits a scratch copy of identity.yaml and
// soul.md, as the prompts and the system editor work on files, and saves what they hold.
func installPersona(cmd *cobra.Command, dir string, interactive bool) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	store, err := personastore.Open(ctx, dir)
	if err != nil {
		return err
	}
	defer func() { _ = store.Close() }()
	existing, hasIdentity, err := store.Identity(ctx)
	if err != nil {
		return err
	}
	dbPath := store.DB().Path()
	writeIdentity := !hasIdentity
	writeSoul := !hasIdentity || strings.TrimSpace(existing.Soul) == ""

	scratch, err := os.MkdirTemp(dir, ".install-persona-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(scratch) }()

	id := existing
	report := func(index int, name string, write bool) {
		fmt.Printf("[%d/3] %s ... ", index, name)
		if !write {
			fmt.Printf("%s %s\n", clifmt.Success("done"), clifmt.Warn("(skipped)"))
			fmt.Printf("    %s %s\n", dbPath, clifmt.Warn("(skipped)"))
			return
		}
		fmt.Println(clifmt.Success("done"))
		fmt.Printf("    %s\n", dbPath)
	}
	if writeIdentity {
		body, err := loadIdentityTemplate()
		if err != nil {
			return err
		}
		path := filepath.Join(scratch, statepaths.IdentityFilename)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			return err
		}
		if interactive {
			if err := runInstallIdentitySetup(cmd.InOrStdin(), cmd.OutOrStdout(), path); err != nil {
				return err
			}
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		parsed, err := personastore.ParseIdentityYAML(string(raw))
		if err != nil {
			return err
		}
		parsed.Soul = id.Soul
		id = parsed
	}
	report(2, statepaths.IdentityFilename, writeIdentity)
	if writeSoul {
		body, err := loadSoulTemplate()
		if err != nil {
			return err
		}
		path := filepath.Join(scratch, statepaths.SoulFilename)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			return err
		}
		if interactive {
			if err := runInstallSoulSetup(cmd.InOrStdin(), cmd.OutOrStdout(), path); err != nil {
				return err
			}
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		id.Soul = personastore.ParseSoul(string(raw))
	}
	if writeIdentity || writeSoul {
		if _, err := store.SaveIdentity(ctx, id, personastore.ByInstall); err != nil {
			return err
		}
	}
	report(3, statepaths.SoulFilename, writeSoul)
	return nil
}
