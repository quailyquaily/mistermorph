package chatcommands

import (
	"fmt"
	"strings"
)

func ProjectGuidePrompt(projectDir string) string {
	return fmt.Sprintf(`Please analyze the project in directory %q and generate an AGENTS.md file.

AGENTS.md is a project-level guide for AI coding assistants. It should contain:

1. **Project Overview** — what this project does, its purpose, tech stack
2. **Directory Structure** — key directories and their purposes
3. **Build & Development** — how to build, test, run
4. **Coding Conventions** — naming, formatting, architecture patterns
5. **Key Dependencies** — major libraries/frameworks
6. **Special Notes** — anything AI assistants should know (env vars, config files, gotchas)

Use bash and read_file tools to explore the project structure, README, go.mod, package.json, Makefile, etc. to gather accurate information.

IMPORTANT: Do NOT use the write_file tool. Instead, write the final AGENTS.md content directly as your response text. Use markdown format. Be concise but thorough.`, projectDir)
}

func StripMarkdownFences(content string) string {
	content = strings.TrimSpace(content)
	if strings.HasPrefix(content, "```markdown") {
		content = strings.TrimPrefix(content, "```markdown")
		content = strings.TrimSpace(content)
		if strings.HasSuffix(content, "```") {
			content = strings.TrimSuffix(content, "```")
			content = strings.TrimSpace(content)
		}
		return content
	}
	if strings.HasPrefix(content, "```") {
		idx := strings.Index(content, "\n")
		if idx > 0 {
			content = content[idx+1:]
		} else {
			content = strings.TrimPrefix(content, "```")
		}
		content = strings.TrimSpace(content)
		if strings.HasSuffix(content, "```") {
			content = strings.TrimSuffix(content, "```")
			content = strings.TrimSpace(content)
		}
		return content
	}
	return content
}
