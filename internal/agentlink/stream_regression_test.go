package agentlink

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// TestStreamResumeAfterSenderReconnect: the sender's connection drops while the receiver still
// works through chunks the relay forwarded; the sender comes back at once. The receiver's
// acknowledgements of those old chunks belong to the dropped attempt and must not set where the new
// one starts.
func TestStreamResumeAfterSenderReconnect(t *testing.T) {
	for _, route := range []string{"in process", "websocket"} {
		t.Run(route, func(t *testing.T) {
			for round := 0; round < 3; round++ {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				a := newTestNode(t, "A")
				b, bCache := filesNode(t, "B", nil)
				var got inbox
				b.SetHandler(got.handler(nil))
				relay := NewRelay(nil)
				aCtx, aCancel := context.WithCancel(ctx)
				if route == "in process" {
					attach(t, aCtx, a, relay, "a1")
					attach(t, ctx, b, relay, "b")
				} else {
					wsAttach(t, aCtx, a, relay, "a1")
					wsAttach(t, ctx, b, relay, "b")
				}
				waitFor(t, "streamed route", func() bool { return a.SupportsFileStream(b.InstanceID()) })
				written := slowWrites(t, 40*time.Millisecond)
				data := binaryData(t, 1<<20)
				results := make(chan SendResult, 1)
				go func() {
					res, _ := a.SendWithAttachments(ctx, b.InstanceID(), envelope(""), []Attachment{openAttachment(t, writeFile(t, "big.bin", data))}, 1, 30*time.Second)
					results <- res
				}()
				waitFor(t, "some bytes received", func() bool {
					st, _ := receiving(b)
					return st.Bytes >= 2*streamChunkSize
				})
				aCancel()
				waitFor(t, "the sender left the relay", func() bool {
					for _, p := range relay.Members() {
						if p.InstanceID == a.InstanceID() {
							return false
						}
					}
					return true
				})
				if route == "in process" {
					attach(t, ctx, a, relay, "a2")
				} else {
					wsAttach(t, ctx, a, relay, "a2")
				}
				select {
				case res := <-results:
					if res.Status != StatusDelivered {
						t.Fatalf("round %d: result = %+v", round, res)
					}
				case <-time.After(20 * time.Second):
					t.Fatalf("round %d: no result", round)
				}
				saved, _ := os.ReadFile(got.last().Attachments[0].Path)
				if !bytes.Equal(saved, data) {
					t.Fatalf("round %d: the resumed file differs", round)
				}
				if written.Load() != int64(len(data)) {
					t.Fatalf("round %d: wrote %d bytes for a %d-byte file", round, written.Load(), len(data))
				}
				if files := inboxFiles(t, bCache); len(files) != 1 || got.count() != 1 {
					t.Fatalf("round %d: inbox = %v, delivered %d", round, files, got.count())
				}
				waitFor(t, "relay released the chunks", func() bool { return relay.StreamBytes() == 0 })
				cancel()
			}
		})
	}
}

func attemptChunk(attempt, transferID string, offset int64, data []byte) Frame {
	return Frame{Type: FrameChunk, Chunk: &Chunk{TransferID: transferID, Attempt: attempt, Offset: offset, Data: data}}
}

// readExpecting reads frames until one matches, failing on any frame bad reports.
func readExpecting(t *testing.T, ctx context.Context, conn Conn, match func(Frame) bool, bad func(Frame) bool) Frame {
	t.Helper()
	return readUntil(t, ctx, conn, func(f Frame) bool {
		if bad(f) {
			t.Fatalf("unexpected frame %+v", f)
		}
		return match(f)
	})
}

