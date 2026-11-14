package agentlink

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// oldFilesNode is a node that takes files the way runtimes did before streamed files: inline only.
func oldFilesNode(t testing.TB, name string) *Node {
	t.Helper()
	node := newTestNode(t, name)
	node.mu.Lock()
	node.noStream = true
	node.mu.Unlock()
	restore, err := node.EnableFiles(filepath.Join(t.TempDir(), "cache"), nil)
	if err != nil {
		t.Fatalf("EnableFiles() error = %v", err)
	}
	t.Cleanup(restore)
	return node
}

// frameCounter counts the frames a relay writes to one runtime and reads from it.
type frameCounter struct {
	Conn
	chunksOut, inlineOut, chunksIn atomic.Int64
}

func (c *frameCounter) WriteFrame(ctx context.Context, frame Frame) error {
	switch {
	case frame.Type == FrameChunk:
		c.chunksOut.Add(1)
	case frame.Message != nil && inlineBytes(frame.Message.Attachments) > 0:
		c.inlineOut.Add(1)
	}
	return c.Conn.WriteFrame(ctx, frame)
}

func (c *frameCounter) ReadFrame(ctx context.Context) (Frame, error) {
	frame, err := c.Conn.ReadFrame(ctx)
	if err == nil && frame.Type == FrameChunk {
		c.chunksIn.Add(1)
	}
	return frame, err
}

// wsAttach connects node to relay over a real WebSocket, as a Console reaches a remote runtime, and
// returns the relay's end of it.
func wsAttach(t testing.TB, ctx context.Context, node *Node, relay *Relay, label string) *frameCounter {
	t.Helper()
	server := httptest.NewServer(node.WebSocketHandler(nil))
	t.Cleanup(server.Close)
	conn, err := Dial(ctx, server.URL, "token")
	if err != nil {
		t.Fatal(err)
	}
	counter := &frameCounter{Conn: conn}
	go func() { _ = relay.Serve(ctx, counter, label) }()
	return counter
}

// writeFile writes data to a new file in a temporary folder and returns its path.
func writeFile(t testing.TB, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func openAttachment(t testing.TB, path string) Attachment {
	t.Helper()
	a, err := OpenAttachmentFile(path, filepath.Base(path), -1, "")
	if err != nil {
		t.Fatalf("OpenAttachmentFile() error = %v", err)
	}
	return a
}

// hookWrites replaces how received bytes reach their file for the rest of the test.
func hookWrites(t testing.TB, fn func(f *os.File, data []byte) error) {
	t.Helper()
	previous := writeAttachmentData
	writeAttachmentData = fn
	t.Cleanup(func() { writeAttachmentData = previous })
}

// slowWrites makes every write of received bytes take delay, and counts the bytes written.
func slowWrites(t testing.TB, delay time.Duration) *atomic.Int64 {
	t.Helper()
	var written atomic.Int64
	previous := writeAttachmentData
	hookWrites(t, func(f *os.File, data []byte) error {
		time.Sleep(delay)
		written.Add(int64(len(data)))
		return previous(f, data)
	})
	return &written
}

func receiving(node *Node) (TransferStatus, bool) {
	for _, st := range node.Transfers() {
		if st.Direction == "receive" {
			return st, true
		}
	}
	return TransferStatus{}, false
}

func partFiles(t testing.TB, dir string) []string {
	t.Helper()
	var parts []string
	for _, path := range inboxFiles(t, dir) {
		if strings.HasPrefix(filepath.Base(path), partialFilePrefix) {
			parts = append(parts, path)
		}
	}
	return parts
}

func peakStream(relay *Relay) int64 {
	relay.mu.Lock()
	defer relay.mu.Unlock()
	return relay.peakStreamBytes
}

func TestStreamTransfer(t *testing.T) {
	sizes := []struct {
		name string
		size int
	}{
		{"binary", 300<<10 + 7},
		{"empty", 0},
		{"exactly one chunk", streamChunkSize},
		{"one byte over a chunk", streamChunkSize + 1},
		{"over the inline limit", int(MaxAttachmentBytes) + 1},
		{"largest", int(MaxStreamAttachmentBytes)},
	}
	for _, route := range []string{"in process", "websocket"} {
		t.Run(route, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			a := newTestNode(t, "A")
			b, bCache := filesNode(t, "B", nil)
			var got inbox
			b.SetHandler(got.handler(nil))
			var relay *Relay
			var toB *frameCounter
			if route == "in process" {
				relay = linked(t, ctx, a, b)
			} else {
				relay = NewRelay(nil)
				wsAttach(t, ctx, a, relay, "a")
				toB = wsAttach(t, ctx, b, relay, "b")
			}
			waitFor(t, "streamed route", func() bool { return a.SupportsFileStream(b.InstanceID()) })
			if limit := a.FileLimit(b.InstanceID()); !limit.Streamed || limit.PerFile != MaxStreamAttachmentBytes {
				t.Fatalf("FileLimit() = %+v", limit)
			}
			for _, tc := range sizes {
				t.Run(tc.name, func(t *testing.T) {
					data := binaryData(t, tc.size)
					attachment := openAttachment(t, writeFile(t, "file.bin", data))
					res, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{attachment}, 1, 60*time.Second)
					if err != nil || res.Status != StatusDelivered {
						t.Fatalf("SendWithAttachments() = %+v, %v; want delivered", res, err)
					}
					received := got.last().Attachments[0]
					saved, err := os.ReadFile(received.Path)
					if err != nil || !bytes.Equal(saved, data) {
						t.Fatalf("saved %d bytes of %d, equal %v: %v", len(saved), len(data), bytes.Equal(saved, data), err)
					}
					if received.Size != int64(tc.size) || received.SHA256 != attachment.SHA256 || received.Filename != "file.bin" {
						t.Fatalf("received = %+v", received)
					}
					if info, _ := os.Stat(received.Path); info.Mode().Perm() != 0o600 {
						t.Fatalf("mode = %v", info.Mode().Perm())
					}
					if parts := partFiles(t, bCache); len(parts) != 0 {
						t.Fatalf("partial files left: %v", parts)
					}
					if _, err := os.Stat(a.filesDir(res.MessageID)); !errors.Is(err, os.ErrNotExist) {
						t.Fatalf("the queued copy stays after delivery: %v", err)
					}
				})
			}
			if peak := peakStream(relay); peak <= 0 || peak > streamWindow*streamChunkSize {
				t.Fatalf("relay held up to %d streamed bytes, want 1..%d", peak, streamWindow*streamChunkSize)
			}
			if toB != nil {
				if toB.chunksOut.Load() == 0 || toB.inlineOut.Load() != 0 {
					t.Fatalf("frames to B: %d binary chunks, %d inline files; want chunks only", toB.chunksOut.Load(), toB.inlineOut.Load())
				}
			}
			waitFor(t, "relay released the chunks", func() bool { return relay.StreamBytes() == 0 })
		})
	}
}

