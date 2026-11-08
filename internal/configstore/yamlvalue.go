package configstore

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// toJSONValue turns a YAML node into a value encoding/json writes back as the same YAML: strings
// stay strings, numbers keep their text (json.Number), mappings keep their key order (orderedMap).
func toJSONValue(node *yaml.Node) (any, error) {
	if node == nil {
		return nil, nil
	}
	switch node.Kind {
	case yaml.DocumentNode:
		if len(node.Content) == 0 {
			return nil, nil
		}
		return toJSONValue(node.Content[0])
	case yaml.AliasNode:
		return toJSONValue(node.Alias)
	case yaml.ScalarNode:
		switch node.ShortTag() {
		case "!!null":
			return nil, nil
		case "!!bool":
			var b bool
			if err := node.Decode(&b); err != nil {
				return nil, err
			}
			return b, nil
		case "!!int", "!!float":
			if json.Valid([]byte(node.Value)) {
				return json.Number(node.Value), nil
			}
			var f any
			if err := node.Decode(&f); err != nil {
				return nil, err
			}
			switch v := f.(type) {
			case int:
				return json.Number(strconv.Itoa(v)), nil
			case int64:
				return json.Number(strconv.FormatInt(v, 10)), nil
			case uint64:
				return json.Number(strconv.FormatUint(v, 10)), nil
			case float64:
				return json.Number(strconv.FormatFloat(v, 'g', -1, 64)), nil
			}
			return node.Value, nil
		default:
			return node.Value, nil
		}
	case yaml.SequenceNode:
		out := make([]any, 0, len(node.Content))
		for _, item := range node.Content {
			v, err := toJSONValue(item)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	case yaml.MappingNode:
		out := orderedMap{}
		for i := 0; i+1 < len(node.Content); i += 2 {
			v, err := toJSONValue(node.Content[i+1])
			if err != nil {
				return nil, err
			}
			out = append(out, orderedEntry{Key: node.Content[i].Value, Value: v})
		}
		return out, nil
	}
	return nil, fmt.Errorf("unsupported YAML node kind %d", node.Kind)
}

type orderedEntry struct {
	Key   string
	Value any
}

// orderedMap is a JSON object that keeps its keys' order.
type orderedMap []orderedEntry

func (m orderedMap) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, e := range m {
		if i > 0 {
			buf.WriteByte(',')
		}
		k, err := json.Marshal(e.Key)
		if err != nil {
			return nil, err
		}
		v, err := json.Marshal(e.Value)
		if err != nil {
			return nil, err
		}
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(v)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func encodeJSON(v any) (string, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// decodeJSONNode reads JSON text as a YAML node, keeping object key order and number text.
func decodeJSONNode(raw string) (*yaml.Node, error) {
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	node, err := decodeJSONValue(dec)
	if err != nil {
		return nil, err
	}
	return node, nil
}

func decodeJSONValue(dec *json.Decoder) (*yaml.Node, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch v := tok.(type) {
	case json.Delim:
		switch v {
		case '{':
			node := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyTok.(string)
				value, err := decodeJSONValue(dec)
				if err != nil {
					return nil, err
				}
				node.Content = append(node.Content, stringNode(key), value)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return node, nil
		case '[':
			node := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			for dec.More() {
				value, err := decodeJSONValue(dec)
				if err != nil {
					return nil, err
				}
				node.Content = append(node.Content, value)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return node, nil
		}
	case nil:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}, nil
	case bool:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(v)}, nil
	case json.Number:
		text := v.String()
		tag := "!!int"
		if strings.ContainsAny(text, ".eE") {
			tag = "!!float"
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: text}, nil
	case string:
		return stringNode(v), nil
	}
	return nil, fmt.Errorf("unexpected JSON token %v", tok)
}

func stringNode(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}

// jsonKind is the settings kind of a value, inferred from its YAML node.
func jsonKind(node *yaml.Node) string {
	if node == nil {
		return "json"
	}
	switch node.Kind {
	case yaml.ScalarNode:
		switch node.ShortTag() {
		case "!!str":
			return "string"
		case "!!bool":
			return "bool"
		case "!!int":
			return "int"
		case "!!float":
			return "float"
		}
		return "json"
	case yaml.SequenceNode:
		for _, item := range node.Content {
			if item.Kind != yaml.ScalarNode || item.ShortTag() != "!!str" {
				return "json"
			}
		}
		return "string_list"
	case yaml.MappingNode:
		for i := 1; i < len(node.Content); i += 2 {
			item := node.Content[i]
			if item.Kind != yaml.ScalarNode || item.ShortTag() != "!!str" {
				return "json"
			}
		}
		return "string_map"
	}
	return "json"
}

// kindFits reports whether a value of the inferred kind can carry the registry's kind label.
func kindFits(registry, inferred string) bool {
	switch registry {
	case "duration":
		return inferred == "string"
	case "json":
		return true
	case "float":
		return inferred == "float" || inferred == "int"
	default:
		return registry == inferred
	}
}

func isScalarString(node *yaml.Node) bool {
	return node != nil && node.Kind == yaml.ScalarNode && node.ShortTag() == "!!str"
}

func isEmptyCollection(node *yaml.Node) bool {
	return node != nil && (node.Kind == yaml.MappingNode || node.Kind == yaml.SequenceNode) && len(node.Content) == 0
}
