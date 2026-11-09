//go:build windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
)

func wide(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

func instanceMutex(port int) (syscall.Handle, bool, error) {
	name := wide("Local\\Diffwrite-" + strconv.Itoa(port))
	result, _, err := kernel32.NewProc("CreateMutexW").Call(0, 0, uintptr(unsafe.Pointer(name)))
	runtime.KeepAlive(name)
	if result == 0 {
		return 0, false, err
	}
	return syscall.Handle(result), err == syscall.ERROR_ALREADY_EXISTS, nil
}
func openPage(url string) error {
	verb, target := wide("open"), wide(url)
	result, _, _ := shell32.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(target)), 0, 0, 1)
	runtime.KeepAlive(verb)
	runtime.KeepAlive(target)
	if result <= 32 {
		return fmt.Errorf("无法打开默认浏览器。可以手动访问 %s", url)
	}
	return nil
}
func showProblem(err error) {
	title, message := wide("逐句审稿"), wide(err.Error())
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
	runtime.KeepAlive(title)
	runtime.KeepAlive(message)
}
func writeLicenses(text []byte) error {
	if _, err := os.Stdout.Write(text); err == nil {
		return nil
	}
	// GUI applications do not have a console by default. Retain output for a terminal or pipe.
	kernel32.NewProc("AttachConsole").Call(uintptr(uint32(0xffffffff)))
	f, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(text)
	return err
}

type winPoint struct{ x, y int32 }
type winMessage struct {
	hwnd           uintptr
	message        uint32
	wparam, lparam uintptr
	time           uint32
	point          winPoint
	private        uint32
}
type windowClass struct {
	size, style                        uint32
	proc                               uintptr
	clsExtra, wndExtra                 int32
	instance, icon, cursor, background uintptr
	menu, class                        *uint16
	smallIcon                          uintptr
}
type trayIcon struct {
	size                uint32
	hwnd                uintptr
	id, flags, callback uint32
	icon                uintptr
	tip                 [128]uint16
	state, stateMask    uint32
	info                [256]uint16
	version             uint32
	infoTitle           [64]uint16
	infoFlags           uint32
	guid                [16]byte
	balloonIcon         uintptr
}

const (
	wmTray        = 0x8001
	wmWorkerDone  = 0x8002
	wmContextMenu = 0x007b
	ninSelect     = 0x0400
	ninKeySelect  = 0x0401
)

type winRect struct{ left, top, right, bottom int32 }
type iconIdentifier struct {
	size uint32
	hwnd uintptr
	id   uint32
	guid [16]byte
}
type menuParams struct {
	size    uint32
	exclude winRect
}
type monitorInfo struct {
	size          uint32
	monitor, work winRect
	flags         uint32
}

