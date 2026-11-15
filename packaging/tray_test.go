//go:build windows

package main

import "testing"

func TestTrayMenuEventUsesOneNotificationProtocol(t *testing.T) {
	tests := []struct {
		name         string
		version4     bool
		notification uintptr
		want         bool
	}{
		{"version 4 context menu", true, wmContextMenu | 1<<16, true},
		{"version 4 legacy right button ignored", true, 0x0205 | 1<<16, false},
		{"legacy right button", false, 0x0205, true},
		{"legacy context menu ignored", false, wmContextMenu, false},
		{"version 4 left activation", true, ninSelect | 1<<16, false},
		{"version 4 keyboard activation", true, ninKeySelect | 1<<16, false},
		{"version 4 popup close", true, 0x0407 | 1<<16, false},
		{"legacy double click", false, 0x0203, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isTrayMenuEvent(test.version4, test.notification); got != test.want {
				t.Fatalf("isTrayMenuEvent(%v, %#x) = %v, want %v", test.version4, test.notification, got, test.want)
			}
		})
	}
}

func TestTrayMenuEventVersion4RightClickOpensOnce(t *testing.T) {
	// Explorer can deliver the raw mouse notification and the version 4 event
	// for the same right click. Processing both caused the native menu to flash.
	count := 0
	for _, event := range []uintptr{0x0205 | 1<<16, wmContextMenu | 1<<16} {
		if isTrayMenuEvent(true, event) {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("right click requested %d menus, want exactly one", count)
	}
}
