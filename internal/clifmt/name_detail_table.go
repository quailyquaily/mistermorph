package clifmt

import (
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"golang.org/x/term"
)

const (
	defaultTableWidth     = 100
	defaultMinDetailWidth = 36
)

type NameDetailRow struct {
	Name   string
	Detail string
}

type NameDetailTableOptions struct {
	Title          string
	Rows           []NameDetailRow
	EmptyText      string
	NameHeader     string
	DetailHeader   string
	DefaultWidth   int
	MinDetailWidth int
	EmptyDetail    string
}

func PrintNameDetailTable(out io.Writer, opts NameDetailTableOptions) {
	if out == nil {
		out = os.Stdout
	}

	title := strings.TrimSpace(opts.Title)
	if title != "" {
		fmt.Fprintln(out, Headerf("%s (%d)", title, len(opts.Rows)))
	}

	if len(opts.Rows) == 0 {
		emptyText := strings.TrimSpace(opts.EmptyText)
		if emptyText == "" {
			emptyText = "No entries."
		}
		fmt.Fprintln(out, Warn(emptyText))
		return
	}

	nameHeader := strings.TrimSpace(opts.NameHeader)
	if nameHeader == "" {
		nameHeader = "NAME"
	}
	detailHeader := strings.TrimSpace(opts.DetailHeader)
	if detailHeader == "" {
		detailHeader = "DETAILS"
	}
	emptyDetail := strings.TrimSpace(opts.EmptyDetail)
	if emptyDetail == "" {
		emptyDetail = "No details provided."
	}

	nameWidth := utf8.RuneCountInString(nameHeader)
	for _, row := range opts.Rows {
		if width := utf8.RuneCountInString(row.Name); width > nameWidth {
			nameWidth = width
		}
	}

	detailWidth := tableDetailWidth(out, nameWidth, opts.DefaultWidth, opts.MinDetailWidth)

	fmt.Fprintf(out, "%s  %s\n", Key(padRightRunes(nameHeader, nameWidth)), Key(detailHeader))
	fmt.Fprintf(out, "%s  %s\n", Dim(strings.Repeat("-", nameWidth)), Dim(strings.Repeat("-", detailWidth)))

	for _, row := range opts.Rows {
		detail := strings.TrimSpace(row.Detail)
		if detail == "" {
			detail = emptyDetail
		}

		lines := wrapTextRunes(detail, detailWidth)
		fmt.Fprintf(out, "%s  %s\n", Success(padRightRunes(row.Name, nameWidth)), lines[0])
		for _, line := range lines[1:] {
			fmt.Fprintf(out, "%s  %s\n", strings.Repeat(" ", nameWidth), line)
		}
	}
}

func tableDetailWidth(out io.Writer, nameWidth, defaultWidth, minDetailWidth int) int {
	if defaultWidth <= 0 {
		defaultWidth = defaultTableWidth
	}
	if minDetailWidth <= 0 {
		minDetailWidth = defaultMinDetailWidth
	}

	width := defaultWidth
	if file, ok := out.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		if terminalWidth, _, err := term.GetSize(int(file.Fd())); err == nil && terminalWidth > 0 {
			width = terminalWidth
		}
	}

	detailWidth := width - nameWidth - 2
	if detailWidth < minDetailWidth {
		detailWidth = minDetailWidth
	}
	return detailWidth
}

func padRightRunes(s string, width int) string {
	missing := width - utf8.RuneCountInString(s)
	if missing <= 0 {
		return s
	}
	return s + strings.Repeat(" ", missing)
}

func wrapTextRunes(text string, width int) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return []string{""}
	}
	if width <= 0 {
		return []string{text}
	}

	words := strings.Fields(text)
	lines := make([]string, 0, len(words))
	current := ""

	flush := func() {
		if current == "" {
			return
		}
		lines = append(lines, current)
		current = ""
	}

	for _, word := range words {
		for utf8.RuneCountInString(word) > width {
			flush()
			runes := []rune(word)
			lines = append(lines, string(runes[:width]))
			word = string(runes[width:])
		}

		switch {
		case current == "":
			current = word
		case utf8.RuneCountInString(current)+1+utf8.RuneCountInString(word) <= width:
			current += " " + word
		default:
			flush()
			current = word
		}
	}
	flush()

	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}