func TestStreamInterleavesTextFrames(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, _ := filesNode(t, "A", nil)
	b, _ := filesNode(t, "B", nil)
	var gotA, gotB inbox
	a.SetHandler(gotA.handler(nil))
	b.SetHandler(gotB.handler(nil))
	relay := NewRelay(nil)
	wsAttach(t, ctx, a, relay, "a")
	wsAttach(t, ctx, b, relay, "b")
	waitFor(t, "streamed route", func() bool { return a.SupportsFileStream(b.InstanceID()) })
	// 64 chunks of 10 ms each: the file takes at least 640 ms to arrive.
	slowWrites(t, 10*time.Millisecond)
	data := binaryData(t, 64*streamChunkSize)
	results := make(chan SendResult, 1)
	go func() {
		res, _ := a.SendWithAttachments(ctx, b.InstanceID(), envelope("big"), []Attachment{openAttachment(t, writeFile(t, "big.bin", data))}, 1, 30*time.Second)
		results <- res
	}()
	waitFor(t, "the transfer under way", func() bool {
		st, ok := receiving(b)
		return ok && st.Bytes > 0
	})
	for i := 0; i < 3; i++ {
		if res, err := a.Send(ctx, b.InstanceID(), envelope("text to b"), 1, 5*time.Second); err != nil || res.Status != StatusDelivered {
			t.Fatalf("text to b = %+v, %v", res, err)
		}
		if res, err := b.Send(ctx, a.InstanceID(), envelope("text to a"), 1, 5*time.Second); err != nil || res.Status != StatusDelivered {
			t.Fatalf("text to a = %+v, %v", res, err)
		}
	}
	st, ok := receiving(b)
	if !ok || st.Bytes >= st.Size {
		t.Fatalf("the transfer ended before the text messages went: %+v %v", st, ok)
	}
	if gotB.count() != 3 || gotA.count() != 3 {
		t.Fatalf("delivered %d to b and %d to a while the file streamed", gotB.count(), gotA.count())
	}
	if res := <-results; res.Status != StatusDelivered {
		t.Fatalf("file = %+v", res)
	}
	if peak := peakStream(relay); peak > streamWindow*streamChunkSize {
		t.Fatalf("relay held up to %d streamed bytes, more than its window of %d", peak, streamWindow*streamChunkSize)
	}
}

