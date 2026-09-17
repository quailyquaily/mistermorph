package llmutil

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/llm"
)

func TestRouteClientRetriesTimeoutWithoutFallback(t *testing.T) {
	for _, weighted := range []bool{false, true} {
		t.Run(fmt.Sprintf("weighted=%v", weighted), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				cfg := llmconfig.ClientConfig{Model: "main"}
				route := ResolvedRoute{ClientConfig: cfg}
				if weighted {
					route.Candidates = []ResolvedCandidate{{ClientConfig: cfg, Weight: 1}}
				}
				var calls []time.Time
				client, err := BuildRouteClient(route, nil, func(llmconfig.ClientConfig, RuntimeValues) (llm.Client, error) {
					return &testLLMClient{chatFn: func(ctx context.Context, req llm.Request) (llm.Result, error) {
						if ctx.Err() != nil || req.Model != "main" || req.Messages[0].Content != "task" {
							t.Fatalf("retry changed request or reused expired context: %+v, %v", req, ctx.Err())
						}
						calls = append(calls, time.Now())
						if len(calls) < 6 {
							return llm.Result{}, context.DeadlineExceeded
						}
						return llm.Result{Text: "ok"}, nil
					}}, nil
				}, nil, nil)
				if err != nil {
					t.Fatal(err)
				}
				result, err := client.Chat(context.Background(), llm.Request{Model: "main", Messages: []llm.Message{{Role: "user", Content: "task"}}})
				if err != nil || result.Text != "ok" || len(calls) != 6 {
					t.Fatalf("result=%+v err=%v calls=%d", result, err, len(calls))
				}
				for i := 1; i < len(calls); i++ {
					limit := time.Second << (i - 1)
					if delay := calls[i].Sub(calls[i-1]); delay < limit/2 || delay > limit {
						t.Fatalf("retry %d delay=%s, want [%s,%s]", i, delay, limit/2, limit)
					}
				}
			})
		})
	}
}

func TestFallbackClientRetriesEachModelBeforeSwitching(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var models []string
		makeClient := func(model string) llm.Client {
			return &testLLMClient{chatFn: func(_ context.Context, req llm.Request) (llm.Result, error) {
				if req.Model != model {
					t.Fatalf("model=%q, want %q", req.Model, model)
				}
				models = append(models, model)
				return llm.Result{}, context.DeadlineExceeded
			}}
		}
		client := NewFallbackClient(FallbackClientOptions{
			Primary:   makeClient("main"),
			Fallbacks: []FallbackCandidate{{Model: "backup", Client: makeClient("backup")}},
		})
		_, err := client.Chat(context.Background(), llm.Request{Model: "main"})
		want := []string{"main", "main", "main", "main", "main", "main", "backup", "backup", "backup", "backup", "backup", "backup"}
		if !errors.Is(err, context.DeadlineExceeded) || !reflect.DeepEqual(models, want) {
			t.Fatalf("models=%v err=%v", models, err)
		}
	})
}

