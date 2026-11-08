// Package configcmd is `morph config`: reading and changing the config where it is kept, in
// agent.db or in the file --config names.
package configcmd

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/configbootstrap"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// New returns the `config` command.
func New() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Read and change the config (in agent.db, or the file --config names)",
		Long: "Read and change the config. Without --config it is in agent.db in the state folder; with " +
			"--config it is that file. Values are kept as written: ${VAR} and secret references are " +
			"expanded when the config is read.",
	}
	cmd.AddCommand(newGetCmd(), newSetCmd(), newExportCmd(), newImportCmd(), newEditCmd(), newWhereCmd())
	return cmd
}

// ConfigPath is the config the command works on: the --config file, or agent.db's config.
func ConfigPath() string {
	path := strings.TrimSpace(viper.GetString("config"))
	if path == "" {
		return configstore.DBConfigPath(pathutil.ResolveStateDir(viper.GetString("file_state_dir")))
	}
	return pathutil.ExpandHomePath(path)
}

func readDocument(path string) (*yaml.Node, error) {
	raw, err := configstore.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return configbootstrap.NewEmptyDocument(), nil
		}
		return nil, err
	}
	return configbootstrap.LoadDocumentBytes(raw)
}

func splitPath(path string) ([]string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("a config path is required, such as llm.model")
	}
	parts := strings.Split(path, ".")
	for _, part := range parts {
		if part == "" {
			return nil, fmt.Errorf("invalid config path %q", path)
		}
	}
	return parts, nil
}

// lookup finds the node at parts: mapping keys, or a sequence's index.
func lookup(node *yaml.Node, parts []string) *yaml.Node {
	for _, part := range parts {
		switch node.Kind {
		case yaml.MappingNode:
			node = configbootstrap.FindMappingValue(node, part)
		case yaml.SequenceNode:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(node.Content) {
				return nil
			}
			node = node.Content[i]
		default:
			return nil
		}
		if node == nil {
			return nil
		}
	}
	return node
}

func newGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <path>",
		Short: "Print one config value, as written (for example llm.model or llm.routes)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			parts, err := splitPath(args[0])
			if err != nil {
				return err
			}
			doc, err := readDocument(ConfigPath())
			if err != nil {
				return err
			}
			root, err := configbootstrap.DocumentMapping(doc)
			if err != nil {
				return err
			}
			node := lookup(root, parts)
			if node == nil {
				return fmt.Errorf("%s is not set", args[0])
			}
			if node.Kind == yaml.ScalarNode {
				_, err := fmt.Fprintln(cmd.OutOrStdout(), node.Value)
				return err
			}
			out, err := yaml.Marshal(node)
			if err != nil {
				return err
			}
			_, err = cmd.OutOrStdout().Write(out)
			return err
		},
	}
}

func newSetCmd() *cobra.Command {
	var unset bool
	cmd := &cobra.Command{
		Use:   "set <path> [value]",
		Short: "Set one config value; the value is read as YAML (90s, true, 8, [a, b], \"text\")",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			parts, err := splitPath(args[0])
			if err != nil {
				return err
			}
			if !unset && len(args) != 2 {
				return fmt.Errorf("a value is required (or --unset)")
			}
			path := ConfigPath()
			doc, err := readDocument(path)
			if err != nil {
				return err
			}
			root, err := configbootstrap.DocumentMapping(doc)
			if err != nil {
				return err
			}
			parent := root
			for _, part := range parts[:len(parts)-1] {
				next := configbootstrap.FindMappingValue(parent, part)
				if next == nil || next.Kind != yaml.MappingNode {
					if unset {
						return nil
					}
					next = configbootstrap.EnsureMappingValue(parent, part)
					if next.Kind != yaml.MappingNode {
						return fmt.Errorf("%s is not a mapping", part)
					}
				}
				parent = next
			}
			key := parts[len(parts)-1]
			if unset {
				configbootstrap.DeleteMappingKey(parent, key)
				pruneEmpty(root, parts[:len(parts)-1])
			} else {
				var value yaml.Node
				if err := yaml.Unmarshal([]byte(args[1]), &value); err != nil {
					return fmt.Errorf("read %q as YAML: %w", args[1], err)
				}
				node := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: ""}
				if len(value.Content) > 0 {
					node = value.Content[0]
				}
				configbootstrap.DeleteMappingKey(parent, key)
				parent.Content = append(parent.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, node)
			}
			out, err := configbootstrap.MarshalDocument(doc)
			if err != nil {
				return err
			}
			return configstore.WriteFileBy(path, out, configstore.ByCLI)
		},
	}
	cmd.Flags().BoolVar(&unset, "unset", false, "Remove the value instead of setting it.")
	return cmd
}

func newExportCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "export <file>",
		Short: "Write the whole config as YAML, in the order of config.example.yaml (- for stdout)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			raw, err := configstore.ReadFile(ConfigPath())
			if err != nil && !os.IsNotExist(err) {
				return err
			}
			return writeOut(cmd.OutOrStdout(), args[0], raw)
		},
	}
}

func writeOut(stdout io.Writer, target string, data []byte) error {
	if target == "-" {
		_, err := stdout.Write(data)
		return err
	}
	return fsstore.WriteTextAtomic(pathutil.ExpandHomePath(target), string(data), fsstore.FileOptions{DirPerm: 0o700, FilePerm: 0o600})
}

// ImportDocument replaces the config at path with data, in one transaction for agent.db. data
// must be a YAML mapping (or empty).
func ImportDocument(path string, data []byte) error {
	if len(bytes.TrimSpace(data)) > 0 {
		var doc yaml.Node
		if err := yaml.Unmarshal(data, &doc); err != nil {
			return fmt.Errorf("parse config: %w", err)
		}
		if len(doc.Content) > 0 && doc.Content[0].Kind != yaml.MappingNode && doc.Content[0].ShortTag() != "!!null" {
			return fmt.Errorf("config must be a mapping")
		}
	}
	return configstore.WriteFileBy(path, data, configstore.ByImport)
}

func newImportCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "import <file>",
		Short: "Replace the config with a YAML file (comments are not kept)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var data []byte
			var err error
			if args[0] == "-" {
				data, err = io.ReadAll(cmd.InOrStdin())
			} else {
				data, err = os.ReadFile(pathutil.ExpandHomePath(args[0]))
			}
			if err != nil {
				return err
			}
			return ImportDocument(ConfigPath(), data)
		},
	}
}

// editorCommand runs the editor on a file; tests replace it.
var editorCommand = func(path string) error {
	editor := strings.TrimSpace(os.Getenv("VISUAL"))
	if editor == "" {
		editor = strings.TrimSpace(os.Getenv("EDITOR"))
	}
	if editor == "" {
		editor = "vi"
	}
	fields := strings.Fields(editor)
	run := exec.Command(fields[0], append(fields[1:], path)...)
	run.Stdin, run.Stdout, run.Stderr = os.Stdin, os.Stdout, os.Stderr
	return run.Run()
}

func newEditCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "edit",
		Short: "Open the config in $EDITOR: export, edit, then import",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			path := ConfigPath()
			raw, err := configstore.ReadFile(path)
			if err != nil && !os.IsNotExist(err) {
				return err
			}
			dir, err := os.MkdirTemp("", "morph-config-")
			if err != nil {
				return err
			}
			defer func() { _ = os.RemoveAll(dir) }()
			file := filepath.Join(dir, "config.yaml")
			if err := os.WriteFile(file, raw, 0o600); err != nil {
				return err
			}
			if err := editorCommand(file); err != nil {
				return fmt.Errorf("editor: %w", err)
			}
			edited, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			if bytes.Equal(edited, raw) {
				_, _ = fmt.Fprintln(cmd.OutOrStdout(), "config unchanged")
				return nil
			}
			if err := ImportDocument(path, edited); err != nil {
				return fmt.Errorf("the edited config was not saved: %w", err)
			}
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), "config saved")
			return nil
		},
	}
}

func newWhereCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "where",
		Short: "Print where the config is kept",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			path := ConfigPath()
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "%s (%s)\n", path, configstore.Source(path))
			return err
		},
	}
}

// pruneEmpty removes the mappings along parts that an unset left empty, deepest first.
func pruneEmpty(root *yaml.Node, parts []string) {
	for depth := len(parts); depth > 0; depth-- {
		parent := lookup(root, parts[:depth-1])
		node := lookup(root, parts[:depth])
		if parent == nil || node == nil || node.Kind != yaml.MappingNode || len(node.Content) > 0 {
			return
		}
		configbootstrap.DeleteMappingKey(parent, parts[depth-1])
	}
}
