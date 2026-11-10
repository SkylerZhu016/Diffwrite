//go:build windows

package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	_ "embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/ulikunitz/xz"
)

//go:embed app.tar.xz
var payload []byte

var buildID string

var allowed = map[string]bool{
	"node.exe": true, "index.html": true, "style.css": true, "server.mjs": true,
	"app.mjs": true, "model.mjs": true, "docx.mjs": true, "markdown.mjs": true,
	"changes.mjs": true, "history.mjs": true, "opinion-ai.mjs": true, "opinion-ui.mjs": true, "opinion-prompt.txt": true, "review-api.mjs": true,
	"review-store.mjs": true, "review-mcp.mjs": true, "vendor/markdown-parser.mjs": true,
	"vendor/mcp-sdk.mjs": true, "THIRD_PARTY_NOTICES.txt": true,
}

func unpack(dir string) error {
	reader, err := (xz.ReaderConfig{DictCap: 32 << 20, SingleStream: true}).NewReader(bytes.NewReader(payload))
	if err != nil {
		return err
	}
	ar := tar.NewReader(reader)
	seen := make(map[string]bool)
	for {
		h, err := ar.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := h.Name
		if !allowed[name] || seen[name] || h.Typeflag != tar.TypeReg || h.Size < 0 || h.Size > 150<<20 {
			return fmt.Errorf("unexpected archive entry: %q", name)
		}
		seen[name] = true
		dest := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
			return err
		}
		file, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, copied := io.CopyN(file, ar, h.Size)
		closed := file.Close()
		if copied != nil {
			return copied
		}
		if closed != nil {
			return closed
		}
	}
	if len(seen) != len(allowed) {
		return fmt.Errorf("archive is incomplete")
	}
	// Read through the XZ trailer and validate its checksum before marking the directory complete.
	_, err = io.Copy(io.Discard, reader)
	return err
}