func TestFallbackClientRequestRetryClassification(t *testing.T) {
	for _, tt := range []struct {
		name  string
		err   error
		calls int
	}{
		{"wrapped deadline", fmt.Errorf("request: %w", context.DeadlineExceeded), 6},
		{"network timeout", &net.DNSError{IsTimeout: true}, 6},
		{"timeout message", errors.New("upstream request timed out"), 6},
		{"408", errors.New("status 408: request timeout"), 6},
		{"504", errors.New("status 504: gateway timeout"), 6},
		{"subscription HTTP 408", errors.New("codex subscription inference failed with HTTP 408"), 6},
		{"subscription HTTP 504", errors.New("codex subscription inference failed with HTTP 504"), 6},
		{"500", errors.New("status 500: server error"), 6},
		{"503", errors.New("status 503: unavailable"), 6},
		{"529", errors.New("HTTP 529: overloaded"), 6},
		{"400", errors.New("status 400: bad request"), 6},
		{"EOF", io.EOF, 6},
		{"unexpected EOF", io.ErrUnexpectedEOF, 6},
		{"connection refused", &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, 6},
		{"connection reset", &net.OpError{Op: "read", Err: syscall.ECONNRESET}, 6},
		{"DNS failure", &net.DNSError{Err: "no such host"}, 6},
		{"unmatched", errors.New("unknown provider failure"), 6},
		{"401", errors.New("HTTP 401: unauthorized"), 1},
		{"403", errors.New("HTTP 403: forbidden"), 1},
		{"404", errors.New("HTTP 404: model not found"), 1},
		{"415", errors.New("HTTP 415: unsupported media"), 1},
		{"422", errors.New("HTTP 422: unprocessable entity"), 1},
		{"429", errors.New("HTTP 429: too many requests"), 1},
		{"rate limit", errors.New("rate limit reached"), 1},
		{"canceled", context.Canceled, 1},
		{"wrapped canceled", fmt.Errorf("request: %w", context.Canceled), 1},
	} {
		t.Run(tt.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				calls := 0
				var notifications []RetryEvent
				ctx := WithRetryNotification(context.Background(), func(_ context.Context, event RetryEvent) {
					notifications = append(notifications, event)
				})
				client := NewFallbackClient(FallbackClientOptions{Primary: &testLLMClient{chatFn: func(context.Context, llm.Request) (llm.Result, error) {
					calls++
					return llm.Result{}, tt.err
				}}})
				_, err := client.Chat(ctx, llm.Request{})
				if !errors.Is(err, tt.err) || calls != tt.calls {
					t.Fatalf("err=%v calls=%d, want %d", err, calls, tt.calls)
				}
				if len(notifications) != tt.calls-1 {
					t.Fatalf("notifications=%d, want %d", len(notifications), tt.calls-1)
				}
			})
		})
	}
}

func TestFallbackClientNotifiesEveryRetryBeforeWaiting(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var notices []RetryEvent
		var notifiedAt []time.Time
		var calls []time.Time
		clientFor := func(failures int) llm.Client {
			count := 0
			return &testLLMClient{chatFn: func(context.Context, llm.Request) (llm.Result, error) {
				calls = append(calls, time.Now())
				count++
				if count <= failures {
					return llm.Result{}, errors.New(`POST "https://example.invalid/v1/chat/completions?key=secret": 504 Gateway Timeout`)
				}
				return llm.Result{Text: "ok"}, nil
			}}
		}
		client := NewFallbackClient(FallbackClientOptions{
			Primary: clientFor(6), PrimaryProfile: "primary",
			Fallbacks: []FallbackCandidate{{Profile: "backup", Model: "backup-model", Client: clientFor(2)}},
		})
		ctx := WithRetryNotification(context.Background(), func(_ context.Context, event RetryEvent) {
			notices = append(notices, event)
			notifiedAt = append(notifiedAt, time.Now())
			if time.Now() != calls[len(calls)-1] {
				t.Fatal("retry notification was delayed until after backoff")
			}
		})
		result, err := client.Chat(ctx, llm.Request{Model: "main-model", Scene: "chat.loop"})
		if err != nil || result.Text != "ok" || len(notices) != 7 {
			t.Fatalf("result=%+v err=%v notices=%+v", result, err, notices)
		}
		for i, event := range notices {
			attempt, profile, model, nextCall := i+1, "primary", "main-model", i+1
			if i >= 5 {
				attempt, profile, model, nextCall = i-4, "backup", "backup-model", i+2
			}
			if event.Attempt != attempt || event.MaxRetries != 5 || event.Profile != profile || event.Model != model || event.Scene != "chat.loop" {
				t.Fatalf("notice %d = %+v", i, event)
			}
			if event.Reason != "HTTP 504 Gateway Timeout" || calls[nextCall].Sub(notifiedAt[i]) != event.Delay {
				t.Fatalf("notice %d has wrong reason or delay: %+v", i, event)
			}
			if text := event.StatusText(); !strings.Contains(text, "504") || !strings.Contains(text, fmt.Sprintf("%d/5", attempt)) || strings.Contains(text, "secret") || strings.Contains(text, "example.invalid") {
				t.Fatalf("unsafe or incomplete status: %q", text)
			}
		}
	})
}

