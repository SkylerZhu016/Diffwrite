//go:build windows

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMachineLaunchConfig(t *testing.T) {
	root := t.TempDir()
	t.Setenv("LOCALAPPDATA", root)
	t.Setenv("DIFFWRITE_REVIEW_DATA", "")
	t.Setenv("DIFFWRITE_REVIEW_PORT", "")
	if err := applyLaunchConfig(); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "Diffwrite")
	os.MkdirAll(dir, 0700)
	target := filepath.Join(root, "existing-review")
	b, _ := json.Marshal(map[string]any{"dataDirectory": target, "port": 41731})
	os.WriteFile(filepath.Join(dir, "launch.json"), b, 0600)
	if err := applyLaunchConfig(); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("DIFFWRITE_REVIEW_DATA") != target || os.Getenv("DIFFWRITE_REVIEW_PORT") != "41731" {
		t.Fatal("profile not applied")
	}
	os.WriteFile(filepath.Join(dir, "launch.json"), []byte("broken"), 0600)
	if err := applyLaunchConfig(); err != nil {
		t.Fatal("explicit isolation should override profile", err)
	}
	t.Setenv("DIFFWRITE_REVIEW_DATA", "")
	t.Setenv("DIFFWRITE_REVIEW_PORT", "")
	if err := applyLaunchConfig(); err == nil {
		t.Fatal("bad profile must not silently use an empty database")
	}
}
