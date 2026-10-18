package web

import "embed"

// Files is the PWA the Windows executable serves. Node serves the same
// directory from disk; this embed keeps the release binary self-contained.
//
//go:embed index.html setup.html app.js net.js experiments.js zip.js style.css sw.js manifest.webmanifest icon.svg icons/*
var Files embed.FS