func TestStreamResume(t *testing.T) {
	t.Run("after the receiver's connection drops", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a := newTestNode(t, "A")
		b, bCache := filesNode(t, "B", nil)
		var got inbox
		b.SetHandler(got.handler(nil))
		relay := NewRelay(nil)
		attach(t, ctx, a, relay, "a")
		disconnect, _ := attach(t, ctx, b, relay, "b1")
		waitFor(t, "streamed route", func() bool { return a.SupportsFileStream(b.InstanceID()) })
		written := slowWrites(t, 3*time.Millisecond)
		data := binaryData(t, 4<<20)
		results := make(chan SendResult, 1)
		go func() {
			res, _ := a.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "big.bin", data))}, 1, 30*time.Second)
			results <- res
		}()
		waitFor(t, "a megabyte received", func() bool {
			st, _ := receiving(b)
			return st.Bytes >= 1<<20
		})
		disconnect()
		waitFor(t, "the transfer waits for a resume", func() bool {
			st, ok := receiving(b)
			return ok && !st.Connected
		})
		held, _ := receiving(b)
		attach(t, ctx, b, relay, "b2")
		if res := <-results; res.Status != StatusDelivered {
			t.Fatalf("result = %+v", res)
		}
		saved, _ := os.ReadFile(got.last().Attachments[0].Path)
		if !bytes.Equal(saved, data) {
			t.Fatal("the resumed file differs")
		}
		// Each byte was written once: the second delivery went on from what the receiver held.
		if written.Load() != int64(len(data)) || held.Bytes == 0 {
			t.Fatalf("wrote %d bytes for a %d-byte file (held %d at the drop)", written.Load(), len(data), held.Bytes)
		}
		if files := inboxFiles(t, bCache); len(files) != 1 || got.count() != 1 {
			t.Fatalf("inbox = %v, delivered %d; want one file once", files, got.count())
		}
		// Delivered again (a lost confirmation): accepted, nothing saved.
		msg := got.last()
		msg.Attachments = append([]Attachment(nil), msg.Attachments...)
		msg.Attachments[0].Path, msg.Attachments[0].Ref = "", ""
		if status, _ := deliverDirect(t, ctx, b, msg); status != StatusAccepted {
			t.Fatalf("redelivery = %s", status)
		}
		if files := inboxFiles(t, bCache); len(files) != 1 || got.count() != 1 {
			t.Fatalf("after a redelivery: inbox = %v, delivered %d", files, got.count())
		}
	})

	t.Run("after the sender restarts", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		dir := t.TempDir()
		a, err := NewNode(Options{StateDir: dir, LeaseTimeout: 200 * time.Millisecond})
		if err != nil {
			t.Fatal(err)
		}
		a.retryBase = 10 * time.Millisecond
		b, _ := filesNode(t, "B", nil)
		var got inbox
		b.SetHandler(got.handler(nil))
		relay := NewRelay(nil)
		aCtx, aCancel := context.WithCancel(ctx)
		attach(t, aCtx, a, relay, "a1")
		attach(t, ctx, b, relay, "b")
		waitFor(t, "streamed route", func() bool { return a.SupportsFileStream(b.InstanceID()) })
		written := slowWrites(t, 3*time.Millisecond)
		data := binaryData(t, 4<<20)
		if _, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "big.bin", data))}, 1, 0); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "a megabyte received", func() bool {
			st, _ := receiving(b)
			return st.Bytes >= 1<<20
		})
		aCancel()
		a.Close()
		waitFor(t, "the transfer waits for a resume", func() bool {
			st, ok := receiving(b)
			return ok && !st.Connected
		})
		reopened, err := NewNode(Options{StateDir: dir, LeaseTimeout: 200 * time.Millisecond})
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		attach(t, ctx, reopened, relay, "a2")
		waitFor(t, "delivery after the restart", func() bool { return got.count() == 1 })
		saved, _ := os.ReadFile(got.last().Attachments[0].Path)
		if !bytes.Equal(saved, data) || written.Load() != int64(len(data)) {
			t.Fatalf("equal %v, wrote %d bytes for %d", bytes.Equal(saved, data), written.Load(), len(data))
		}
	})
}

// streamedMessage is a message announcing files to stream, for a test that sends the chunks itself.
func streamedMessage(t testing.TB, id, from, to string, files ...[]byte) Message {
	t.Helper()
	msg := Message{MessageID: id, From: from, To: to, Hop: 1, Envelope: envelope("")}
	for i, data := range files {
		sum := sha256.Sum256(data)
		msg.Attachments = append(msg.Attachments, Attachment{
			Filename: "f" + string(rune('0'+i)) + ".bin", MediaType: "application/octet-stream", Size: int64(len(data)),
			SHA256: hex.EncodeToString(sum[:]), TransferID: newTransferID(),
		})
	}
	if err := msg.Validate(); err != nil {
		t.Fatal(err)
	}
	return msg
}

// testAttempt is the attempt of the deliveries a test makes itself.
const testAttempt = "0123456789abcdef0123456789abcdef"

func chunkFrame(transferID string, offset int64, data []byte) Frame {
	return Frame{Type: FrameChunk, Chunk: &Chunk{TransferID: transferID, Attempt: testAttempt, Offset: offset, Data: data}}
}

// readUntil reads frames until one matches.
func readUntil(t testing.TB, ctx context.Context, conn Conn, match func(Frame) bool) Frame {
	t.Helper()
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		frame, err := conn.ReadFrame(readCtx)
		if err != nil {
			t.Fatalf("no matching frame: %v", err)
		}
		if match(frame) {
			return frame
		}
	}
}

