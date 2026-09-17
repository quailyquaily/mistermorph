package chatcmd

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

func TestProgramWriterRoutesOutputWhileProgramIsAttached(t *testing.T) {
	var fallback bytes.Buffer
	writer := &programWriter{fallback: &fallback}
	_, _ = writer.Write([]byte("before\n"))

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	outputs := make(chan string, 1)
	p := tea.NewProgram(newChatModel(&chatSession{}),
		tea.WithContext(ctx), tea.WithInput(nil), tea.WithOutput(io.Discard),
		tea.WithoutRenderer(), tea.WithoutSignalHandler(),
		tea.WithFilter(func(_ tea.Model, msg tea.Msg) tea.Msg {
			if output, ok := msg.(tuiOutputMsg); ok {
				outputs <- output.output
				return nil
			}
			return msg
		}),
	)
	done := make(chan error, 1)
	go func() { _, err := p.Run(); done <- err }()
	writer.setProgram(p)
	_, _ = writer.Write([]byte("during "))
	_, _ = writer.Write([]byte("chat\n"))
	select {
	case output := <-outputs:
		if output != "during chat" {
			t.Fatalf("TUI output=%q", output)
		}
	case <-ctx.Done():
		t.Fatal("TUI output was not delivered")
	}
	p.Quit()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	writer.setProgram(nil)
	_, _ = writer.Write([]byte("after\n"))
	if got := fallback.String(); got != "before\nafter\n" {
		t.Fatalf("fallback output=%q", got)
	}
}

func TestRunREPLReturnsWhenRootContextIsCanceled(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	rootCtx, cancel := context.WithCancel(context.Background())
	inputReader, inputWriter := io.Pipe()
	cmd := New(Dependencies{})
	cmd.SetIn(inputReader)
	cmd.SetOut(io.Discard)
	sess := &chatSession{
		cmd:         cmd,
		rootContext: rootCtx,
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	done := make(chan error, 1)
	go func() {
		done <- runREPL(sess)
	}()

	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("runREPL() error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		_ = inputWriter.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
		t.Fatal("runREPL() did not return after root context cancellation")
	}
	_ = inputWriter.Close()
}

func TestCancelAndWaitActiveChatTurnWaitsForResultCleanup(t *testing.T) {
	turnCtx, cancelTurn := context.WithCancelCause(context.Background())
	active := &activeChatTurn{cancel: cancelTurn}
	resultCh := make(chan chatTurnResult)
	cleanupDone := make(chan struct{})
	go func() {
		<-turnCtx.Done()
		close(cleanupDone)
		resultCh <- chatTurnResult{turn: active, cause: context.Cause(turnCtx)}
	}()

	returned := make(chan struct{})
	go func() {
		cancelAndWaitActiveChatTurn(active, resultCh)
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("cancelAndWaitActiveChatTurn() did not return")
	}
	select {
	case <-cleanupDone:
	default:
		t.Fatal("cancelAndWaitActiveChatTurn() returned before result cleanup")
	}
}
