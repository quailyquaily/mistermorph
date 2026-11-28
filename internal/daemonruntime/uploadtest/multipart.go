// Package uploadtest builds multipart upload bodies of exact byte counts for tests of
// POST /files/upload, streamed (no body is held whole in memory), and valid images of chosen sizes.
package uploadtest

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"strings"
)

// Boundary is the multipart boundary of every body built here.
const Boundary = "ft197-upload-boundary"

// ContentType is the request's Content-Type for a body built here.
const ContentType = "multipart/form-data; boundary=" + Boundary

// Part is one part of a body: a field (File == false) or a file under the `files` field.
type Part struct {
	Name  string // the field name, or the file name for a file
	File  bool
	Value string // a field's value
	// A file's content: Size bytes from Content (nil: a repeating pattern).
	Size    int64
	Content io.Reader
}

func (p Part) header() string {
	if !p.File {
		return fmt.Sprintf("--%s\r\nContent-Disposition: form-data; name=%q\r\n\r\n", Boundary, p.Name)
	}
	return fmt.Sprintf("--%s\r\nContent-Disposition: form-data; name=\"files\"; filename=%q\r\nContent-Type: application/octet-stream\r\n\r\n", Boundary, p.Name)
}

const closing = "--" + Boundary + "--\r\n"

// Length is the exact byte count of the body of `parts`.
func Length(parts []Part) int64 {
	var n int64
	for _, p := range parts {
		n += int64(len(p.header())) + 2
		if p.File {
			n += p.Size
		} else {
			n += int64(len(p.Value))
		}
	}
	return n + int64(len(closing))
}

// Framing is the body's length less its files' contents.
func Framing(parts []Part) int64 {
	n := Length(parts)
	for _, p := range parts {
		if p.File {
			n -= p.Size
		}
	}
	return n
}

// Body streams the body of `parts`; Sums has each file's SHA-256 once it was read.
type Body struct {
	r io.Reader
	// Consumed is how many bytes were read of it.
	Consumed int64
	sums     []hash.Hash
	names    []string
}

// NewBody returns the body of `parts`, streamed.
func NewBody(parts []Part) *Body {
	b := &Body{}
	readers := make([]io.Reader, 0, len(parts)*3+1)
	for _, p := range parts {
		readers = append(readers, strings.NewReader(p.header()))
		if p.File {
			content := p.Content
			if content == nil {
				content = Pattern()
			}
			sum := sha256.New()
			b.sums = append(b.sums, sum)
			b.names = append(b.names, p.Name)
			readers = append(readers, io.TeeReader(io.LimitReader(content, p.Size), sum))
		} else {
			readers = append(readers, strings.NewReader(p.Value))
		}
		readers = append(readers, strings.NewReader("\r\n"))
	}
	readers = append(readers, strings.NewReader(closing))
	b.r = io.MultiReader(readers...)
	return b
}

func (b *Body) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	b.Consumed += int64(n)
	return n, err
}

// Sums are the files' SHA-256 sums by name (complete once the body was read to its end).
func (b *Body) Sums() map[string][]byte {
	out := make(map[string][]byte, len(b.names))
	for i, name := range b.names {
		out[name] = b.sums[i].Sum(nil)
	}
	return out
}

// Pattern is an endless reader of repeating bytes.
func Pattern() io.Reader { return &pattern{} }

type pattern struct{ at byte }

func (r *pattern) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'a' + r.at%26
		r.at++
	}
	return len(p), nil
}

// FailAfter reads `r` and fails with err after n bytes: an interrupted transfer.
func FailAfter(r io.Reader, n int64, err error) io.Reader {
	return io.MultiReader(io.LimitReader(r, n), errReader{err})
}

type errReader struct{ err error }

func (r errReader) Read([]byte) (int, error) { return 0, r.err }

/* ---------- valid images of a chosen size ---------- */

func tinyImage() image.Image {
	img := image.NewRGBA(image.Rect(0, 0, 4, 3))
	for y := 0; y < 3; y++ {
		for x := 0; x < 4; x++ {
			img.Set(x, y, color.RGBA{uint8(60 * x), uint8(80 * y), 7, 255})
		}
	}
	return img
}