func TestStreamRejectsBadChunks(t *testing.T) {
	big := binaryData(t, 3*streamChunkSize)
	corrupt := append([]byte(nil), big[:streamChunkSize]...)
	corrupt[10] ^= 0xff
	type step struct {
		file   int
		offset int64
		data   []byte
	}
	cases := map[string][]step{
		"out of order":  {{0, streamChunkSize, big[streamChunkSize : 2*streamChunkSize]}},
		"oversized":     {{0, 0, binaryData(t, streamChunkSize+1)}},
		"short":         {{0, 0, big[:100]}},
		"corrupt":       {{0, 0, corrupt}, {0, streamChunkSize, big[streamChunkSize : 2*streamChunkSize]}, {0, 2 * streamChunkSize, big[2*streamChunkSize:]}},
		"past the size": {{1, 0, []byte("small")}, {1, 5, []byte("x")}},
	}

	t.Run("by the receiver", func(t *testing.T) {
		for name, steps := range cases {
			t.Run(name, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				b, bCache := filesNode(t, "B", nil)
				var got inbox
				b.SetHandler(got.handler(nil))
				msg := streamedMessage(t, "m-"+strings.ReplaceAll(name, " ", "-"), newTestNode(t, "A").InstanceID(), b.InstanceID(), big, []byte("small"))
				console := oldConsole(t, ctx, b)
				if err := console.WriteFrame(ctx, Frame{Type: FrameDeliver, Attempt: testAttempt, MessageID: msg.MessageID, Message: &msg}); err != nil {
					t.Fatal(err)
				}
				readUntil(t, ctx, console, func(f Frame) bool { return f.Type == FrameChunkAck && f.TransferID == msg.Attachments[1].TransferID })
				if parts := partFiles(t, bCache); len(parts) != 2 {
					t.Fatalf("partial files before the chunks = %v", parts)
				}
				for _, s := range steps {
					if err := console.WriteFrame(ctx, chunkFrame(msg.Attachments[s.file].TransferID, s.offset, s.data)); err != nil {
						t.Fatal(err)
					}
				}
				result := readUntil(t, ctx, console, func(f Frame) bool { return f.Type == FrameDeliverResult })
				if result.Status != StatusRejected || result.Reason != ReasonInvalid {
					t.Fatalf("result = %s %s, want rejected invalid_message", result.Status, result.Reason)
				}
				if files := inboxFiles(t, bCache); len(files) != 0 || got.count() != 0 {
					t.Fatalf("files = %v, delivered %d", files, got.count())
				}
				if _, ok := receiving(b); ok {
					t.Fatal("the rejected transfer is still listed")
				}
			})
		}
	})

	t.Run("by the relay", func(t *testing.T) {
		relayCases := map[string][]step{
			"out of order":  cases["out of order"],
			"oversized":     cases["oversized"],
			"short":         cases["short"],
			"past the size": cases["past the size"],
		}
		for name, steps := range relayCases {
			t.Run(name, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				relay := NewRelay(nil)
				b, bCache := filesNode(t, "B", nil)
				var got inbox
				b.SetHandler(got.handler(nil))
				attach(t, ctx, b, relay, "b")
				waitMember(t, relay, b.InstanceID())
				rogue := fakeRuntime(t, ctx, relay, newTestNode(t, "Rogue").InstanceID(), []string{CapabilityFiles, CapabilityFilesStream})
				msg := streamedMessage(t, "r-"+strings.ReplaceAll(name, " ", "-"), rogue.id, b.InstanceID(), big, []byte("small"))
				if err := rogue.conn.WriteFrame(ctx, Frame{Type: FrameSend, LeaseID: "lease", Attempt: testAttempt, MessageID: msg.MessageID, Message: &msg}); err != nil {
					t.Fatal(err)
				}
				readUntil(t, ctx, rogue.conn, func(f Frame) bool { return f.Type == FrameChunkAck && f.TransferID == msg.Attachments[1].TransferID })
				for _, s := range steps {
					if err := rogue.conn.WriteFrame(ctx, chunkFrame(msg.Attachments[s.file].TransferID, s.offset, s.data)); err != nil {
						t.Fatal(err)
					}
				}
				result := readUntil(t, ctx, rogue.conn, func(f Frame) bool { return f.Type == FrameSendResult })
				if result.Status != StatusRejected || result.Reason != ReasonInvalid || result.LeaseID != "lease" {
					t.Fatalf("result = %+v, want rejected invalid_message", result)
				}
				waitFor(t, "the receiver removed its partial files", func() bool {
					_, ok := receiving(b)
					return !ok && len(inboxFiles(t, bCache)) == 0
				})
				if got.count() != 0 || relay.StreamBytes() != 0 {
					t.Fatalf("delivered %d, relay holds %d bytes", got.count(), relay.StreamBytes())
				}
			})
		}
	})

	t.Run("a sender past its window", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		relay := NewRelay(nil)
		b, bCache := filesNode(t, "B", nil)
		b.SetHandler((&inbox{}).handler(nil))
		attach(t, ctx, b, relay, "b")
		waitMember(t, relay, b.InstanceID())
		rogue := fakeRuntime(t, ctx, relay, newTestNode(t, "Rogue").InstanceID(), []string{CapabilityFiles, CapabilityFilesStream})
		data := binaryData(t, 8*streamChunkSize)
		msg := streamedMessage(t, "w1", rogue.id, b.InstanceID(), data)
		if err := rogue.conn.WriteFrame(ctx, Frame{Type: FrameSend, LeaseID: "lease", Attempt: testAttempt, MessageID: msg.MessageID, Message: &msg}); err != nil {
			t.Fatal(err)
		}
		readUntil(t, ctx, rogue.conn, func(f Frame) bool { return f.Type == FrameChunkAck })
		// The receiver stops writing, so nothing is acknowledged while the rogue keeps sending.
		release := make(chan struct{})
		var once sync.Once
		defer once.Do(func() { close(release) })
		hookWrites(t, func(f *os.File, d []byte) error {
			<-release
			_, err := f.Write(d)
			return err
		})
		for i := 0; i <= streamWindow; i++ {
			off := int64(i * streamChunkSize)
			if err := rogue.conn.WriteFrame(ctx, chunkFrame(msg.Attachments[0].TransferID, off, data[off:off+streamChunkSize])); err != nil {
				t.Fatal(err)
			}
		}
		result := readUntil(t, ctx, rogue.conn, func(f Frame) bool { return f.Type == FrameSendResult })
		if result.Status != StatusRejected || result.Reason != ReasonInvalid {
			t.Fatalf("result = %+v", result)
		}
		if peak := peakStream(relay); peak > streamWindow*streamChunkSize {
			t.Fatalf("relay held %d bytes, more than its window", peak)
		}
		once.Do(func() { close(release) })
		waitFor(t, "the receiver removed its partial file", func() bool {
			_, ok := receiving(b)
			return !ok && len(inboxFiles(t, bCache)) == 0
		})
	})

	t.Run("malformed binary frames", func(t *testing.T) {
		for name, raw := range map[string][]byte{
			"empty":         {},
			"header only":   make([]byte, chunkHeaderSize),
			"wrong version": append([]byte{9, chunkKindData}, make([]byte, chunkHeaderSize)...),
			"too large":     make([]byte, maxChunkFrame+1),
		} {
			if _, err := decodeChunk(raw); err == nil {
				t.Errorf("%s: decoded", name)
			}
		}
		c := &Chunk{TransferID: newTransferID(), Attempt: newAttemptID(), Offset: 12345, Data: []byte("data")}
		raw, err := encodeChunk(c)
		if err != nil {
			t.Fatal(err)
		}
		back, err := decodeChunk(raw)
		if err != nil || back.TransferID != c.TransferID || back.Attempt != c.Attempt || back.Offset != c.Offset || string(back.Data) != "data" {
			t.Fatalf("round trip = %+v, %v", back, err)
		}
	})
}