func TestRetryReasonDescriptions(t *testing.T) {
	for _, tt := range []struct {
		err  error
		want string
	}{
		{context.DeadlineExceeded, "Request timed out"},
		{fmt.Errorf("response: %w", io.ErrUnexpectedEOF), "Response stream interrupted"},
		{io.EOF, "Response stream interrupted"},
		{&net.DNSError{Err: "no such host"}, "DNS lookup failed"},
		{&net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, "Network connection failed"},
		{fmt.Errorf("%w: missing output", errInvalidResponse), "Invalid model response"},
		{errors.New("HTTP 503: upstream private details"), "HTTP 503 Service Unavailable"},
		{errors.New("unknown error with secret"), "Model service request failed"},
	} {
		t.Run(tt.want, func(t *testing.T) {
			if got := retryReasonDescription(tt.err); got != tt.want {
				t.Fatalf("reason=%q, want %q", got, tt.want)
			}
		})
	}
}

func TestFallbackClientStopsWhenTaskEnds(t *testing.T) {
	for _, phase := range []string{"before request", "during request", "during backoff"} {
		t.Run(phase, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				notifications := 0
				ctx = WithRetryNotification(ctx, func(context.Context, RetryEvent) { notifications++ })
				if phase == "before request" {
					cancel()
				}
				calls, fallbackCalls := 0, 0
				client := NewFallbackClient(FallbackClientOptions{
					Primary: &testLLMClient{chatFn: func(context.Context, llm.Request) (llm.Result, error) {
						calls++
						if phase == "during request" {
							cancel()
						} else if phase == "during backoff" {
							timer := time.AfterFunc(100*time.Millisecond, cancel)
							t.Cleanup(func() { timer.Stop() })
						}
						return llm.Result{}, context.DeadlineExceeded
					}},
					Fallbacks: []FallbackCandidate{{Client: &testLLMClient{chatFn: func(context.Context, llm.Request) (llm.Result, error) {
						fallbackCalls++
						return llm.Result{}, nil
					}}}},
				})
				start := time.Now()
				_, err := client.Chat(ctx, llm.Request{})
				wantCalls := 1
				if phase == "before request" {
					wantCalls = 0
				}
				if !errors.Is(err, context.Canceled) || calls != wantCalls || fallbackCalls != 0 || time.Since(start) > 100*time.Millisecond {
					t.Fatalf("err=%v calls=%d fallback=%d elapsed=%v", err, calls, fallbackCalls, time.Since(start))
				}
				wantNotifications := 0
				if phase == "during backoff" {
					wantNotifications = 1
				}
				if notifications != wantNotifications {
					t.Fatalf("notifications=%d, want %d", notifications, wantNotifications)
				}
			})
		})
	}
}

func TestFallbackClientRequestRetrySeparatesStreams(t *testing.T) {
	for _, alreadyDone := range []bool{false, true} {
		t.Run(fmt.Sprintf("alreadyDone=%v", alreadyDone), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				calls := 0
				var buffer strings.Builder
				var streams []string
				client := NewFallbackClient(FallbackClientOptions{Primary: &testLLMClient{chatFn: func(_ context.Context, req llm.Request) (llm.Result, error) {
					calls++
					text := "partial"
					if calls == 2 {
						text = "complete"
					}
					if err := req.OnStream(llm.StreamEvent{Delta: text}); err != nil {
						return llm.Result{}, err
					}
					if buffer.String() != text {
						t.Fatalf("stream was buffered or mixed with previous attempt: %q", buffer.String())
					}
					if calls == 2 || alreadyDone {
						if err := req.OnStream(llm.StreamEvent{Done: true}); err != nil {
							return llm.Result{}, err
						}
					}
					if calls == 1 {
						return llm.Result{}, context.DeadlineExceeded
					}
					return llm.Result{Text: "complete"}, nil
				}}})
				result, err := client.Chat(context.Background(), llm.Request{OnStream: func(event llm.StreamEvent) error {
					buffer.WriteString(event.Delta)
					if event.Done {
						streams = append(streams, buffer.String())
						buffer.Reset()
					}
					return nil
				}})
				if err != nil || result.Text != "complete" || !reflect.DeepEqual(streams, []string{"partial", "complete"}) {
					t.Fatalf("result=%+v err=%v streams=%v", result, err, streams)
				}
			})
		})
	}
}

