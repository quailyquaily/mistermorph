package daemonruntime

import (
	"bytes"
	"io"
	"net/http"
	"path"
	"strings"
	"unicode/utf8"
)

// Which received files (task attachments) the Console previews, and how they are served for it.
//
// The kind comes from the bytes where they say it (raster images, PDFs), and for text from the
// file's name or its recorded type together with a strict check of the bytes: valid UTF-8 with no
// NUL, at most attachmentTextPreviewMaxBytes. Markup that a browser would render (HTML, SVG, XML)
// is never a text preview; it stays download only, as do archives and other binaries. The Console
// keeps the same list (web/console-nsh/lib/core/received-files.js).

// attachmentTextPreviewMaxBytes caps a text preview: larger text files are download only.
const attachmentTextPreviewMaxBytes int64 = 2 << 20

const (
	attachmentPreviewTextType = "text/plain; charset=utf-8"
	attachmentPreviewPDFType  = "application/pdf"
)

// attachmentTextExtensions are the file name extensions previewed as plain text.
var attachmentTextExtensions = map[string]bool{}

// attachmentTextNames are file names without an extension previewed as plain text.
var attachmentTextNames = map[string]bool{}

func init() {
	for _, ext := range strings.Fields(`
		.txt .text .md .markdown .mdown .rst .adoc .asciidoc .org .log .out .csv .tsv .json .jsonl .ndjson
		.yaml .yml .toml .ini .cfg .conf .properties .env .diff .patch .tex .bib .srt .vtt
		.go .mod .sum .py .pyi .rb .php .pl .pm .lua .r .jl .js .mjs .cjs .ts .mts .cts .tsx .jsx .vue .svelte
		.java .kt .kts .scala .groovy .gradle .c .h .cc .cpp .cxx .hh .hpp .hxx .m .mm .cs .fs .swift
		.rs .zig .dart .ex .exs .erl .hrl .hs .clj .cljs .elm .ml .mli .nim .sh .bash .zsh .fish .ps1 .bat .cmd
		.sql .graphql .gql .proto .css .scss .sass .less .cmake .mk .dockerfile .tf .hcl .nix .gitignore .editorconfig`) {
		attachmentTextExtensions[ext] = true
	}
	for _, name := range strings.Fields(`readme license licence changelog makefile dockerfile containerfile procfile gemfile rakefile justfile vagrantfile notice authors contributing todo`) {
		attachmentTextNames[name] = true
	}
}

// attachmentTextCandidate reports whether a file of this name or recorded type may preview as text
// (its bytes still have to pass attachmentTextContent).
func attachmentTextCandidate(name, contentType string) bool {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "text/plain") {
		return true
	}
	base := strings.ToLower(path.Base(strings.ReplaceAll(strings.TrimSpace(name), "\\", "/")))
	ext := path.Ext(base)
	if ext == "" || ext == base {
		// No extension, or a dotfile such as ".gitignore".
		return attachmentTextNames[base] || attachmentTextExtensions[base]
	}
	return attachmentTextExtensions[ext]
}

// attachmentTextContent reports whether the bytes show as plain text: valid UTF-8 without NUL.
func attachmentTextContent(content []byte) bool {
	return utf8.Valid(content) && bytes.IndexByte(content, 0) < 0
}

// attachmentImageType is the raster image type of bytes starting with `head`, or "".
func attachmentImageType(head []byte) string {
	switch detected := http.DetectContentType(head); detected {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return detected
	}
	return ""
}

// attachmentContentType is the type recorded for a new attachment: a raster image or PDF type
// from its bytes, plain text for a text file whose content passes the preview checks, and
// otherwise application/octet-stream.
func attachmentContentType(name string, file io.ReaderAt, size int64) (string, error) {
	var head [512]byte
	n, err := file.ReadAt(head[:], 0)
	if err != nil && err != io.EOF {
		return "", err
	}
	if image := attachmentImageType(head[:n]); image != "" {
		return image, nil
	}
	if http.DetectContentType(head[:n]) == attachmentPreviewPDFType {
		return attachmentPreviewPDFType, nil
	}
	if size <= attachmentTextPreviewMaxBytes && attachmentTextCandidate(name, "") {
		content := make([]byte, size)
		if _, err := file.ReadAt(content, 0); err != nil && err != io.EOF {
			return "", err
		}
		if attachmentTextContent(content) {
			return attachmentPreviewTextType, nil
		}
	}
	return "application/octet-stream", nil
}

// attachmentPreviewError is why an attachment has no preview, with its HTTP status.
type attachmentPreviewError struct {
	status  int
	message string
}

var (
	errAttachmentNoPreview = &attachmentPreviewError{http.StatusBadRequest, "file type has no preview; download it instead"}
	errAttachmentNotText   = &attachmentPreviewError{http.StatusBadRequest, "file is not UTF-8 text; download it instead"}
	errAttachmentTooLarge  = &attachmentPreviewError{http.StatusRequestEntityTooLarge, "text file is larger than the 2 MiB preview limit; download it instead"}
)

// attachmentPreview decides how a stored attachment previews: its served type and, for text, the
// checked bytes. The kind follows the bytes and the name, not only the recorded type, so files
// recorded before text and PDF previews existed (application/octet-stream) preview too.
func attachmentPreview(name, recordedType string, file io.ReaderAt, size int64) (string, []byte, *attachmentPreviewError) {
	var head [512]byte
	n, err := file.ReadAt(head[:], 0)
	if err != nil && err != io.EOF {
		return "", nil, errAttachmentNoPreview
	}
	if image := attachmentImageType(head[:n]); image != "" {
		return image, nil, nil
	}
	if http.DetectContentType(head[:n]) == attachmentPreviewPDFType {
		return attachmentPreviewPDFType, nil, nil
	}
	if !attachmentTextCandidate(name, recordedType) {
		return "", nil, errAttachmentNoPreview
	}
	if size > attachmentTextPreviewMaxBytes {
		return "", nil, errAttachmentTooLarge
	}
	content := make([]byte, size)
	read, err := file.ReadAt(content, 0)
	if err != nil && err != io.EOF {
		return "", nil, errAttachmentNoPreview
	}
	content = content[:read]
	if !attachmentTextContent(content) {
		return "", nil, errAttachmentNotText
	}
	return attachmentPreviewTextType, content, nil
}