func TestStreamFallback(t *testing.T) {
	small := binaryData(t, 1<<20)
	large := binaryData(t, int(MaxAttachmentBytes)+1)

	t.Run("a new runtime sends inline to an old one", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a := newTestNode(t, "A")
		old := oldFilesNode(t, "Old")
		var got inbox
		old.SetHandler(got.handler(nil))
		relay := NewRelay(nil)
		wsAttach(t, ctx, a, relay, "a")
		toOld := wsAttach(t, ctx, old, relay, "old")
		waitFor(t, "files", func() bool { return a.SupportsFiles(old.InstanceID()) })
		if a.SupportsFileStream(old.InstanceID()) || a.FileLimit(old.InstanceID()).Streamed {
			t.Fatal("an old runtime is listed as streaming")
		}
		res, err := a.SendWithAttachments(ctx, old.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "small.bin", small))}, 1, 10*time.Second)
		if err != nil || res.Status != StatusDelivered {
			t.Fatalf("send = %+v, %v", res, err)
		}
		saved, _ := os.ReadFile(got.last().Attachments[0].Path)
		if !bytes.Equal(saved, small) {
			t.Fatal("bytes differ")
		}
		_, err = a.SendWithAttachments(ctx, old.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "large.bin", large))}, 1, time.Second)
		if !errors.Is(err, ErrFileTooLarge) || !strings.Contains(err.Error(), "does not stream") {
			t.Fatalf("a large file to an old runtime: error = %v", err)
		}
		if toOld.chunksOut.Load() != 0 || toOld.inlineOut.Load() != 1 {
			t.Fatalf("the old runtime got %d binary frames and %d inline files", toOld.chunksOut.Load(), toOld.inlineOut.Load())
		}
	})

	t.Run("an old runtime sends inline to a new one", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		old := oldFilesNode(t, "Old")
		b, _ := filesNode(t, "B", nil)
		var got inbox
		b.SetHandler(got.handler(nil))
		relay := NewRelay(nil)
		fromOld := wsAttach(t, ctx, old, relay, "old")
		toB := wsAttach(t, ctx, b, relay, "b")
		waitFor(t, "files", func() bool { return old.SupportsFiles(b.InstanceID()) })
		res, err := old.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "small.bin", small))}, 1, 10*time.Second)
		if err != nil || res.Status != StatusDelivered {
			t.Fatalf("send = %+v, %v", res, err)
		}
		saved, _ := os.ReadFile(got.last().Attachments[0].Path)
		if !bytes.Equal(saved, small) || fromOld.chunksIn.Load() != 0 || toB.chunksOut.Load() != 0 {
			t.Fatalf("equal %v, chunks %d/%d", bytes.Equal(saved, small), fromOld.chunksIn.Load(), toB.chunksOut.Load())
		}
	})

	t.Run("new runtimes through an old Console", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a := newTestNode(t, "A")
		b, _ := filesNode(t, "B", nil)
		var got inbox
		b.SetHandler(got.handler(nil))
		relay := NewRelay(nil)
		relay.noStream = true
		wsAttach(t, ctx, a, relay, "a")
		toB := wsAttach(t, ctx, b, relay, "b")
		waitFor(t, "files", func() bool { return a.SupportsFiles(b.InstanceID()) })
		if a.SupportsFileStream(b.InstanceID()) {
			t.Fatal("an old Console is listed as streaming")
		}
		res, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "small.bin", small))}, 1, 10*time.Second)
		if err != nil || res.Status != StatusDelivered {
			t.Fatalf("send = %+v, %v", res, err)
		}
		saved, _ := os.ReadFile(got.last().Attachments[0].Path)
		if !bytes.Equal(saved, small) || toB.chunksOut.Load() != 0 {
			t.Fatalf("equal %v, chunks %d", bytes.Equal(saved, small), toB.chunksOut.Load())
		}
		if _, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "large.bin", large))}, 1, time.Second); !errors.Is(err, ErrFileTooLarge) {
			t.Fatalf("a large file through an old Console: error = %v", err)
		}
		// One that ignores the roster and streams anyway is refused, as an old Console would.
		rogue := fakeRuntime(t, ctx, relay, newTestNode(t, "Rogue").InstanceID(), []string{CapabilityFiles, CapabilityFilesStream})
		msg := streamedMessage(t, "old-1", rogue.id, b.InstanceID(), []byte("x"))
		if status, reason := rogue.send(t, ctx, msg); status != StatusRejected || reason != ReasonInvalid {
			t.Fatalf("streamed through an old Console = %s %s", status, reason)
		}
	})

	t.Run("a queued large file finds only a route that does not stream", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a := newTestNode(t, "A")
		old := oldFilesNode(t, "Old")
		res, err := a.SendWithAttachments(ctx, old.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "large.bin", large))}, 1, 0)
		if err != nil || res.Status != StatusQueued {
			t.Fatalf("queued = %+v, %v", res, err)
		}
		results := make(chan SendResult, 1)
		a.mu.Lock()
		a.waiters[res.MessageID] = append(a.waiters[res.MessageID], results)
		a.mu.Unlock()
		linked(t, ctx, a, old)
		select {
		case res := <-results:
			if res.Status != StatusRejected || res.Reason != ReasonFilesUnsupported {
				t.Fatalf("result = %+v", res)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no result")
		}
	})
}