func menuAnchor(icon trayIcon, x, y int32) (int32, int32, uintptr, menuParams) {
	id := iconIdentifier{hwnd: icon.hwnd, id: icon.id}
	id.size = uint32(unsafe.Sizeof(id))
	params := menuParams{exclude: winRect{x - 1, y - 1, x + 1, y + 1}}
	params.size = uint32(unsafe.Sizeof(params))
	var rect winRect
	result, _, _ := shell32.NewProc("Shell_NotifyIconGetRect").Call(uintptr(unsafe.Pointer(&id)), uintptr(unsafe.Pointer(&rect)))
	if int32(result) == 0 && rect.right > rect.left && rect.bottom > rect.top {
		params.exclude = rect
		x = (rect.left + rect.right) / 2
		y = (rect.top + rect.bottom) / 2
	}
	// The overflow is a separate shell window, not the taskbar. Avoid the whole panel,
	// not just the icon inside it. Normal taskbar clicks keep the single-icon exclusion.
	packed := uintptr(uint64(uint32(x)) | uint64(uint32(y))<<32)
	window, _, _ := user32.NewProc("WindowFromPoint").Call(packed)
	root, _, _ := user32.NewProc("GetAncestor").Call(window, 2) // GA_ROOT
	if root != 0 {
		var name [96]uint16
		count, _, _ := user32.NewProc("GetClassNameW").Call(root, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
		class := syscall.UTF16ToString(name[:count])
		var panel winRect
		ok, _, _ := user32.NewProc("GetWindowRect").Call(root, uintptr(unsafe.Pointer(&panel)))
		known := class == "NotifyIconOverflowWindow" || class == "TopLevelWindowForOverflowXamlIsland"
		if !known && class != "Shell_TrayWnd" && class != "Shell_SecondaryTrayWnd" {
			shell, _, _ := user32.NewProc("GetShellWindow").Call()
			var owner, shellOwner uint32
			process := user32.NewProc("GetWindowThreadProcessId")
			process.Call(root, uintptr(unsafe.Pointer(&owner)))
			process.Call(shell, uintptr(unsafe.Pointer(&shellOwner)))
			// Explorer can change the overflow class across releases. A compact shell popup
			// covering this notification icon is also an exclusion rectangle.
			w, h := panel.right-panel.left, panel.bottom-panel.top
			known = owner != 0 && owner == shellOwner && w >= 32 && w <= 720 && h >= 32 && h <= 720
		}
		if known && ok != 0 && x >= panel.left && x < panel.right && y >= panel.top && y < panel.bottom {
			params.exclude = panel
		}
	}
	flags := uintptr(0x0102 | 0x0040 | 0x10000) // return command, right button, vertical alignment, work area
	monitor, _, _ := user32.NewProc("MonitorFromRect").Call(uintptr(unsafe.Pointer(&params.exclude)), 2)
	info := monitorInfo{}
	info.size = uint32(unsafe.Sizeof(info))
	ok, _, _ := user32.NewProc("GetMonitorInfoW").Call(monitor, uintptr(unsafe.Pointer(&info)))
	if ok == 0 || y >= info.work.top+(info.work.bottom-info.work.top)/2 {
		y = params.exclude.top
		flags |= 0x0020 // bottom of menu meets top of exclusion
	} else {
		y = params.exclude.bottom
	}
	if ok != 0 && x >= info.work.left+(info.work.right-info.work.left)/2 {
		flags |= 0x0008
	} // right-aligned
	return x, y, flags, params
}

func runTray(url string, done <-chan struct{}) error {
	runtime.LockOSThread()
	// Use the same screen coordinates as Explorer on mixed-DPI displays.
	if set := user32.NewProc("SetProcessDpiAwarenessContext"); set.Find() == nil {
		set.Call(^uintptr(3))
	}
	defer runtime.UnlockOSThread()
	var icon trayIcon
	instance, _, _ := kernel32.NewProc("GetModuleHandleW").Call(0)
	icon.icon, _, _ = user32.NewProc("LoadIconW").Call(instance, 1) // packaged icon group
	if icon.icon == 0 {
		icon.icon, _, _ = user32.NewProc("LoadIconW").Call(0, 32512)
	}
	taskbarName := wide("TaskbarCreated")
	taskbarCreated, _, _ := user32.NewProc("RegisterWindowMessageW").Call(uintptr(unsafe.Pointer(taskbarName)))
	runtime.KeepAlive(taskbarName)
	notify := shell32.NewProc("Shell_NotifyIconW")
	sendIcon := func(action uintptr) bool {
		ok, _, _ := notify.Call(action, uintptr(unsafe.Pointer(&icon)))
		runtime.KeepAlive(&icon)
		return ok != 0
	}
	addIcon := func() bool {
		if !sendIcon(0) {
			return false
		} // NIM_ADD
		sendIcon(4) // NIM_SETVERSION
		return true
	}
	menu, _, err := user32.NewProc("CreatePopupMenu").Call()
	if menu == 0 {
		return err
	}
	defer user32.NewProc("DestroyMenu").Call(menu)
	for i, text := range []string{"打开审稿页", "退出审稿工具"} {
		label := wide(text)
		ok, _, err := user32.NewProc("AppendMenuW").Call(menu, 0, uintptr(i+1), uintptr(unsafe.Pointer(label)))
		runtime.KeepAlive(label)
		if ok == 0 {
			return err
		}
	}
	post := user32.NewProc("PostMessageW")
	quit := user32.NewProc("PostQuitMessage")
	showMenu := func(hwnd, x, y uintptr) {
		mx, my, flags, params := menuAnchor(icon, int32(x), int32(y))
		user32.NewProc("SetWindowPos").Call(hwnd, ^uintptr(0), 0, 0, 0, 0, 0x13) // topmost, without move/size/activate
		user32.NewProc("SetForegroundWindow").Call(hwnd)
		result, _, _ := user32.NewProc("TrackPopupMenuEx").Call(menu, flags, uintptr(mx), uintptr(my), hwnd, uintptr(unsafe.Pointer(&params)))
		post.Call(hwnd, 0, 0, 0) // Let Windows dismiss the menu cleanly on repeat opens.
		switch result {
		case 1:
			if err := openPage(url); err != nil {
				showProblem(err)
			}
		case 2:
			quit.Call(0)
		default:
			sendIcon(3) // NIM_SETFOCUS
		}
	}
	className := wide("DiffwriteTray")
	proc := syscall.NewCallback(func(hwnd, message, wparam, lparam uintptr) uintptr {
		switch message {
		case wmTray:
			switch uint16(lparam) {
			case wmContextMenu:
				showMenu(hwnd, uintptr(int32(int16(wparam))), uintptr(int32(int16(wparam>>16))))
			case 0x0205: // Legacy callback if setting the shell icon version failed.
				var point winPoint
				user32.NewProc("GetCursorPos").Call(uintptr(unsafe.Pointer(&point)))
				showMenu(hwnd, uintptr(point.x), uintptr(point.y))
			case ninSelect, ninKeySelect, 0x0203:
				if err := openPage(url); err != nil {
					showProblem(err)
				}
			}
			return 0
		case wmWorkerDone, 0x0010, 0x0016: // Backend exit, WM_CLOSE, WM_ENDSESSION
			if message != 0x0016 || wparam != 0 {
				quit.Call(0)
			}
			return 0
		default:
			if taskbarCreated != 0 && message == taskbarCreated {
				addIcon()
				return 0
			}
			result, _, _ := user32.NewProc("DefWindowProcW").Call(hwnd, message, wparam, lparam)
			return result
		}
	})
	class := windowClass{proc: proc, instance: instance, class: className}
	class.size = uint32(unsafe.Sizeof(class))
	atom, _, err := user32.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&class)))
	runtime.KeepAlive(&class)
	if atom == 0 {
		return err
	}
	hwnd, _, err := user32.NewProc("CreateWindowExW").Call(0x00000088, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(className)), 0x80000000, 0, 0, 0, 0, 0, 0, instance, 0)
	runtime.KeepAlive(className)
	if hwnd == 0 {
		return err
	}
	defer user32.NewProc("DestroyWindow").Call(hwnd)
	icon.size = uint32(unsafe.Sizeof(icon))
	icon.hwnd, icon.id, icon.flags, icon.callback, icon.version = hwnd, 1, 0x87, wmTray, 4 // MESSAGE | ICON | TIP | SHOWTIP
	tip, _ := syscall.UTF16FromString("Diffwrite · 逐句审稿")
	copy(icon.tip[:], tip)
	if !addIcon() {
		return fmt.Errorf("无法显示系统托盘图标。请确认 Windows 任务栏已启动。")
	}
	defer sendIcon(2) // NIM_DELETE
	if err := openPage(url); err != nil {
		showProblem(err)
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-done:
			post.Call(hwnd, wmWorkerDone, 0, 0)
		case <-stop:
		}
	}()
	for {
		var message winMessage
		n, _, err := user32.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		switch int32(n) {
		case -1:
			return err
		case 0:
			return nil
		}
		user32.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&message)))
		user32.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&message)))
	}
}