func TestFallbackClientTaskDeadlineInterruptsBackoff(t *testing.T) {
	for _, requestErr := range []error{context.DeadlineExceeded, io.EOF, errors.New("HTTP 400: bad request")} {
		t.Run(requestErr.Error(), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				defer cancel()
				calls := 0
				primary := &testLLMClient{chatFn: func(context.Context, llm.Request) (llm.Result, error) {
					calls++
					return llm.Result{}, requestErr
				}}
				client := NewFallbackClient(FallbackClientOptions{Primary: primary, Fallbacks: []FallbackCandidate{{Client: primary}}})
				start := time.Now()
				_, err := client.Chat(ctx, llm.Request{})
				if !errors.Is(err, context.DeadlineExceeded) || calls != 1 || time.Since(start) != 100*time.Millisecond {
					t.Fatalf("err=%v calls=%d elapsed=%s", err, calls, time.Since(start))
				}
			})
		})
	}
}

func TestFallbackClientDoesNotRetryStreamConsumerFailure(t *testing.T) {
	for _, failOnDone := range []bool{false, true} {
		t.Run(fmt.Sprint(failOnDone), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				consumerErr := errors.New("consumer stopped reading")
				calls, fallbackCalls := 0, 0
				client := NewFallbackClient(FallbackClientOptions{
					Primary: &testLLMClient{chatFn: func(_ context.Context, req llm.Request) (llm.Result, error) {
						calls++
						if err := req.OnStream(llm.StreamEvent{Delta: "partial"}); err != nil {
							return llm.Result{}, fmt.Errorf("stream: %w", err)
						}
						return llm.Result{}, io.EOF
					}},
					Fallbacks: []FallbackCandidate{{Client: &testLLMClient{chatFn: func(context.Context, llm.Request) (llm.Result, error) {
						fallbackCalls++
						return llm.Result{Text: "unexpected"}, nil
					}}}},
				})
				_, err := client.Chat(context.Background(), llm.Request{OnStream: func(event llm.StreamEvent) error {
					if event.Done == failOnDone {
						return consumerErr
					}
					return nil
				}})
				if !errors.Is(err, consumerErr) || calls != 1 || fallbackCalls != 0 {
					t.Fatalf("err=%v calls=%d fallback=%d", err, calls, fallbackCalls)
				}
			})
		})
	}
}

func TestFallbackClientResultValidationSeparatesStreams(t *testing.T) {
	for _, alreadyDone := range []bool{false, true} {
		t.Run(fmt.Sprint(alreadyDone), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				calls := 0
				var buffer strings.Builder
				var streams []string
				client := NewFallbackClient(FallbackClientOptions{Primary: &testLLMClient{chatFn: func(_ context.Context, req llm.Request) (llm.Result, error) {
					calls++
					text := "null"
					if calls == 2 {
						text = "answer"
					}
					if err := req.OnStream(llm.StreamEvent{Delta: text}); err != nil {
						return llm.Result{}, err
					}
					if alreadyDone || calls == 2 {
						if err := req.OnStream(llm.StreamEvent{Done: true}); err != nil {
							return llm.Result{}, err
						}
					}
					return llm.Result{Text: text}, nil
				}}})
				result, err := client.Chat(context.Background(), llm.Request{
					ValidateResult: func(result llm.Result) error {
						if result.Text == "null" {
							return errors.New("empty answer")
						}
						return nil
					},
					OnStream: func(event llm.StreamEvent) error {
						buffer.WriteString(event.Delta)
						if event.Done {
							streams = append(streams, buffer.String())
							buffer.Reset()
						}
						return nil
					},
				})
				if err != nil || result.Text != "answer" || calls != 2 || !reflect.DeepEqual(streams, []string{"null", "answer"}) {
					t.Fatalf("result=%+v err=%v calls=%d streams=%v", result, err, calls, streams)
				}
			})
		})
	}
}

func TestFallbackClientDoesNotValidateUnrelatedJSON(t *testing.T) {
	calls := 0
	client := NewFallbackClient(FallbackClientOptions{Primary: &testLLMClient{chatFn: func(context.Context, llm.Request) (llm.Result, error) {
		calls++
		return llm.Result{Text: `{"title":"topic"}`}, nil
	}}})
	result, err := client.Chat(context.Background(), llm.Request{ForceJSON: true, Scene: "console.topic_title"})
	if err != nil || result.Text != `{"title":"topic"}` || calls != 1 {
		t.Fatalf("result=%+v err=%v calls=%d", result, err, calls)
	}
}