func runtimePath() (string, error) {
	if buildID == "" {
		return "", fmt.Errorf("missing package identifier")
	}
	root := os.Getenv("DIFFWRITE_REVIEW_RUNTIME")
	if root == "" {
		base, err := os.UserCacheDir()
		if err != nil {
			return "", err
		}
		root = filepath.Join(base, "DiffwriteRuntime")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	dest := filepath.Join(root, buildID)
	ready := func() bool {
		stamp, err := os.ReadFile(filepath.Join(dest, ".ready"))
		if err != nil || string(stamp) != buildID {
			return false
		}
		for name := range allowed {
			stat, err := os.Stat(filepath.Join(dest, filepath.FromSlash(name)))
			if err != nil || !stat.Mode().IsRegular() {
				return false
			}
		}
		return true
	}
	if ready() {
		return dest, nil
	}
	temp, err := os.MkdirTemp(root, ".unpack-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(temp) // Private temporary directory returned by MkdirTemp in this call.
	if err := unpack(temp); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(temp, ".ready"), []byte(buildID), 0600); err != nil {
		return "", err
	}
	if err := os.Rename(temp, dest); err != nil {
		if ready() {
			return dest, nil
		}
		return "", fmt.Errorf("could not complete runtime cache %q: %w", dest, err)
	}
	return dest, nil
}

// Keep the review worker tied to this launcher, but leave the browser independent.
func ownWorker(pid int) (syscall.Handle, error) {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	job, _, err := kernel.NewProc("CreateJobObjectW").Call(0, 0)
	if job == 0 {
		return 0, err
	}
	handle := syscall.Handle(job)
	success := false
	defer func() {
		if !success {
			_ = syscall.CloseHandle(handle)
		}
	}()
	type basicLimits struct {
		perProcessTime, perJobTime   int64
		flags                        uint32
		minWorkingSet, maxWorkingSet uintptr
		activeProcessLimit           uint32
		affinity                     uintptr
		priority, scheduling         uint32
	}
	type extendedLimits struct {
		basic                                                      basicLimits
		io                                                         [6]uint64
		processMemory, jobMemory, peakProcessMemory, peakJobMemory uintptr
	}
	const extendedClass = 9
	const silentBreakaway = 0x00001000
	const killOnClose = 0x00002000
	const workerAccess = 0x0100 | 0x0001 // PROCESS_SET_QUOTA | PROCESS_TERMINATE
	limits := extendedLimits{basic: basicLimits{flags: silentBreakaway | killOnClose}}
	ok, _, err := kernel.NewProc("SetInformationJobObject").Call(job, extendedClass,
		uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	runtime.KeepAlive(limits)
	if ok == 0 {
		return 0, err
	}
	worker, err := syscall.OpenProcess(workerAccess, false, uint32(pid))
	if err != nil {
		return 0, err
	}
	defer syscall.CloseHandle(worker)
	ok, _, err = kernel.NewProc("AssignProcessToJobObject").Call(job, uintptr(worker))
	if ok == 0 {
		return 0, err
	}
	success = true
	return handle, nil
}

const healthSignature = "diffwrite-v9"

func run() error {
	if len(os.Args) > 2 || (len(os.Args) == 2 && os.Args[1] != "--no-browser" && os.Args[1] != "--licenses") {
		return fmt.Errorf("usage: Diffwrite [--no-browser | --licenses]")
	}
	if len(os.Args) == 2 && os.Args[1] == "--licenses" {
		dir, err := runtimePath()
		if err != nil {
			return err
		}
		text, err := os.ReadFile(filepath.Join(dir, "THIRD_PARTY_NOTICES.txt"))
		if err != nil {
			return err
		}
		return writeLicenses(text)
	}
	interactive := len(os.Args) == 1
	port := 41732
	if raw := os.Getenv("DIFFWRITE_REVIEW_PORT"); raw != "" {
		var err error
		port, err = strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("本机审稿端口无效。")
		}
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)
	mutex, already, err := instanceMutex(port)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(mutex)
	// A second click during extraction waits for the owner instead of starting a second worker.
	deadline := time.Now()
	if already {
		deadline = deadline.Add(30 * time.Second)
	}
	for {
		running, err := health(port)
		if running {
			if interactive {
				return openPage(url)
			}
			return nil
		}
		if err != nil {
			return err
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(160 * time.Millisecond)
	}
	if already {
		return fmt.Errorf("已有审稿工具正在启动，请稍后再试。")
	}

	dir, err := runtimePath()
	if err != nil {
		return err
	}
	cmd := exec.Command(filepath.Join(dir, "node.exe"), filepath.Join(dir, "server.mjs"), "--managed")
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(key, "NODE_OPTIONS") || strings.EqualFold(key, "NODE_PATH") || strings.EqualFold(key, "DIFFWRITE_REVIEW_PORT") {
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Env = append(cmd.Env, "DIFFWRITE_REVIEW_PORT="+strconv.Itoa(port))
	pipeR, pipeW, err := os.Pipe()
	if err != nil {
		return err
	}
	defer pipeR.Close()
	defer pipeW.Close()
	cmd.Stdin = pipeR
	workerOutR, workerOutW, err := os.Pipe()
	if err != nil {
		return err
	}
	defer workerOutR.Close()
	defer workerOutW.Close()
	cmd.Stdout = workerOutW
	var workerErr bytes.Buffer
	cmd.Stderr = &workerErr
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = pipeR.Close()
	_ = workerOutW.Close()
	done := make(chan struct{})
	var waitErr error
	go func() { waitErr = cmd.Wait(); close(done) }()
	job, err := ownWorker(cmd.Process.Pid)
	if err != nil {
		_ = cmd.Process.Kill()
		<-done
		return fmt.Errorf("无法管理审稿后台：%w", err)
	}
	defer syscall.CloseHandle(job)
	defer func() {
		_ = pipeW.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	}()
	ready := make(chan struct{}, 1)
	go func() {
		scanner := bufio.NewScanner(workerOutR)
		for scanner.Scan() {
			if scanner.Text() == "DIFFWRITE_READY" {
				select {
				case ready <- struct{}{}:
				default:
				}
			}
		}
	}()
	failure := func() error {
		if msg := strings.TrimSpace(workerErr.String()); msg != "" {
			return fmt.Errorf("审稿后台已停止：%s", msg)
		}
		if waitErr != nil {
			return fmt.Errorf("审稿后台已停止：%w", waitErr)
		}
		return fmt.Errorf("审稿后台意外退出。")
	}
	select {
	case <-ready:
	case <-done:
		return failure()
	case <-time.After(15 * time.Second):
		return fmt.Errorf("本机审稿后台启动超时。")
	}
	if interactive {
		if err := runTray(url, done); err != nil {
			return err
		}
		select {
		case <-done:
			return failure()
		default:
			return nil
		}
	}
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(interrupt)
	select {
	case <-done:
		return failure()
	case <-interrupt:
		return nil
	}
}

func main() {
	if err := run(); err != nil {
		if len(os.Args) == 1 {
			showProblem(err)
		} else {
			fmt.Fprintln(os.Stderr, "Diffwrite:", err)
		}
		os.Exit(1)
	}
}