func TestStreamQueue(t *testing.T) {
	t.Run("the queue keeps its own copy", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a := newTestNode(t, "A")
		b, _ := filesNode(t, "B", nil)
		var got inbox
		b.SetHandler(got.handler(nil))
		original := binaryData(t, 200<<10)
		path := writeFile(t, "doc.bin", original)
		res, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{openAttachment(t, path)}, 1, 0)
		if err != nil || res.Status != StatusQueued {
			t.Fatalf("queued = %+v, %v", res, err)
		}
		if err := os.WriteFile(path, bytes.Repeat([]byte("changed"), 1000), 0o600); err != nil {
			t.Fatal(err)
		}
		linked(t, ctx, a, b)
		waitFor(t, "delivery", func() bool { return got.count() == 1 })
		saved, _ := os.ReadFile(got.last().Attachments[0].Path)
		if !bytes.Equal(saved, original) {
			t.Fatal("the change to the source after queuing reached the peer")
		}
		waitFor(t, "the queued copy removed", func() bool {
			_, err := os.Stat(a.filesDir(res.MessageID))
			return errors.Is(err, os.ErrNotExist)
		})
		raw, _ := os.ReadFile(a.entryPath(res.MessageID))
		if bytes.Contains(raw, []byte(`"data"`)) {
			t.Fatal("the queue entry holds file bytes")
		}
	})

	t.Run("a source that changed after the check is refused", func(t *testing.T) {
		a := newTestNode(t, "A")
		path := writeFile(t, "doc.bin", []byte("original"))
		attachment := openAttachment(t, path)
		if err := os.WriteFile(path, []byte("tampered"), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := a.SendWithAttachments(context.Background(), newTestNode(t, "B").InstanceID(), envelope(""), []Attachment{attachment}, 1, 0)
		if err == nil || !strings.Contains(err.Error(), "changed") {
			t.Fatalf("error = %v", err)
		}
		if items, _ := os.ReadDir(a.filesRoot()); len(items) != 0 {
			t.Fatalf("queued copies left: %v", items)
		}
		a.mu.Lock()
		queued := a.queuedFileBytes
		a.mu.Unlock()
		if queued != 0 {
			t.Fatalf("queue holds %d bytes after a refused send", queued)
		}
	})

	t.Run("limits", func(t *testing.T) {
		a := newTestNode(t, "A")
		to := newTestNode(t, "B").InstanceID()
		huge := filepath.Join(t.TempDir(), "huge.bin")
		f, _ := os.Create(huge)
		_ = f.Truncate(MaxStreamAttachmentBytes + 1)
		_ = f.Close()
		if _, err := OpenAttachmentFile(huge, "huge.bin", -1, ""); !errors.Is(err, ErrFileTooLarge) {
			t.Fatalf("a file over the streamed limit: error = %v", err)
		}
		one := mustAttachment(t, "a.txt", []byte("a"))
		if _, err := a.SendWithAttachments(context.Background(), to, envelope(""), []Attachment{one, one, one, one, one}, 1, 0); err == nil {
			t.Fatal("five files went")
		}
		oversized := one
		oversized.Size = MaxStreamAttachmentBytes + 1
		if _, err := a.SendWithAttachments(context.Background(), to, envelope(""), []Attachment{oversized}, 1, 0); !errors.Is(err, ErrFileTooLarge) || !strings.Contains(err.Error(), "streamed") {
			t.Fatalf("an oversized file: error = %v", err)
		}
	})
}

