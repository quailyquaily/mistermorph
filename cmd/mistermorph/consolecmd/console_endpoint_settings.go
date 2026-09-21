package consolecmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/configbootstrap"
	"github.com/quailyquaily/mistermorph/internal/configutil"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

type consoleEndpointSettingsPayload struct {
	OriginalName        string `json:"original_name,omitempty"`
	Name                string `json:"name"`
	URL                 string `json:"url"`
	AuthToken           string `json:"auth_token"`
	AuthTokenConfigured bool   `json:"auth_token_configured,omitempty"`
}

func resolveConsoleEndpointSettings(ctx context.Context, raw []byte, store secref.OSStore) ([]runtimeEndpointConfig, error) {
	reader := viper.New()
	reader.SetConfigType("yaml")
	if err := reader.ReadConfig(bytes.NewReader(raw)); err != nil {
		return nil, err
	}
	var items []runtimeEndpointConfigRaw
	if err := reader.UnmarshalKey("console.endpoints", &items); err != nil {
		return nil, err
	}
	awsConfig := configutil.AWSSecretsManagerConfigFromReader(reader)
	awsConfig.Region, _ = configutil.ExpandStrictEnv(awsConfig.Region)
	awsConfig.Profile, _ = configutil.ExpandStrictEnv(awsConfig.Profile)
	resolver := secref.NewResolver(secref.NewDefaultSourceWithOSStore(awsConfig, store))
	for i := range items {
		for field, value := range map[string]*string{"name": &items[i].Name, "url": &items[i].URL, "auth_token": &items[i].AuthToken} {
			result, err := resolver.ResolveString(ctx, *value, secref.Options{EnvMissing: secref.EnvMissingError})
			if err != nil || len(result.Warnings) > 0 {
				return nil, fmt.Errorf("console.endpoints[%d].%s could not be resolved", i, field)
			}
			*value = result.Value
		}
		parsed, err := url.Parse(strings.TrimSpace(items[i].URL))
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return nil, fmt.Errorf("console.endpoints[%d] has an invalid URL", i)
		}
	}
	endpoints, warnings := resolveRuntimeEndpointsForServe(items)
	if len(warnings) > 0 {
		return nil, fmt.Errorf("console endpoints must have unique names and non-empty names, URLs, and resolved tokens")
	}
	return endpoints, nil
}

func (s *server) validateConsoleEndpointConnections(ctx context.Context, configs []runtimeEndpointConfig) error {
	s.endpointStateMu.RLock()
	current := make(map[string]*daemonTaskClient, len(s.endpoints))
	for _, endpoint := range s.endpoints {
		if client, ok := endpoint.Client.(*daemonTaskClient); ok {
			current[endpoint.Ref] = client
		}
	}
	s.endpointStateMu.RUnlock()
	for _, config := range configs {
		if client := current[config.Ref]; client != nil && client.baseURL == config.URL && client.authToken == config.AuthToken {
			continue
		}
		client := newDaemonTaskClient(config.URL, config.AuthToken)
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		health, err := client.Health(probeCtx)
		if err != nil || health.Mode == "" {
			cancel()
			return fmt.Errorf("agent %q connection test failed: health check failed; check the Runtime API URL and availability", config.Name)
		}
		// Health is public; a read-only task request also verifies the access token.
		status, raw, err := client.Proxy(probeCtx, http.MethodGet, "/tasks?limit=1", nil, "")
		cancel()
		if err != nil {
			return fmt.Errorf("agent %q connection test failed: Runtime API could not be reached", config.Name)
		}
		if status == http.StatusUnauthorized || status == http.StatusForbidden {
			return fmt.Errorf("agent %q connection test failed: access token was rejected (HTTP %d)", config.Name, status)
		}
		if status != http.StatusOK {
			return fmt.Errorf("agent %q connection test failed: Runtime API returned HTTP %d", config.Name, status)
		}
		var tasks struct {
			Items json.RawMessage `json:"items"`
		}
		if json.Unmarshal(raw, &tasks) != nil || len(tasks.Items) == 0 || (tasks.Items[0] != '[' && string(tasks.Items) != "null") {
			return fmt.Errorf("agent %q connection test failed: invalid Runtime API response", config.Name)
		}
	}
	return nil
}

func (s *server) replaceRuntimeEndpoints(configs []runtimeEndpointConfig) {
	s.ensureEndpointStates()
	s.endpointStateMu.Lock()
	previous := make(map[string]int, len(s.endpoints))
	for i, endpoint := range s.endpoints {
		previous[endpoint.Ref] = i
	}
	endpoints := make([]runtimeEndpoint, 0, len(configs)+1)
	states := make([]endpointCachedState, 0, len(configs)+1)
	if i, ok := previous[consoleLocalEndpointRef]; ok {
		endpoints = append(endpoints, s.endpoints[i])
		states = append(states, s.endpointStates[i])
	}
	for _, config := range configs {
		if i, ok := previous[config.Ref]; ok {
			if client, ok := s.endpoints[i].Client.(*daemonTaskClient); ok && client.baseURL == config.URL && client.authToken == config.AuthToken {
				endpoints = append(endpoints, s.endpoints[i])
				states = append(states, s.endpointStates[i])
				delete(previous, config.Ref)
				continue
			}
		}
		endpoints = append(endpoints, runtimeEndpoint{Ref: config.Ref, Name: config.Name, URL: config.URL, Client: newDaemonTaskClient(config.URL, config.AuthToken)})
		states = append(states, endpointCachedState{})
	}
	var retired []*daemonTaskClient
	for _, i := range previous {
		if client, ok := s.endpoints[i].Client.(*daemonTaskClient); ok {
			retired = append(retired, client)
		}
	}
	s.endpoints = endpoints
	s.endpointStates = states
	s.endpointByRef = make(map[string]runtimeEndpoint, len(endpoints))
	for _, endpoint := range endpoints {
		s.endpointByRef[endpoint.Ref] = endpoint
	}
	s.endpointGeneration++
	if s.endpointRefresh != nil {
		select {
		case s.endpointRefresh <- struct{}{}:
		default:
		}
	}
	s.endpointStateMu.Unlock()
	for _, client := range retired {
		if client.downloadClient != nil {
			client.downloadClient.CloseIdleConnections()
		}
	}
}

