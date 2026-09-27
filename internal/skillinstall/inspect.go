package skillinstall

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image/gif"
	"image/jpeg"
	"image/png"
	"path"
	"strings"
)

// Images and fonts are inspected by parsing their structure; nothing is executed or rendered
// outside Go's decoders. A matching signature only got the file this far: each type is walked to
// its end, so data hidden after it, or an embedded program or archive, becomes a finding.

// inspectAsset returns the file's audit status, a note, and findings.
func inspectAsset(f File) (string, string, []Finding) {
	ext := strings.ToLower(path.Ext(f.Path))
	var (
		note     string
		findings []Finding
		err      error
	)
	switch ext {
	case ".png":
		note, findings, err = inspectPNG(f)
	case ".jpg", ".jpeg":
		note, findings, err = inspectJPEG(f)
	case ".gif":
		note, findings, err = inspectGIF(f)
	case ".webp":
		note, findings, err = inspectWebP(f)
	case ".avif":
		note, findings, err = inspectAVIF(f)
	case ".ico":
		note, findings, err = inspectICO(f)
	case ".woff":
		note, findings, err = inspectWOFF(f)
	case ".woff2":
		note, findings, err = inspectWOFF2(f)
	case ".ttf", ".otf":
		note, findings, err = inspectSFNT(f)
	default:
		return AuditNotInspected, "no inspector for this file type", nil
	}
	if err != nil {
		findings = append(findings, Finding{
			Severity: SeverityHigh, Category: "integrity", Title: "Does not parse as a valid " + strings.TrimPrefix(ext, ".") + " file",
			File: f.Path, Evidence: err.Error(), Source: "check",
			Rationale: "A file that only looks like an image or font may be something else in disguise.",
		})
	}
	findings = append(findings, embeddedSignatures(f)...)
	return AuditInspected, note, findings
}

func trailingData(f File, end int, what string) []Finding {
	extra := len(f.data) - end
	if extra <= 0 {
		return nil
	}
	return []Finding{{
		Severity: SeverityHigh, Category: "integrity", Title: "Has data after the end of the " + what,
		File: f.Path, Evidence: fmt.Sprintf("%d bytes after offset %d", extra, end), Source: "check",
		Rationale: "Bytes after a file's end are ignored by viewers and are a common way to hide a payload.",
	}}
}

// embeddedSignatures looks past the header for programs, archives and scripts.
func embeddedSignatures(f File) []Finding {
	signatures := []struct{ sig, what string }{
		{"\x7fELF", "a Linux program (ELF)"},
		{"This program cannot be run in DOS mode", "a Windows program (PE)"},
		{"\xcf\xfa\xed\xfe", "a macOS program (Mach-O)"},
		{"PK\x03\x04", "a zip archive"},
		{"Rar!\x1a\x07", "a rar archive"},
		{"7z\xbc\xaf\x27\x1c", "a 7z archive"},
		{"#!/bin/", "a shell script"},
		{"<script", "HTML script"},
	}
	var out []Finding
	for _, s := range signatures {
		if i := bytes.Index(f.data[min(4, len(f.data)):], []byte(s.sig)); i >= 0 {
			out = append(out, Finding{
				Severity: SeverityHigh, Category: "integrity", Title: "Contains " + s.what,
				File: f.Path, Evidence: fmt.Sprintf("signature at offset %d", i+4), Source: "check",
				Rationale: "An image or font has no reason to carry a program, archive or script.",
			})
		}
	}
	return out
}

func inspectPNG(f File) (string, []Finding, error) {
	d := f.data
	pos := 8
	first := true
	var textBytes int
	for {
		if pos+8 > len(d) {
			return "", nil, fmt.Errorf("chunk header at offset %d runs past the end", pos)
		}
		n := int(binary.BigEndian.Uint32(d[pos:]))
		kind := string(d[pos+4 : pos+8])
		end := pos + 12 + n
		if n < 0 || end > len(d) || end < pos {
			return "", nil, fmt.Errorf("%s chunk at offset %d runs past the end", kind, pos)
		}
		if first && kind != "IHDR" {
			return "", nil, fmt.Errorf("first chunk is %s, not IHDR", kind)
		}
		first = false
		if crc32.ChecksumIEEE(d[pos+4:pos+8+n]) != binary.BigEndian.Uint32(d[pos+8+n:]) {
			return "", nil, fmt.Errorf("%s chunk at offset %d has a bad checksum", kind, pos)
		}
		if kind == "tEXt" || kind == "iTXt" || kind == "zTXt" {
			textBytes += n
		}
		pos = end
		if kind == "IEND" {
			break
		}
	}
	var findings []Finding
	if textBytes > 64*1024 {
		findings = append(findings, Finding{
			Severity: SeverityMedium, Category: "integrity", Title: "Carries a large amount of embedded text",
			File: f.Path, Evidence: fmt.Sprintf("%d bytes in text chunks", textBytes), Source: "check",
			Rationale: "Images rarely need this much metadata; it can hide instructions or data.",
		})
	}
	findings = append(findings, trailingData(f, pos, "image")...)
	img, err := png.Decode(bytes.NewReader(d))
	if err != nil {
		return "", findings, err
	}
	b := img.Bounds()
	return fmt.Sprintf("PNG %dx%d; chunks and checksums verified, pixels decoded", b.Dx(), b.Dy()), findings, nil
}