func TestStreamInboundBounds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b, bCache := filesNode(t, "B", nil)
	b.SetHandler((&inbox{}).handler(nil))
	from := newTestNode(t, "A").InstanceID()
	start := func(console Conn, id string) Message {
		msg := streamedMessage(t, id, from, b.InstanceID(), make([]byte, 1000))
		if err := console.WriteFrame(ctx, Frame{Type: FrameDeliver, Attempt: testAttempt, MessageID: id, Message: &msg}); err != nil {
			t.Fatal(err)
		}
		return msg
	}
	connCtx, closeConsole := context.WithCancel(ctx)
	console := oldConsole(t, connCtx, b)
	for i := 0; i < maxInboundStreams; i++ {
		start(console, "held-"+string(rune('0'+i)))
		readUntil(t, ctx, console, func(f Frame) bool { return f.Type == FrameChunkAck })
	}
	// All four are connected: a fifth waits.
	other := oldConsole(t, ctx, b)
	msg := start(other, "fifth")
	if result := readUntil(t, ctx, other, func(f Frame) bool { return f.Type == FrameDeliverResult }); result.Status != StatusUnreachable {
		t.Fatalf("a fifth delivery = %+v, want unreachable", result)
	}
	// Once they wait for a resume, the oldest make room.
	closeConsole()
	waitFor(t, "parked", func() bool {
		for _, st := range b.Transfers() {
			if st.Connected {
				return false
			}
		}
		return true
	})
	if err := other.WriteFrame(ctx, Frame{Type: FrameDeliver, Attempt: testAttempt, MessageID: msg.MessageID, Message: &msg}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, other, func(f Frame) bool { return f.Type == FrameChunkAck && f.MessageID == "fifth" })
	if transfers := b.Transfers(); len(transfers) != maxInboundStreams {
		t.Fatalf("transfers = %+v", transfers)
	}
	if parts := partFiles(t, bCache); len(parts) != maxInboundStreams {
		t.Fatalf("partial files = %v, want the evicted one removed", parts)
	}
}

func TestStreamSeveralFiles(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a := newTestNode(t, "A")
	b, bCache := filesNode(t, "B", nil)
	var got inbox
	b.SetHandler(got.handler(nil))
	relay := NewRelay(nil)
	wsAttach(t, ctx, a, relay, "a")
	wsAttach(t, ctx, b, relay, "b")
	waitFor(t, "streamed route", func() bool { return a.SupportsFileStream(b.InstanceID()) })
	contents := [][]byte{binaryData(t, 3<<20), {}, binaryData(t, streamChunkSize), binaryData(t, 10)}
	attachments := make([]Attachment, 0, len(contents))
	for i, data := range contents {
		attachments = append(attachments, openAttachment(t, writeFile(t, "f"+string(rune('0'+i))+".bin", data)))
	}
	res, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope("four files"), attachments, 1, 30*time.Second)
	if err != nil || res.Status != StatusDelivered {
		t.Fatalf("send = %+v, %v", res, err)
	}
	msg := got.last()
	if len(msg.Attachments) != len(contents) || msg.Envelope.Text != "four files" {
		t.Fatalf("delivered = %+v", msg)
	}
	for i, data := range contents {
		saved, err := os.ReadFile(msg.Attachments[i].Path)
		if err != nil || !bytes.Equal(saved, data) || msg.Attachments[i].Filename != "f"+string(rune('0'+i))+".bin" {
			t.Fatalf("file %d: %d bytes of %d, %v", i, len(saved), len(data), err)
		}
	}
	if files := inboxFiles(t, bCache); len(files) != len(contents) {
		t.Fatalf("inbox = %v", files)
	}
	if notes := AttachmentNotes(msg.Attachments); !strings.Contains(notes, "4 file(s)") || !strings.Contains(notes, "file_cache_dir/agentlink/") {
		t.Fatalf("notes = %q", notes)
	}
}