func consoleEndpointSettingsFromDocument(doc *yaml.Node) []consoleEndpointSettingsPayload {
	root, err := configbootstrap.DocumentMapping(doc)
	if err != nil {
		return nil
	}
	consoleNode := configbootstrap.FindMappingValue(root, "console")
	endpointsNode := configbootstrap.FindMappingValue(consoleNode, "endpoints")
	if endpointsNode == nil || endpointsNode.Kind != yaml.SequenceNode {
		return nil
	}
	items := make([]consoleEndpointSettingsPayload, 0, len(endpointsNode.Content))
	for _, node := range endpointsNode.Content {
		if node == nil || node.Kind != yaml.MappingNode {
			continue
		}
		name := mappingScalar(node, "name")
		if name == "" {
			continue
		}
		items = append(items, consoleEndpointSettingsPayload{
			OriginalName:        name,
			Name:                name,
			URL:                 mappingScalar(node, "url"),
			AuthTokenConfigured: mappingScalar(node, "auth_token") != "",
		})
	}
	return items
}

func prepareConsoleEndpointSecrets(ctx context.Context, endpoints []consoleEndpointSettingsPayload, store secref.OSStore) ([]string, error) {
	if store == nil {
		return nil, nil
	}
	type replacement struct {
		index int
		value string
	}
	created := make([]string, 0, len(endpoints))
	replacements := make([]replacement, 0, len(endpoints))
	for index := range endpoints {
		value := strings.TrimSpace(endpoints[index].AuthToken)
		if value == "" {
			continue
		}
		if _, ok := secref.ParseSingleRef(value); ok {
			continue
		}
		id, err := secref.NewOSSecretID()
		if err != nil {
			secref.DeleteOSSecrets(ctx, store, created)
			return nil, err
		}
		name := strings.TrimSpace(endpoints[index].Name)
		if err := store.Put(ctx, id, "console.endpoints."+name+".auth_token", []byte(value)); err != nil {
			secref.DeleteOSSecrets(ctx, store, created)
			return nil, err
		}
		created = append(created, id)
		replacements = append(replacements, replacement{index: index, value: secref.OSSecretRef(id)})
	}
	for _, replacement := range replacements {
		endpoints[replacement.index].AuthToken = replacement.value
	}
	return created, nil
}

func applyConsoleEndpointSettings(raw []byte, endpoints []consoleEndpointSettingsPayload) ([]byte, error) {
	doc, err := configbootstrap.LoadDocumentBytes(raw)
	if err != nil {
		return nil, err
	}
	root, err := configbootstrap.DocumentMapping(doc)
	if err != nil {
		return nil, err
	}
	consoleNode := configbootstrap.EnsureMappingValue(root, "console")
	currentNode := configbootstrap.FindMappingValue(consoleNode, "endpoints")
	current := map[string]*yaml.Node{}
	if currentNode != nil && currentNode.Kind == yaml.SequenceNode {
		for _, node := range currentNode.Content {
			if name := strings.ToLower(mappingScalar(node, "name")); name != "" {
				current[name] = node
			}
		}
	}

	seen := map[string]bool{}
	nextNode := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	for _, endpoint := range endpoints {
		name := strings.TrimSpace(endpoint.Name)
		rawURL := strings.TrimSpace(endpoint.URL)
		if name == "" || rawURL == "" {
			return nil, fmt.Errorf("console endpoint name and URL are required")
		}
		parsed, err := url.Parse(rawURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return nil, fmt.Errorf("console endpoint %q has an invalid URL", name)
		}
		key := strings.ToLower(name)
		if seen[key] {
			return nil, fmt.Errorf("duplicate console endpoint %q", name)
		}
		seen[key] = true
		original := strings.ToLower(strings.TrimSpace(endpoint.OriginalName))
		if original == "" {
			original = key
		}
		node := current[original]
		if node == nil {
			node = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		}
		configbootstrap.SetOrDeleteMappingScalar(node, "name", name)
		configbootstrap.SetOrDeleteMappingScalar(node, "url", rawURL)
		if token := strings.TrimSpace(endpoint.AuthToken); token != "" {
			configbootstrap.SetOrDeleteMappingScalar(node, "auth_token", token)
		} else if mappingScalar(node, "auth_token") == "" {
			return nil, fmt.Errorf("console endpoint %q auth token is required", name)
		}
		nextNode.Content = append(nextNode.Content, node)
	}
	if len(nextNode.Content) == 0 {
		configbootstrap.DeleteMappingKey(consoleNode, "endpoints")
	} else {
		setMappingNode(consoleNode, "endpoints", nextNode)
	}
	return configbootstrap.MarshalDocument(doc)
}

func mappingScalar(node *yaml.Node, key string) string {
	value := configbootstrap.FindMappingValue(node, key)
	if value == nil || value.Kind != yaml.ScalarNode {
		return ""
	}
	return strings.TrimSpace(value.Value)
}

func setMappingNode(node *yaml.Node, key string, value *yaml.Node) {
	for index := 0; index+1 < len(node.Content); index += 2 {
		if strings.EqualFold(strings.TrimSpace(node.Content[index].Value), key) {
			node.Content[index+1] = value
			return
		}
	}
	node.Content = append(node.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		value,
	)
}