func inspectJPEG(f File) (string, []Finding, error) {
	img, err := jpeg.Decode(bytes.NewReader(f.data))
	if err != nil {
		return "", nil, err
	}
	end := bytes.LastIndex(f.data, []byte{0xff, 0xd9})
	if end < 0 {
		return "", nil, fmt.Errorf("no end-of-image marker")
	}
	b := img.Bounds()
	return fmt.Sprintf("JPEG %dx%d; pixels decoded", b.Dx(), b.Dy()), trailingData(f, end+2, "image"), nil
}

func inspectGIF(f File) (string, []Finding, error) {
	g, err := gif.DecodeAll(bytes.NewReader(f.data))
	if err != nil {
		return "", nil, err
	}
	end := bytes.LastIndexByte(f.data, 0x3b) // trailer
	return fmt.Sprintf("GIF, %d frames; decoded", len(g.Image)), trailingData(f, end+1, "image"), nil
}

// riffChunks walks RIFF chunks from pos to end and returns their fourccs.
func riffChunks(d []byte, pos, end int) ([]string, error) {
	var kinds []string
	for pos < end {
		if pos+8 > end {
			return nil, fmt.Errorf("chunk header at offset %d runs past the end", pos)
		}
		kind := string(d[pos : pos+4])
		n := int(binary.LittleEndian.Uint32(d[pos+4:]))
		next := pos + 8 + n + n%2
		if n < 0 || next > end+1 || next < pos {
			return nil, fmt.Errorf("%s chunk at offset %d runs past the end", kind, pos)
		}
		kinds = append(kinds, kind)
		pos = next
	}
	return kinds, nil
}

func inspectWebP(f File) (string, []Finding, error) {
	d := f.data
	if len(d) < 12 {
		return "", nil, fmt.Errorf("too short")
	}
	end := 8 + int(binary.LittleEndian.Uint32(d[4:]))
	if end > len(d) {
		return "", nil, fmt.Errorf("RIFF size %d is larger than the file", end)
	}
	kinds, err := riffChunks(d, 12, end)
	if err != nil {
		return "", nil, err
	}
	known := map[string]bool{"VP8 ": true, "VP8L": true, "VP8X": true, "ALPH": true, "ANIM": true, "ANMF": true, "ICCP": true, "EXIF": true, "XMP ": true}
	hasImage := false
	var findings []Finding
	for _, k := range kinds {
		if k == "VP8 " || k == "VP8L" || k == "ANMF" {
			hasImage = true
		}
		if !known[k] {
			findings = append(findings, Finding{
				Severity: SeverityLow, Category: "integrity", Title: "Has an unknown WebP chunk",
				File: f.Path, Evidence: fmt.Sprintf("chunk %q", k), Source: "check",
				Rationale: "Viewers skip unknown chunks, so they can carry hidden data.",
			})
		}
	}
	if !hasImage {
		return "", findings, fmt.Errorf("no image data chunk")
	}
	// A pad byte after an odd-sized RIFF is allowed.
	padded := end
	if end%2 == 1 && len(d) == end+1 {
		padded = end + 1
	}
	findings = append(findings, trailingData(f, padded, "image")...)
	return fmt.Sprintf("WebP; container walked (%s); pixels not decoded", strings.Join(kinds, ", ")), findings, nil
}

// bmffBoxes walks ISO base media boxes and returns their types and where they end.
func bmffBoxes(d []byte) ([]string, int, error) {
	var kinds []string
	pos := 0
	for pos+8 <= len(d) {
		size := int(binary.BigEndian.Uint32(d[pos:]))
		kind := string(d[pos+4 : pos+8])
		switch size {
		case 0:
			size = len(d) - pos
		case 1:
			if pos+16 > len(d) {
				return nil, pos, fmt.Errorf("%s box at offset %d is cut short", kind, pos)
			}
			size = int(binary.BigEndian.Uint64(d[pos+8:]))
		}
		if size < 8 || pos+size > len(d) || pos+size < pos {
			return nil, pos, fmt.Errorf("%s box at offset %d runs past the end", kind, pos)
		}
		kinds = append(kinds, kind)
		pos += size
	}
	return kinds, pos, nil
}