func TestStreamLegacyQueueEntry(t *testing.T) {
	// A message an older version queued holds its file inline; it still goes, inline.
	dir := t.TempDir()
	node, err := NewNode(Options{StateDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := filesNode(t, "B", nil)
	data := binaryData(t, 4096)
	now := time.Now().UTC()
	entry := outboxEntry{
		Message:   Message{MessageID: "msg_legacy", From: node.InstanceID(), To: b.InstanceID(), Hop: 1, Envelope: envelope(""), Attachments: []Attachment{mustAttachment(t, "old.bin", data)}},
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}
	if err := node.writeEntry(&entry); err != nil {
		t.Fatal(err)
	}
	node.Close()
	reopened, err := NewNode(Options{StateDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.queuedFileBytes != int64(len(data)) {
		t.Fatalf("queued file bytes = %d", reopened.queuedFileBytes)
	}
	var got inbox
	b.SetHandler(got.handler(nil))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	linked(t, ctx, reopened, b)
	waitFor(t, "delivery", func() bool { return got.count() == 1 })
	saved, _ := os.ReadFile(got.last().Attachments[0].Path)
	if !bytes.Equal(saved, data) {
		t.Fatal("bytes differ")
	}
}

func TestReplyFilesLimit(t *testing.T) {
	file := func(name string, size int64) (string, int64, string) {
		data := make([]byte, size)
		sum := sha256.Sum256(data)
		return writeFile(t, name, data), size, hex.EncodeToString(sum[:])
	}
	smallPath, smallSize, smallSum := file("a.bin", 10)
	largePath, largeSize, largeSum := file("b.bin", MaxAttachmentBytes)
	inline := NewReplyFiles("inst_x", t.TempDir())
	defer inline.Close()
	if _, err := inline.AddFile(smallPath, "a.bin", smallSize, smallSum, inlineFileLimit.PerMessage); err != nil {
		t.Fatal(err)
	}
	if _, err := inline.AddFile(largePath, "b.bin", largeSize, largeSum, inlineFileLimit.PerMessage); err == nil || !strings.Contains(err.Error(), "would pass") {
		t.Fatalf("over the inline limit: error = %v", err)
	}
	streamedFiles := NewReplyFiles("inst_x", t.TempDir())
	defer streamedFiles.Close()
	for i := 0; i < MaxAttachments; i++ {
		if _, err := streamedFiles.AddFile(largePath, "b.bin", largeSize, largeSum, streamFileLimit.PerMessage); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := streamedFiles.AddFile(smallPath, "a.bin", smallSize, smallSum, streamFileLimit.PerMessage); err == nil {
		t.Fatal("a fifth file was attached")
	}
}

// TestReplyFilesSnapshot: an answer carries its files as they were when they were attached, from
// private copies that Close removes.
func TestReplyFilesSnapshot(t *testing.T) {
	dir := t.TempDir()
	v1 := []byte("v1,1\n")
	sum := sha256.Sum256(v1)
	digest := hex.EncodeToString(sum[:])
	source := writeFile(t, "report.csv", v1)
	files := NewReplyFiles("inst_x", dir)
	a, err := files.AddFile(source, "report.csv", int64(len(v1)), digest, streamFileLimit.PerMessage)
	if err != nil {
		t.Fatal(err)
	}
	if a.Source == source || a.Size != int64(len(v1)) || a.SHA256 != digest || a.MediaType == "" {
		t.Fatalf("attachment = %+v", a)
	}
	if info, err := os.Stat(a.Source); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("copy: %v, %v", info, err)
	}
	if err := os.WriteFile(source, []byte("v2,22\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(files.Attachments()[0].Source); !bytes.Equal(got, v1) {
		t.Fatalf("the copy changed with its source: %q", got)
	}
	// The source changed after it was checked: refused, and nothing is left behind.
	if _, err := files.AddFile(source, "report.csv", int64(len(v1)), digest, streamFileLimit.PerMessage); err == nil || !strings.Contains(err.Error(), "changed after it was checked") {
		t.Fatalf("a changed file: error = %v", err)
	}
	if len(files.Attachments()) != 1 {
		t.Fatal("a changed file was attached")
	}
	if entries, _ := os.ReadDir(filepath.Dir(a.Source)); len(entries) != 1 {
		t.Fatalf("copies = %v", entries)
	}
	files.Close()
	if _, err := os.Stat(a.Source); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the copy stays after Close: %v", err)
	}
	if _, err := files.AddFile(writeFile(t, "x.csv", v1), "x.csv", int64(len(v1)), digest, streamFileLimit.PerMessage); err == nil {
		t.Fatal("attached after Close")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("left in the folder: %v", entries)
	}
}

func TestStreamChecksBeforeBytes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	t.Run("an unauthorized sender's file is refused before any byte", func(t *testing.T) {
		a := newTestNode(t, "A")
		b, bCache := filesNode(t, "B", func(_ context.Context, from string) error { return errors.New("blocked " + from) })
		var got inbox
		b.SetHandler(got.handler(nil))
		toB := wsAttachPair(t, ctx, a, b)
		res, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "x.bin", binaryData(t, 3<<20)))}, 1, 5*time.Second)
		if err != nil || res.Status != StatusRejected || res.Reason != ReasonUnauthorized {
			t.Fatalf("send = %+v, %v; want rejected unauthorized", res, err)
		}
		if files := inboxFiles(t, bCache); len(files) != 0 || got.count() != 0 || toB.chunksOut.Load() != 0 {
			t.Fatalf("files = %v, delivered %d, chunks %d", files, got.count(), toB.chunksOut.Load())
		}
	})

	t.Run("a runtime without a handler refuses before any byte", func(t *testing.T) {
		a := newTestNode(t, "A")
		b, bCache := filesNode(t, "B", nil)
		toB := wsAttachPair(t, ctx, a, b)
		res, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "x.bin", binaryData(t, 3<<20)))}, 1, 5*time.Second)
		if err != nil || res.Status != StatusRejected || res.Reason != ReasonNoHandler {
			t.Fatalf("send = %+v, %v; want rejected no_handler", res, err)
		}
		if files := inboxFiles(t, bCache); len(files) != 0 || toB.chunksOut.Load() != 0 {
			t.Fatalf("files = %v, chunks %d", files, toB.chunksOut.Load())
		}
	})

	t.Run("a handler that rejects leaves no file", func(t *testing.T) {
		a := newTestNode(t, "A")
		b, bCache := filesNode(t, "B", nil)
		b.SetHandler((&inbox{}).handler(&RejectError{Reason: ReasonHopLimit}))
		wsAttachPair(t, ctx, a, b)
		res, err := a.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "x.bin", binaryData(t, 200<<10)))}, 1, 5*time.Second)
		if err != nil || res.Status != StatusRejected || res.Reason != ReasonHopLimit {
			t.Fatalf("send = %+v, %v; want rejected hop_limit", res, err)
		}
		waitFor(t, "no file left", func() bool { return len(inboxFiles(t, bCache)) == 0 })
	})
}

// wsAttachPair links a and b through a new relay over WebSockets and returns the relay's end to b.
func wsAttachPair(t testing.TB, ctx context.Context, a, b *Node) *frameCounter {
	t.Helper()
	relay := NewRelay(nil)
	wsAttach(t, ctx, a, relay, "a")
	toB := wsAttach(t, ctx, b, relay, "b")
	waitFor(t, "streamed route", func() bool { return a.SupportsFileStream(b.InstanceID()) })
	return toB
}