// TestStreamStaleAttemptAtRelay: once a sender delivers a message again, the relay drops what is
// still in flight from the attempt before (chunks, acknowledgements, a result) instead of taking it
// for the new attempt's start or failing the transfer for it.
func TestStreamStaleAttemptAtRelay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	relay := NewRelay(nil)
	caps := []string{CapabilityFiles, CapabilityFilesStream}
	receiver := fakeRuntime(t, ctx, relay, newTestNode(t, "B").InstanceID(), caps)
	sender := fakeRuntime(t, ctx, relay, newTestNode(t, "A").InstanceID(), caps)
	waitMember(t, relay, receiver.id)
	waitMember(t, relay, sender.id)
	data := binaryData(t, 3*streamChunkSize)
	msg := streamedMessage(t, "stale-relay", sender.id, receiver.id, data)
	tid := msg.Attachments[0].TransferID
	first, second := newAttemptID(), newAttemptID()
	write := func(conn Conn, f Frame) {
		t.Helper()
		if err := conn.WriteFrame(ctx, f); err != nil {
			t.Fatal(err)
		}
	}
	isDeliver := func(attempt string) func(Frame) bool {
		return func(f Frame) bool { return f.Type == FrameDeliver && f.Attempt == attempt }
	}
	never := func(Frame) bool { return false }

	write(sender.conn, Frame{Type: FrameSend, LeaseID: "lease1", Attempt: first, MessageID: msg.MessageID, Message: &msg})
	readUntil(t, ctx, receiver.conn, isDeliver(first))
	write(receiver.conn, Frame{Type: FrameChunkAck, Attempt: first, MessageID: msg.MessageID, TransferID: tid, Offset: 0})
	readUntil(t, ctx, sender.conn, func(f Frame) bool { return f.Type == FrameChunkAck && f.LeaseID == "lease1" })
	write(sender.conn, attemptChunk(first, tid, 0, data[:streamChunkSize]))
	write(sender.conn, attemptChunk(first, tid, streamChunkSize, data[streamChunkSize:2*streamChunkSize]))
	for i := 0; i < 2; i++ {
		readUntil(t, ctx, receiver.conn, func(f Frame) bool { return f.Type == FrameChunk })
	}

	// The sender delivers again (its lease ran out) while the receiver still answers the first.
	write(sender.conn, Frame{Type: FrameSend, LeaseID: "lease2", Attempt: second, MessageID: msg.MessageID, Message: &msg})
	readUntil(t, ctx, receiver.conn, isDeliver(second))
	write(receiver.conn, Frame{Type: FrameChunkAck, Attempt: first, MessageID: msg.MessageID, TransferID: tid, Offset: streamChunkSize})
	write(receiver.conn, Frame{Type: FrameDeliverResult, Attempt: first, MessageID: msg.MessageID, Status: StatusRejected, Reason: ReasonInvalid})
	write(receiver.conn, Frame{Type: FrameChunkAck, Attempt: second, MessageID: msg.MessageID, TransferID: tid, Offset: 2 * streamChunkSize})
	ack := readExpecting(t, ctx, sender.conn, func(f Frame) bool { return f.Type == FrameChunkAck && f.LeaseID == "lease2" },
		func(f Frame) bool { return f.Type == FrameSendResult })
	if ack.Attempt != second || ack.Offset != 2*streamChunkSize {
		t.Fatalf("the second attempt starts with %+v, want offset %d", ack, 2*streamChunkSize)
	}

	// A chunk of the first attempt still on its way is dropped; the second attempt goes on.
	write(sender.conn, attemptChunk(first, tid, 2*streamChunkSize, data[2*streamChunkSize:]))
	write(sender.conn, attemptChunk(second, tid, 2*streamChunkSize, data[2*streamChunkSize:]))
	chunk := readExpecting(t, ctx, receiver.conn, func(f Frame) bool { return f.Type == FrameChunk },
		func(f Frame) bool { return f.Type == FrameTransferAbort })
	if chunk.Chunk.Attempt != second || chunk.Chunk.Offset != 2*streamChunkSize {
		t.Fatalf("forwarded %+v", chunk.Chunk)
	}
	write(receiver.conn, Frame{Type: FrameChunkAck, Attempt: second, MessageID: msg.MessageID, TransferID: tid, Offset: int64(len(data))})
	write(receiver.conn, Frame{Type: FrameDeliverResult, Attempt: second, MessageID: msg.MessageID, Status: StatusAccepted})
	result := readExpecting(t, ctx, sender.conn, func(f Frame) bool { return f.Type == FrameSendResult }, never)
	if result.LeaseID != "lease2" || result.Status != StatusDelivered {
		t.Fatalf("result = %+v", result)
	}
	if held := relay.StreamBytes(); held != 0 {
		t.Fatalf("relay holds %d bytes", held)
	}

	// A streamed send without an attempt is refused before anything is forwarded.
	other := streamedMessage(t, "no-attempt", sender.id, receiver.id, data)
	write(sender.conn, Frame{Type: FrameSend, LeaseID: "lease3", MessageID: other.MessageID, Message: &other})
	if result := readUntil(t, ctx, sender.conn, func(f Frame) bool { return f.Type == FrameSendResult }); result.Status != StatusRejected || result.Reason != ReasonInvalid {
		t.Fatalf("a send without an attempt = %+v", result)
	}
}

