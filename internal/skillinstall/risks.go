package skillinstall

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
)

// riskPatterns flag content worth a second look. They are hints for the preview, not a verdict:
// a skill can be harmless and match, or harmful and not.
var riskPatterns = []struct {
	re   *regexp.Regexp
	note string
}{
	{regexp.MustCompile(`(?i)(curl|wget)[^\n|]*\|\s*(ba|z)?sh\b`), "downloads and runs a remote script (curl|sh)"},
	{regexp.MustCompile(`(?i)base64\s+(-d|--decode)[^\n]*\|\s*(ba|z)?sh\b`), "decodes and runs hidden commands"},
	{regexp.MustCompile(`(?i)\brm\s+-rf?\s+[~/]`), "deletes files outside its own folder (rm -rf)"},
	{regexp.MustCompile(`(?i)\bsudo\b`), "asks for root (sudo)"},
	{regexp.MustCompile(`(?i)~/\.ssh|id_rsa|id_ed25519|\.aws/credentials|\.netrc`), "touches credential files"},
	{regexp.MustCompile(`(?i)ignore (all |any )?(previous|prior|above) instructions`), "tries to override the agent's instructions"},
	{regexp.MustCompile(`(?i)(paste|send|share)[^\n]{0,40}(api[ _-]?key|token|password|secret)`), "asks for secrets"},
	{regexp.MustCompile(`(?i)\b(crontab|launchctl|systemctl\s+enable)\b`), "installs something that runs on its own"},
	{regexp.MustCompile(`(?i)webhook\.site|ngrok\.io|requestbin|pipedream\.net`), "mentions a data-collection endpoint"},
	{regexp.MustCompile(`(?i)\bhttp://`), "uses plain http links"},
}

var scriptExtensions = map[string]bool{".sh": true, ".bash": true, ".zsh": true, ".py": true, ".js": true, ".mjs": true, ".ts": true, ".rb": true, ".pl": true, ".ps1": true, ".bat": true, ".cmd": true}

// scanRisks returns plain-language notes about a skill's files.
func scanRisks(files []File) []string {
	found := map[string]bool{}
	var scripts, assets []string
	for _, file := range files {
		if file.Kind != "" {
			assets = append(assets, file.Path)
			continue
		}
		text := string(file.data)
		for _, pattern := range riskPatterns {
			if pattern.re.MatchString(text) {
				found[fmt.Sprintf("%s: %s", file.Path, pattern.note)] = true
			}
		}
		if scriptExtensions[strings.ToLower(path.Ext(file.Path))] {
			scripts = append(scripts, file.Path)
		}
	}
	var out []string
	for note := range found {
		out = append(out, note)
	}
	sort.Strings(out)
	if len(scripts) > 0 {
		out = append(out, fmt.Sprintf("ships scripts the agent may run: %s", strings.Join(scripts, ", ")))
	}
	if len(assets) > 0 {
		out = append(out, fmt.Sprintf("ships %d image and font files, checked only by file type and not reviewed: %s", len(assets), listSome(assets, 5)))
	}
	return out
}

// listSome names up to n items and counts the rest.
func listSome(items []string, n int) string {
	if len(items) <= n {
		return strings.Join(items, ", ")
	}
	return fmt.Sprintf("%s and %d more", strings.Join(items[:n], ", "), len(items)-n)
}
