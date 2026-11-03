package telegramapi

import (
	"bytes"
	"fmt"
	htmlstd "html"
	"strings"

	xhtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	gmhtml "github.com/yuin/goldmark/renderer/html"
)

var telegramMarkdownRenderer = goldmark.New(
	goldmark.WithExtensions(
		extension.Strikethrough,
	),
	goldmark.WithRendererOptions(
		// Keep raw HTML from markdown input; sanitizer below enforces Telegram allow-list.
		gmhtml.WithUnsafe(),
	),
)

// RenderHTMLFromMarkdown converts Markdown to the HTML subset Telegram accepts
// with parse_mode HTML. Tags Telegram does not support are dropped and their
// text kept.
func RenderHTMLFromMarkdown(text string) (string, error) {
	var raw bytes.Buffer
	if err := telegramMarkdownRenderer.Convert([]byte(text), &raw); err != nil {
		return "", err
	}
	out := sanitizeTelegramHTML(raw.String())
	out = strings.TrimSpace(out)
	if out == "" {
		return htmlstd.EscapeString(strings.TrimSpace(text)), nil
	}
	return out, nil
}

// IsEntityParseError reports whether a Telegram error description says the
// message markup could not be parsed, so the text should be sent again as plain
// text.
func IsEntityParseError(description string) bool {
	desc := strings.ToLower(description)
	return strings.Contains(desc, "can't parse entities") || strings.Contains(desc, "can't parse entity")
}

func sanitizeTelegramHTML(input string) string {
	ctx := &xhtml.Node{Type: xhtml.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := xhtml.ParseFragment(strings.NewReader(input), ctx)
	if err != nil {
		return htmlstd.EscapeString(strings.TrimSpace(input))
	}
	var b strings.Builder
	renderTelegramNodes(&b, nodes, renderHTMLState{})
	return collapseTrailingBlankLines(strings.TrimSpace(b.String()))
}

type renderHTMLState struct {
	insidePre bool
}

func renderTelegramNodes(dst *strings.Builder, nodes []*xhtml.Node, state renderHTMLState) {
	for _, n := range nodes {
		renderTelegramNode(dst, n, state)
	}
}

func renderTelegramNode(dst *strings.Builder, node *xhtml.Node, state renderHTMLState) {
	if node == nil {
		return
	}
	switch node.Type {
	case xhtml.TextNode:
		text := node.Data
		if !state.insidePre {
			if strings.TrimSpace(text) == "" {
				// Ignore structural whitespace between block-level nodes to avoid extra blank lines.
				if strings.ContainsAny(text, "\n\r") {
					return
				}
				// Preserve a single inline spacer between neighboring inline nodes.
				if dst.Len() > 0 {
					existing := dst.String()
					if !strings.HasSuffix(existing, " ") && !strings.HasSuffix(existing, "\n") {
						dst.WriteByte(' ')
					}
				}
				return
			}
			text = strings.ReplaceAll(text, "\r\n", "\n")
			text = strings.ReplaceAll(text, "\r", "\n")
			if strings.Contains(text, "\n") {
				// A line break inside a paragraph stays a line break, as Telegram shows one.
				// Only the spaces around it go; the text's own leading and trailing spaces
				// separate it from the elements beside it.
				lines := strings.Split(text, "\n")
				for i := range lines {
					if i > 0 {
						lines[i] = strings.TrimLeft(lines[i], " \t")
					}
					if i < len(lines)-1 {
						lines[i] = strings.TrimRight(lines[i], " \t")
					}
				}
				text = strings.Join(lines, "\n")
			}
		}
		dst.WriteString(htmlstd.EscapeString(text))
	case xhtml.ElementNode:
		tag := strings.ToLower(strings.TrimSpace(node.Data))
		switch tag {
		case "p":
			renderTelegramChildren(dst, node, state)
			writeParagraphBreak(dst)
		case "br":
			writeNewline(dst)
		case "ul":
			renderTelegramList(dst, node, false, state)
			writeParagraphBreak(dst)
		case "ol":
			renderTelegramList(dst, node, true, state)
			writeParagraphBreak(dst)
		case "li":
			renderTelegramChildren(dst, node, state)
			writeNewline(dst)
		case "h1", "h2", "h3", "h4", "h5", "h6":
			line := strings.TrimSpace(renderNodeChildrenToString(node, state))
			if line != "" {
				dst.WriteString("<b>")
				dst.WriteString(line)
				dst.WriteString("</b>")
				writeParagraphBreak(dst)
			}
		case "hr":
			writeParagraphBreak(dst)
		case "pre", "blockquote":
			open, close, ok := telegramHTMLElement(tag, node, state)
			if !ok {
				renderTelegramChildren(dst, node, state)
				return
			}
			dst.WriteString(open)
			nextState := state
			if tag == "pre" {
				nextState.insidePre = true
			}
			renderTelegramChildren(dst, node, nextState)
			dst.WriteString(close)
			writeParagraphBreak(dst)
		default:
			open, close, ok := telegramHTMLElement(tag, node, state)
			if !ok {
				// Unsupported tag is unwrapped into text/children.
				renderTelegramChildren(dst, node, state)
				return
			}
			dst.WriteString(open)
			nextState := state
			if tag == "pre" {
				nextState.insidePre = true
			}
			renderTelegramChildren(dst, node, nextState)
			dst.WriteString(close)
		}
	}
}

func renderTelegramChildren(dst *strings.Builder, node *xhtml.Node, state renderHTMLState) {
	for c := node.FirstChild; c != nil; c = c.NextSibling {
		renderTelegramNode(dst, c, state)
	}
}

func renderTelegramList(dst *strings.Builder, list *xhtml.Node, ordered bool, state renderHTMLState) {
	itemNo := 0
	for c := list.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != xhtml.ElementNode || strings.ToLower(strings.TrimSpace(c.Data)) != "li" {
			continue
		}
		itemNo++
		line := strings.TrimSpace(renderNodeChildrenToString(c, state))
		if line == "" {
			continue
		}
		if ordered {
			_, _ = fmt.Fprintf(dst, "%d. %s", itemNo, line)
		} else {
			dst.WriteString("* ")
			dst.WriteString(line)
		}
		writeNewline(dst)
	}
}

