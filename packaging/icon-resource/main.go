//go:build windows

// Adds the native icon group used by Explorer and the tray to the built executable.
package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

func addIcon(exe, path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if len(b) < 22 || binary.LittleEndian.Uint32(b[:4]) != 0x00010000 {
		return fmt.Errorf("invalid ICO header")
	}
	count := int(binary.LittleEndian.Uint16(b[4:6]))
	if count < 1 || count > 32 || len(b) < 6+16*count {
		return fmt.Errorf("invalid ICO directory")
	}
	group := make([]byte, 6+14*count)
	copy(group, b[:6])
	kernel := syscall.NewLazyDLL("kernel32.dll")
	begin, update, end := kernel.NewProc("BeginUpdateResourceW"), kernel.NewProc("UpdateResourceW"), kernel.NewProc("EndUpdateResourceW")
	name, err := syscall.UTF16PtrFromString(exe)
	if err != nil {
		return err
	}
	handle, _, err := begin.Call(uintptr(unsafe.Pointer(name)), 0)
	if handle == 0 {
		return err
	}
	finished := false
	defer func() {
		if !finished {
			end.Call(handle, 1)
		}
	}()
	write := func(kind, id uintptr, data []byte) error {
		ok, _, err := update.Call(handle, kind, id, 0, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)))
		if ok == 0 {
			return err
		}
		return nil
	}
	for i := 0; i < count; i++ {
		entry := b[6+i*16 : 6+(i+1)*16]
		size, start := int(binary.LittleEndian.Uint32(entry[8:12])), int(binary.LittleEndian.Uint32(entry[12:16]))
		if size < 1 || start < 6+16*count || start > len(b) || size > len(b)-start {
			return fmt.Errorf("invalid ICO image %d", i)
		}
		id := i + 1
		copy(group[6+i*14:], entry[:12])
		binary.LittleEndian.PutUint16(group[6+i*14+12:], uint16(id))
		if err := write(3, uintptr(id), b[start:start+size]); err != nil { // RT_ICON
			return err
		}
	}
	if err := write(14, 1, group); err != nil { // RT_GROUP_ICON
		return err
	}
	ok, _, err := end.Call(handle, 0)
	finished = true
	if ok == 0 {
		return err
	}
	return nil
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: icon-resource <exe> <ico>")
		os.Exit(2)
	}
	if err := addIcon(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
