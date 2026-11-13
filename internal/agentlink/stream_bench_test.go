package agentlink

import (
	"context"
	"log/slog"
	"runtime"
	"runtime/metrics"
	"sync"
	"testing"
	"time"
)

// BenchmarkRelayFileTransfer2MiB sends a 2 MiB file from one runtime to another through a Console
// relay, every hop a real WebSocket on localhost:
//
//   - old: runtimes and relay as before streamed files: the bytes in the queue entry, base64 in one
//     JSON frame;
//   - inline: runtimes of this version through a relay that does not stream: the file is queued
//     on disk, then read back and sent as in old;
//   - stream: binary chunks.
//
// Besides the time per file it reports
//
//   - peak-heap-MiB: the most heap memory of live and not yet collected objects seen while files
//     were in flight, above what it was before the first send, sampled every 200 µs with
//     runtime/metrics (it misses peaks shorter than that, and includes garbage not yet collected);
//   - B/op and allocs/op (with -benchmem): bytes and objects allocated per file, freed or not.
//
// All three runtimes share the process, so the memory is that of sender, relay and receiver
// together.
func BenchmarkRelayFileTransfer2MiB(b *testing.B) {
	// Logging every transfer would be part of what is measured.
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.DiscardHandler))
	defer slog.SetDefault(previous)
	for _, mode := range []string{"old", "inline", "stream"} {
		b.Run(mode, func(b *testing.B) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			sender := newTestNode(b, "A")
			var receiver *Node
			if mode == "old" {
				sender.mu.Lock()
				sender.noStream = true
				sender.mu.Unlock()
				receiver = oldFilesNode(b, "B")
			} else {
				receiver, _ = filesNode(b, "B", nil)
			}
			var got inbox
			receiver.SetHandler(got.handler(nil))
			relay := NewRelay(nil)
			// A relay that does not stream carries the file inline.
			relay.noStream = mode != "stream"
			wsAttach(b, ctx, sender, relay, "a")
			wsAttach(b, ctx, receiver, relay, "b")
			waitFor(b, "files", func() bool { return sender.SupportsFiles(receiver.InstanceID()) })
			if sender.SupportsFileStream(receiver.InstanceID()) != (mode == "stream") {
				b.Fatalf("streams = %v in mode %s", sender.SupportsFileStream(receiver.InstanceID()), mode)
			}
			attachment := openAttachment(b, writeFile(b, "file.bin", binaryData(b, int(MaxAttachmentBytes))))

			runtime.GC()
			sampler := startHeapSampler()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				res, err := sender.SendWithAttachments(ctx, receiver.InstanceID(), envelope(""), []Attachment{attachment}, 1, 30*time.Second)
				if err != nil || res.Status != StatusDelivered {
					b.Fatalf("send = %+v, %v", res, err)
				}
			}
			b.StopTimer()
			b.ReportMetric(float64(sampler.stop())/(1<<20), "peak-heap-MiB")
		})
	}
}

type heapSampler struct {
	done chan struct{}
	wg   sync.WaitGroup
	base uint64
	peak uint64
}

const heapMetric = "/memory/classes/heap/objects:bytes"

func readHeap() uint64 {
	sample := []metrics.Sample{{Name: heapMetric}}
	metrics.Read(sample)
	return sample[0].Value.Uint64()
}

func startHeapSampler() *heapSampler {
	s := &heapSampler{done: make(chan struct{}), base: readHeap()}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(200 * time.Microsecond)
		defer ticker.Stop()
		for {
			if v := readHeap(); v > s.peak {
				s.peak = v
			}
			select {
			case <-s.done:
				return
			case <-ticker.C:
			}
		}
	}()
	return s
}

// stop returns the peak above the starting heap.
func (s *heapSampler) stop() uint64 {
	close(s.done)
	s.wg.Wait()
	if s.peak < s.base {
		return 0
	}
	return s.peak - s.base
}