func renderNodeChildrenToString(node *xhtml.Node, state renderHTMLState) string {
	var b strings.Builder
	renderTelegramChildren(&b, node, state)
	return strings.TrimSpace(collapseTrailingBlankLines(b.String()))
}

func telegramHTMLElement(tag string, node *xhtml.Node, state renderHTMLState) (open string, close string, ok bool) {
	switch tag {
	case "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "tg-spoiler", "code", "pre", "blockquote":
		attrs := telegramHTMLAttrs(tag, node, state)
		return "<" + tag + attrs + ">", "</" + tag + ">", true
	case "span":
		if cls, has := nodeAttr(node, "class"); has && strings.TrimSpace(cls) == "tg-spoiler" {
			return `<span class="tg-spoiler">`, "</span>", true
		}
		return "", "", false
	case "a":
		href, has := nodeAttr(node, "href")
		if !has {
			return "", "", false
		}
		href = strings.TrimSpace(href)
		if !isAllowedTelegramHref(href) {
			return "", "", false
		}
		return `<a href="` + htmlstd.EscapeString(href) + `">`, "</a>", true
	default:
		return "", "", false
	}
}

func telegramHTMLAttrs(tag string, node *xhtml.Node, state renderHTMLState) string {
	switch tag {
	case "blockquote":
		if _, has := nodeAttr(node, "expandable"); has {
			return " expandable"
		}
		return ""
	case "code":
		if !state.insidePre {
			return ""
		}
		if cls, has := nodeAttr(node, "class"); has {
			cls = strings.TrimSpace(cls)
			if strings.HasPrefix(cls, "language-") && len(cls) > len("language-") {
				return ` class="` + htmlstd.EscapeString(cls) + `"`
			}
		}
		return ""
	default:
		return ""
	}
}

func nodeAttr(node *xhtml.Node, key string) (string, bool) {
	key = strings.ToLower(strings.TrimSpace(key))
	for _, a := range node.Attr {
		if strings.ToLower(strings.TrimSpace(a.Key)) == key {
			return a.Val, true
		}
	}
	return "", false
}

func isAllowedTelegramHref(href string) bool {
	lower := strings.ToLower(strings.TrimSpace(href))
	if lower == "" {
		return false
	}
	return strings.HasPrefix(lower, "http://") ||
		strings.HasPrefix(lower, "https://") ||
		strings.HasPrefix(lower, "tg://") ||
		strings.HasPrefix(lower, "mailto:")
}

func writeNewline(dst *strings.Builder) {
	if dst.Len() == 0 {
		return
	}
	s := dst.String()
	if strings.HasSuffix(s, "\n") {
		return
	}
	dst.WriteByte('\n')
}

func writeParagraphBreak(dst *strings.Builder) {
	if dst.Len() == 0 {
		return
	}
	s := dst.String()
	switch {
	case strings.HasSuffix(s, "\n\n"):
		return
	case strings.HasSuffix(s, "\n"):
		dst.WriteByte('\n')
	default:
		dst.WriteString("\n\n")
	}
}

func collapseTrailingBlankLines(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	for strings.Contains(s, "\n\n\n") {
		s = strings.ReplaceAll(s, "\n\n\n", "\n\n")
	}
	return s
}
