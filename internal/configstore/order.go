package configstore

import (
	"sync"

	"github.com/quailyquaily/mistermorph/assets"
	"gopkg.in/yaml.v3"
)

var (
	exampleOrderOnce sync.Once
	exampleOrder     map[string]map[string]int
)

// ExampleYAML is config.example.yaml, whose key order an exported or rendered config follows.
func ExampleYAML() []byte {
	data, _ := assets.ConfigFS.ReadFile("config/config.example.yaml")
	return data
}

func loadExampleOrder() {
	exampleOrder = map[string]map[string]int{}
	var doc yaml.Node
	if err := yaml.Unmarshal(ExampleYAML(), &doc); err != nil || len(doc.Content) == 0 {
		return
	}
	var walk func(path string, node *yaml.Node)
	walk = func(path string, node *yaml.Node) {
		if node.Kind != yaml.MappingNode {
			return
		}
		order := map[string]int{}
		for i := 0; i+1 < len(node.Content); i += 2 {
			key := node.Content[i].Value
			order[key] = len(order)
			walk(joinPath(path, key), node.Content[i+1])
		}
		exampleOrder[path] = order
	}
	walk("", doc.Content[0])
}

// orderKeys puts keys in config.example.yaml's order at path; keys it does not have keep their
// order, after them.
func orderKeys(path string, keys []string) []string {
	exampleOrderOnce.Do(loadExampleOrder)
	order := exampleOrder[path]
	known := make([]string, 0, len(keys))
	var other []string
	for _, key := range keys {
		if _, ok := order[key]; ok {
			known = append(known, key)
		} else {
			other = append(other, key)
		}
	}
	for i := 1; i < len(known); i++ {
		for j := i; j > 0 && order[known[j]] < order[known[j-1]]; j-- {
			known[j], known[j-1] = known[j-1], known[j]
		}
	}
	return append(known, other...)
}
