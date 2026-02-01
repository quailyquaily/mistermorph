package assets

import "embed"

// SkillsFS contains built-in skills shipped with mister_morph (under assets/skills).
//
//go:embed skills/**
var SkillsFS embed.FS
