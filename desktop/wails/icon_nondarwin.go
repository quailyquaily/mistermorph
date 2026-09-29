//go:build wailsdesktop && !darwin

package main

import _ "embed"

// Linux and Windows show the window icon as is, so it is the tile filling its canvas.
//
//go:embed packaging/icons/linux/hicolor/256x256/apps/icon.png
var desktopAppIconPNG []byte
