// Command embed-console is a program built on the integration package that a mistermorph Console
// can connect to. It serves the runtime API on --listen; add it to the Console as an endpoint to
// chat with it (using its own get_order_status tool) and to watch the tasks it runs.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/quailyquaily/mistermorph/integration"
	"github.com/quailyquaily/mistermorph/tools"
)

// OrderStatusTool is the program's own tool: the Console's chats can use it like a built-in one.
type OrderStatusTool struct{}

func (OrderStatusTool) Name() string { return "get_order_status" }

func (OrderStatusTool) Description() string {
	return "Looks up an Example Shop order by its ID (such as A1001) and returns its status."
}

func (OrderStatusTool) ParameterSchema() string {
	return `{
  "type": "object",
  "properties": {
    "order_id": {"type": "string", "description": "Order ID, such as A1001."}
  },
  "required": ["order_id"]
}`
}

var orders = map[string]map[string]any{
	"A1001": {"status": "shipped", "carrier": "Yamato", "eta": "2026-10-09"},
	"A1002": {"status": "packing", "eta": "2026-10-11"},
	"A1003": {"status": "delivered", "delivered_at": "2026-10-03"},
}

func (OrderStatusTool) Execute(_ context.Context, params map[string]any) (string, error) {
	id, _ := params["order_id"].(string)
	id = strings.ToUpper(strings.TrimSpace(id))
	order, ok := orders[id]
	if !ok {
		return "", fmt.Errorf("order %q not found", id)
	}
	out, _ := json.Marshal(map[string]any{"order_id": id, "order": order})
	return string(out), nil
}

func main() {
	var (
		listen   = flag.String("listen", "127.0.0.1:8790", "Address the runtime API listens on.")
		token    = flag.String("token", os.Getenv("MISTER_MORPH_ENDPOINT_TOKEN"), "Bearer token the Console must send (or MISTER_MORPH_ENDPOINT_TOKEN); empty generates one.")
		stateDir = flag.String("state-dir", "./state", "Where the program keeps its tasks, topics and logs.")
		provider = flag.String("provider", "openai", "LLM inference provider (llm.inference_provider).")
		model    = flag.String("model", "gpt-5.2", "Model name.")
		apiKey   = flag.String("api-key", os.Getenv("OPENAI_API_KEY"), "API key (defaults to OPENAI_API_KEY).")
		endpoint = flag.String("endpoint", "", "Optional base URL of an OpenAI-compatible API.")
		report   = flag.Duration("report-every", 0, "Run a persisted order report this often (e.g. 10m); 0 runs none.")
	)
	flag.Parse()

	authToken := strings.TrimSpace(*token)
	if authToken == "" {
		authToken = randomToken()
	}

	cfg := integration.DefaultConfig()
	cfg.Features.Skills = false
	cfg.BuiltinToolNames = []string{"read_file", "url_fetch"}
	cfg.AddPromptBlock("You are the support agent of Example Shop. Use get_order_status to answer questions about orders.")
	cfg.Set("file_state_dir", *stateDir)
	cfg.Set("llm.inference_provider", strings.TrimSpace(*provider))
	cfg.Set("llm.model", strings.TrimSpace(*model))
	cfg.Set("llm.api_key", strings.TrimSpace(*apiKey))
	if strings.TrimSpace(*endpoint) != "" {
		cfg.Set("llm.endpoint", strings.TrimSpace(*endpoint))
	}
	// The runtime API the Console connects to.
	cfg.Set("server.listen", strings.TrimSpace(*listen))
	cfg.Set("server.auth_token", authToken)

	rt, err := integration.NewChecked(cfg)
	if err != nil {
		log.Fatal(err)
	}
	reg := rt.NewRegistry()
	if err := reg.Register(OrderStatusTool{}); err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *report > 0 {
		go runReports(ctx, rt, reg, *report)
	}

	fmt.Printf(`Serving the runtime API on http://%s/runtime

Add this program to a Console, in its config.yaml:

  console:
    endpoints:
      - name: "Example Shop"
        url: "http://%s/runtime"
        auth_token: "%s"

Press Ctrl+C to stop.
`, *listen, *listen, authToken)

	if err := rt.ServeRuntimeAPI(ctx, integration.RuntimeAPIOptions{Registry: reg}); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

// runReports is the program's own work: a task it runs on a schedule. PersistTask records it, so it
// shows in the Console next to the chats.
func runReports(ctx context.Context, rt *integration.Runtime, reg *tools.Registry, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		result, err := rt.RunTaskWithOptions(ctx, "Check orders A1001, A1002 and A1003 and report any that are late.", integration.RunTaskOptions{
			PersistTask: true,
			TopicID:     "order-reports",
			Registry:    reg,
		})
		if err != nil && ctx.Err() == nil {
			log.Printf("order report failed: %v", err)
		} else if err == nil {
			log.Printf("order report %s done", result.TaskID)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func randomToken() string {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		log.Fatal(err)
	}
	return hex.EncodeToString(buf)
}