// TestStreamStaleAttemptAtReceiver: after a delivery moves to a new attempt, the receiver ignores
// chunks and aborts of the attempt before: they neither fail the delivery nor remove its partial
// files.
func TestStreamStaleAttemptAtReceiver(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b, bCache := filesNode(t, "B", nil)
	var got inbox
	b.SetHandler(got.handler(nil))
	data := binaryData(t, 3*streamChunkSize)
	msg := streamedMessage(t, "stale-receiver", newTestNode(t, "A").InstanceID(), b.InstanceID(), data)
	tid := msg.Attachments[0].TransferID
	first, second := newAttemptID(), newAttemptID()
	console := oldConsole(t, ctx, b)
	write := func(f Frame) {
		t.Helper()
		if err := console.WriteFrame(ctx, f); err != nil {
			t.Fatal(err)
		}
	}
	isAck := func(attempt string, offset int64) func(Frame) bool {
		return func(f Frame) bool { return f.Type == FrameChunkAck && f.Attempt == attempt && f.Offset == offset }
	}
	isResult := func(f Frame) bool { return f.Type == FrameDeliverResult }

	write(Frame{Type: FrameDeliver, Attempt: first, MessageID: msg.MessageID, Message: &msg})
	readExpecting(t, ctx, console, isAck(first, 0), isResult)
	write(attemptChunk(first, tid, 0, data[:streamChunkSize]))
	readExpecting(t, ctx, console, isAck(first, streamChunkSize), isResult)

	write(Frame{Type: FrameDeliver, Attempt: second, MessageID: msg.MessageID, Message: &msg})
	readExpecting(t, ctx, console, isAck(second, streamChunkSize), isResult)
	// Left over from the first attempt: ignored.
	write(attemptChunk(first, tid, streamChunkSize, data[streamChunkSize:2*streamChunkSize]))
	write(Frame{Type: FrameTransferAbort, Attempt: first, MessageID: msg.MessageID, Status: StatusRejected, Reason: ReasonInvalid})
	write(Frame{Type: FrameTransferAbort, Attempt: first, MessageID: msg.MessageID, Status: StatusUnreachable})
	write(attemptChunk(second, tid, streamChunkSize, data[streamChunkSize:2*streamChunkSize]))
	readExpecting(t, ctx, console, isAck(second, 2*streamChunkSize), isResult)
	write(attemptChunk(second, tid, 2*streamChunkSize, data[2*streamChunkSize:]))
	result := readUntil(t, ctx, console, isResult)
	if result.Status != StatusAccepted || result.Attempt != second {
		t.Fatalf("result = %+v", result)
	}
	saved, _ := os.ReadFile(got.last().Attachments[0].Path)
	if !bytes.Equal(saved, data) || len(partFiles(t, bCache)) != 0 {
		t.Fatalf("saved %d bytes, equal %v, parts %v", len(saved), bytes.Equal(saved, data), partFiles(t, bCache))
	}

	// A streamed delivery without an attempt is refused before any partial file exists.
	other := streamedMessage(t, "no-attempt", msg.From, b.InstanceID(), data)
	write(Frame{Type: FrameDeliver, MessageID: other.MessageID, Message: &other})
	if result := readUntil(t, ctx, console, isResult); result.Status != StatusRejected || result.Reason != ReasonInvalid {
		t.Fatalf("a delivery without an attempt = %+v", result)
	}
	if parts := partFiles(t, bCache); len(parts) != 0 {
		t.Fatalf("partial files = %v", parts)
	}
}

// bigStreamedMessage announces files of the given sizes without the bytes (their digests are not
// checked before the last chunk).
func bigStreamedMessage(t *testing.T, id, from, to string, sizes ...int64) Message {
	t.Helper()
	msg := Message{MessageID: id, From: from, To: to, Hop: 1, Envelope: envelope("")}
	for i, size := range sizes {
		msg.Attachments = append(msg.Attachments, Attachment{
			Filename: "big" + string(rune('0'+i)) + ".bin", MediaType: "application/octet-stream", Size: size,
			SHA256: strings.Repeat("ab", 32), TransferID: newTransferID(),
		})
	}
	if err := msg.Validate(); err != nil {
		t.Fatal(err)
	}
	return msg
}

