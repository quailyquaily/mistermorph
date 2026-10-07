package codemode

import (
	"math"
	"runtime/debug"
	"runtime/metrics"
	"sync"
	"time"
)

const (
	heapObjectsMetric = "/memory/classes/heap/objects:bytes"
	heapAllocsMetric  = "/gc/heap/allocs:bytes"

	// defaultMemoryCeiling applies when the process has no Go memory limit.
	defaultMemoryCeiling = uint64(2 << 30)
	memorySampleInterval = 100 * time.Millisecond
)

// MemoryWatcher samples the process heap while invocations run. moejs keeps no per-runtime
// allocation count, so it can only see the whole process: usage it reports is approximate, and
// when the heap passes the ceiling it stops every running invocation, which may not be the one that
// allocated. It is a safety net, not a quota.
type MemoryWatcher struct {
	interval time.Duration
	ceiling  func() uint64
	read     func() (heap, allocs uint64)

	mu       sync.Mutex
	watching map[*memoryWatch]struct{}
	stop     chan struct{}
}

type memoryWatch struct {
	stop       func()
	startHeap  uint64
	peakHeap   uint64
	startAlloc uint64
}

// NewMemoryWatcher watches against 90% of the Go memory limit when one is set, else 2 GiB.
func NewMemoryWatcher() *MemoryWatcher {
	return &MemoryWatcher{interval: memorySampleInterval, ceiling: processMemoryCeiling, read: readHeap}
}

func processMemoryCeiling() uint64 {
	if limit := debug.SetMemoryLimit(-1); limit > 0 && limit < math.MaxInt64 {
		return uint64(limit) / 10 * 9
	}
	return defaultMemoryCeiling
}

func readHeap() (uint64, uint64) {
	samples := []metrics.Sample{{Name: heapObjectsMetric}, {Name: heapAllocsMetric}}
	metrics.Read(samples)
	return metricValue(samples[0]), metricValue(samples[1])
}

func metricValue(s metrics.Sample) uint64 {
	if s.Value.Kind() == metrics.KindUint64 {
		return s.Value.Uint64()
	}
	return 0
}

// watch registers an invocation until the returned function, which reports its usage, is called.
// stop is called at most once, from the watcher's goroutine, when the ceiling is passed.
func (w *MemoryWatcher) watch(stop func()) func() MemoryUsage {
	heap, allocs := w.read()
	entry := &memoryWatch{stop: stop, startHeap: heap, peakHeap: heap, startAlloc: allocs}
	w.mu.Lock()
	if w.watching == nil {
		w.watching = map[*memoryWatch]struct{}{}
	}
	w.watching[entry] = struct{}{}
	if w.stop == nil {
		w.stop = make(chan struct{})
		go w.sample(w.stop)
	}
	w.mu.Unlock()

	return func() MemoryUsage {
		heap, allocs := w.read()
		w.mu.Lock()
		defer w.mu.Unlock()
		if heap > entry.peakHeap {
			entry.peakHeap = heap
		}
		delete(w.watching, entry)
		if len(w.watching) == 0 && w.stop != nil {
			close(w.stop)
			w.stop = nil
		}
		return MemoryUsage{
			PeakHeapGrowthBytes: entry.peakHeap - min(entry.startHeap, entry.peakHeap),
			AllocatedBytes:      allocs - min(entry.startAlloc, allocs),
		}
	}
}

func (w *MemoryWatcher) sample(done <-chan struct{}) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
		}
		heap, _ := w.read()
		over := heap > w.ceiling()
		var stops []func()
		w.mu.Lock()
		for entry := range w.watching {
			if heap > entry.peakHeap {
				entry.peakHeap = heap
			}
			if over && entry.stop != nil {
				stops = append(stops, entry.stop)
				entry.stop = nil
			}
		}
		w.mu.Unlock()
		for _, stop := range stops {
			stop()
		}
	}
}