// Use the Windows HTTP stack for the loopback probe; no Go HTTP/TLS runtime in the EXE.
func health(port int) (bool, error) {
	win := syscall.NewLazyDLL("winhttp.dll")
	closeHandle := win.NewProc("WinHttpCloseHandle")
	agent, host, method, path := wide("Diffwrite"), wide("127.0.0.1"), wide("GET"), wide("/health")
	session, _, err := win.NewProc("WinHttpOpen").Call(uintptr(unsafe.Pointer(agent)), 1, 0, 0, 0) // NO_PROXY
	if session == 0 {
		return false, err
	}
	defer closeHandle.Call(session)
	win.NewProc("WinHttpSetTimeouts").Call(session, 450, 450, 450, 450)
	connection, _, err := win.NewProc("WinHttpConnect").Call(session, uintptr(unsafe.Pointer(host)), uintptr(port), 0)
	if connection == 0 {
		return false, err
	}
	defer closeHandle.Call(connection)
	request, _, err := win.NewProc("WinHttpOpenRequest").Call(connection, uintptr(unsafe.Pointer(method)), uintptr(unsafe.Pointer(path)), 0, 0, 0, 0)
	if request == 0 {
		return false, err
	}
	defer closeHandle.Call(request)
	const disableRedirects uint32 = 2
	options := disableRedirects
	ok, _, err := win.NewProc("WinHttpSetOption").Call(request, 63, uintptr(unsafe.Pointer(&options)), 4) // DISABLE_FEATURE
	if ok == 0 {
		return false, err
	}
	ok, _, _ = win.NewProc("WinHttpSendRequest").Call(request, 0, 0, 0, 0, 0, 0)
	if ok == 0 {
		return false, nil
	}
	ok, _, _ = win.NewProc("WinHttpReceiveResponse").Call(request, 0)
	if ok == 0 {
		return false, nil
	}
	var status uint32
	size := uint32(4)
	ok, _, err = win.NewProc("WinHttpQueryHeaders").Call(request, 19|0x20000000, 0, uintptr(unsafe.Pointer(&status)), uintptr(unsafe.Pointer(&size)), 0)
	if ok == 0 {
		return false, err
	}
	var body [100]byte
	var offset uint32
	read := win.NewProc("WinHttpReadData")
	for offset < uint32(len(body)) {
		var count uint32
		ok, _, err = read.Call(request, uintptr(unsafe.Pointer(&body[offset])), uintptr(uint32(len(body))-offset), uintptr(unsafe.Pointer(&count)))
		if ok == 0 {
			return false, err
		}
		if count == 0 {
			break
		}
		offset += count
	}
	value := string(body[:offset])
	if status == 200 && value == healthSignature {
		return true, nil
	}
	if status == 200 && strings.HasPrefix(value, "diffwrite-v") {
		return false, fmt.Errorf("请先退出旧版逐句审稿，再启动新版。")
	}
	return false, fmt.Errorf("本机审稿地址已被其他程序占用。")
}