// TestStreamRoomAfterAuthorization: a delivery the receiver refuses (a sender it does not take files
// from, or one there is no room for) never drops another delivery waiting for a resume.
func TestStreamRoomAfterAuthorization(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	trusted, other := newTestNode(t, "A").InstanceID(), newTestNode(t, "C").InstanceID()
	rogue := newTestNode(t, "Rogue").InstanceID()
	b, bCache := filesNode(t, "B", func(_ context.Context, from string) error {
		if from == rogue {
			return errors.New("not a contact")
		}
		return nil
	})
	b.SetHandler((&inbox{}).handler(nil))
	isResult := func(f Frame) bool { return f.Type == FrameDeliverResult }
	deliver := func(console Conn, msg Message) {
		t.Helper()
		if err := console.WriteFrame(ctx, Frame{Type: FrameDeliver, Attempt: newAttemptID(), MessageID: msg.MessageID, Message: &msg}); err != nil {
			t.Fatal(err)
		}
	}
	held := func() map[string]bool {
		out := map[string]bool{}
		for _, st := range b.Transfers() {
			out[st.MessageID] = true
		}
		return out
	}

	// An authorized delivery of the largest message, with one chunk received, waits for a resume.
	big := bigStreamedMessage(t, "big", trusted, b.InstanceID(), MaxStreamAttachmentBytes, MaxStreamAttachmentBytes, MaxStreamAttachmentBytes, MaxStreamAttachmentBytes)
	firstCtx, closeFirst := context.WithCancel(ctx)
	first := oldConsole(t, firstCtx, b)
	if err := first.WriteFrame(ctx, Frame{Type: FrameDeliver, Attempt: testAttempt, MessageID: big.MessageID, Message: &big}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, first, func(f Frame) bool { return f.Type == FrameChunkAck && f.TransferID == big.Attachments[3].TransferID })
	if err := first.WriteFrame(ctx, chunkFrame(big.Attachments[0].TransferID, 0, make([]byte, streamChunkSize))); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, first, func(f Frame) bool { return f.Type == FrameChunkAck && f.Offset == streamChunkSize })
	closeFirst()
	waitFor(t, "parked", func() bool {
		st, ok := receiving(b)
		return ok && !st.Connected
	})

	// An unauthorized sender announces one byte: refused, and the big delivery keeps its files.
	second := oldConsole(t, ctx, b)
	deliver(second, bigStreamedMessage(t, "rogue", rogue, b.InstanceID(), 1))
	if result := readUntil(t, ctx, second, isResult); result.Status != StatusRejected || result.Reason != ReasonUnauthorized {
		t.Fatalf("the rogue's delivery = %+v, want rejected unauthorized", result)
	}
	if parts := partFiles(t, bCache); len(parts) != 4 || !held()["big"] {
		t.Fatalf("after the rogue: partial files %v, transfers %v", parts, held())
	}

	// A connected delivery of 200 MiB holds the room; a parked one of 10 MiB is all that could go,
	// and is not enough for 100 MiB more: nothing goes.
	b2, b2Cache := filesNode(t, "B2", nil)
	b2.SetHandler((&inbox{}).handler(nil))
	parkedCtx, closeParked := context.WithCancel(ctx)
	parkedConsole := oldConsole(t, parkedCtx, b2)
	small := bigStreamedMessage(t, "parked", trusted, b2.InstanceID(), 10<<20)
	if err := parkedConsole.WriteFrame(ctx, Frame{Type: FrameDeliver, Attempt: newAttemptID(), MessageID: small.MessageID, Message: &small}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, parkedConsole, func(f Frame) bool { return f.Type == FrameChunkAck })
	closeParked()
	waitFor(t, "parked", func() bool {
		st, ok := receiving(b2)
		return ok && !st.Connected
	})
	live := oldConsole(t, ctx, b2)
	deliver(live, bigStreamedMessage(t, "connected", trusted, b2.InstanceID(), 64<<20, 64<<20, 64<<20, 8<<20))
	readUntil(t, ctx, live, func(f Frame) bool { return f.Type == FrameChunkAck && f.MessageID == "connected" })
	deliver(live, bigStreamedMessage(t, "too-big", other, b2.InstanceID(), 64<<20, 36<<20))
	if result := readUntil(t, ctx, live, isResult); result.Status != StatusUnreachable {
		t.Fatalf("a delivery without room = %+v, want unreachable", result)
	}
	transfers := map[string]bool{}
	for _, st := range b2.Transfers() {
		transfers[st.MessageID] = true
	}
	if !transfers["parked"] || !transfers["connected"] || transfers["too-big"] || len(partFiles(t, b2Cache)) != 5 {
		t.Fatalf("transfers %v, partial files %v", transfers, partFiles(t, b2Cache))
	}
}