// JPEG streams a valid JPEG of exactly `size` bytes: a small baseline image whose start is padded
// with APP15 segments (which decoders skip).
func JPEG(size int64) (io.Reader, error) {
	var small bytes.Buffer
	if err := jpeg.Encode(&small, tinyImage(), &jpeg.Options{Quality: 90}); err != nil {
		return nil, err
	}
	raw := small.Bytes()
	pad := size - int64(len(raw))
	if pad < 0 || pad == 1 || pad == 2 || pad == 3 {
		return nil, fmt.Errorf("cannot make a %d-byte JPEG", size)
	}
	// Segments of 4 bytes of header plus up to 65533 bytes of data.
	var segments []io.Reader
	for pad > 0 {
		data := min(pad-4, 65533)
		if rest := pad - 4 - data; rest > 0 && rest < 4 {
			data -= 4 - rest
		}
		segments = append(segments, bytes.NewReader([]byte{0xFF, 0xEF, byte((data + 2) >> 8), byte(data + 2)}), io.LimitReader(Pattern(), data))
		pad -= 4 + data
	}
	readers := append([]io.Reader{bytes.NewReader(raw[:2])}, segments...)
	readers = append(readers, bytes.NewReader(raw[2:]))
	return io.MultiReader(readers...), nil
}

// PNG streams a valid PNG of exactly `size` bytes: a small image with a private ancillary chunk
// (`ftPd`, which decoders skip) of the padding.
func PNG(size int64) (io.Reader, error) {
	var small bytes.Buffer
	if err := png.Encode(&small, tinyImage()); err != nil {
		return nil, err
	}
	raw := small.Bytes()
	const iendLen = 12
	data := size - int64(len(raw)) - 12
	if data < 0 || data > 1<<31-1 {
		return nil, fmt.Errorf("cannot make a %d-byte PNG", size)
	}
	// The chunk's CRC covers its type and data: computed over the same pattern first.
	crc := crc32.NewIEEE()
	crc.Write([]byte("ftPd"))
	if _, err := io.Copy(crc, io.LimitReader(Pattern(), data)); err != nil {
		return nil, err
	}
	head := make([]byte, 8)
	binary.BigEndian.PutUint32(head, uint32(data))
	copy(head[4:], "ftPd")
	tail := make([]byte, 4)
	binary.BigEndian.PutUint32(tail, crc.Sum32())
	body := raw[:len(raw)-iendLen]
	return io.MultiReader(bytes.NewReader(body), bytes.NewReader(head), io.LimitReader(Pattern(), data), bytes.NewReader(tail), bytes.NewReader(raw[len(raw)-iendLen:])), nil
}

// tinyWebP is a valid 12 × 8 lossless WebP (tests/fixtures/paste/blue.webp of the Console).
var tinyWebP = []byte{
	0x52, 0x49, 0x46, 0x46, 0x1e, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
	0x11, 0x00, 0x00, 0x00, 0x2f, 0x0b, 0xc0, 0x01, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe,
	0x07, 0x88, 0x88, 0xe8, 0x7f, 0x00,
}

// WebP streams a valid extended WebP of exactly `size` bytes (even, at least 74): the small
// lossless image in a VP8X container with an XMP chunk of the padding.
func WebP(size int64) (io.Reader, error) {
	image := tinyWebP[12:] // the VP8L chunk
	const vp8x = 8 + 10
	xmp := size - 12 - vp8x - int64(len(image)) - 8
	if xmp < 0 || xmp%2 != 0 || size > 1<<32-1 {
		return nil, fmt.Errorf("cannot make a %d-byte WebP", size)
	}
	header := make([]byte, 12)
	copy(header, "RIFF")
	binary.LittleEndian.PutUint32(header[4:], uint32(size-8))
	copy(header[8:], "WEBP")
	chunk := make([]byte, vp8x)
	copy(chunk, "VP8X")
	binary.LittleEndian.PutUint32(chunk[4:], 10)
	chunk[8] = 0x04 // XMP metadata
	// Canvas 12 × 8 (minus one each, 24 bits).
	chunk[12], chunk[15] = 11, 7
	xmpHead := make([]byte, 8)
	copy(xmpHead, "XMP ")
	binary.LittleEndian.PutUint32(xmpHead[4:], uint32(xmp))
	return io.MultiReader(bytes.NewReader(header), bytes.NewReader(chunk), bytes.NewReader(image), bytes.NewReader(xmpHead), io.LimitReader(Pattern(), xmp)), nil
}