func inspectAVIF(f File) (string, []Finding, error) {
	kinds, end, err := bmffBoxes(f.data)
	if err != nil {
		return "", nil, err
	}
	if len(kinds) == 0 || kinds[0] != "ftyp" {
		return "", nil, fmt.Errorf("does not start with an ftyp box")
	}
	has := map[string]bool{}
	for _, k := range kinds {
		has[k] = true
	}
	if !has["meta"] || !has["mdat"] {
		return "", nil, fmt.Errorf("missing meta or mdat box")
	}
	return fmt.Sprintf("AVIF; boxes walked (%s); pixels not decoded", strings.Join(kinds, ", ")), trailingData(f, end, "image"), nil
}

func inspectICO(f File) (string, []Finding, error) {
	d := f.data
	if len(d) < 6 {
		return "", nil, fmt.Errorf("too short")
	}
	count := int(binary.LittleEndian.Uint16(d[4:]))
	if count == 0 || 6+16*count > len(d) {
		return "", nil, fmt.Errorf("directory of %d images does not fit", count)
	}
	end := 6 + 16*count
	for i := 0; i < count; i++ {
		e := d[6+16*i:]
		size := int(binary.LittleEndian.Uint32(e[8:]))
		off := int(binary.LittleEndian.Uint32(e[12:]))
		if off < 6+16*count || size <= 0 || off+size > len(d) || off+size < off {
			return "", nil, fmt.Errorf("image %d (offset %d, %d bytes) is outside the file", i, off, size)
		}
		if off+size > end {
			end = off + size
		}
	}
	return fmt.Sprintf("ICO, %d images; directory checked; pixels not decoded", count), trailingData(f, end, "icon"), nil
}

func inspectWOFF(f File) (string, []Finding, error) {
	d := f.data
	if len(d) < 44 {
		return "", nil, fmt.Errorf("too short")
	}
	if n := int(binary.BigEndian.Uint32(d[8:])); n != len(d) {
		return "", nil, fmt.Errorf("header says %d bytes, file has %d", n, len(d))
	}
	tables := int(binary.BigEndian.Uint16(d[12:]))
	if 44+20*tables > len(d) {
		return "", nil, fmt.Errorf("table directory does not fit")
	}
	for i := 0; i < tables; i++ {
		e := d[44+20*i:]
		off := int(binary.BigEndian.Uint32(e[4:]))
		n := int(binary.BigEndian.Uint32(e[8:]))
		if off+n > len(d) || off+n < off {
			return "", nil, fmt.Errorf("table %q is outside the file", string(e[:4]))
		}
	}
	return fmt.Sprintf("WOFF, %d tables; table directory checked", tables), nil, nil
}

func inspectWOFF2(f File) (string, []Finding, error) {
	d := f.data
	if len(d) < 48 {
		return "", nil, fmt.Errorf("too short")
	}
	if n := int(binary.BigEndian.Uint32(d[8:])); n != len(d) {
		return "", nil, fmt.Errorf("header says %d bytes, file has %d", n, len(d))
	}
	tables := int(binary.BigEndian.Uint16(d[12:]))
	return fmt.Sprintf("WOFF2, %d tables; header and length checked; tables compressed, not unpacked", tables), nil, nil
}

func inspectSFNT(f File) (string, []Finding, error) {
	d := f.data
	if len(d) < 12 {
		return "", nil, fmt.Errorf("too short")
	}
	tables := int(binary.BigEndian.Uint16(d[4:]))
	if tables == 0 || 12+16*tables > len(d) {
		return "", nil, fmt.Errorf("table directory of %d tables does not fit", tables)
	}
	end := 12 + 16*tables
	for i := 0; i < tables; i++ {
		e := d[12+16*i:]
		off := int(binary.BigEndian.Uint32(e[8:]))
		n := int(binary.BigEndian.Uint32(e[12:]))
		if off+n > len(d) || off+n < off {
			return "", nil, fmt.Errorf("table %q is outside the file", string(e[:4]))
		}
		if off+n > end {
			end = off + n
		}
	}
	// Tables are padded to four bytes.
	if pad := (4 - end%4) % 4; end+pad <= len(d) {
		end += pad
	}
	return fmt.Sprintf("font, %d tables; table directory checked", tables), trailingData(f, end, "font"), nil
}
