//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

func applyLaunchConfig() error {
	if os.Getenv("DIFFWRITE_REVIEW_DATA") != "" && os.Getenv("DIFFWRITE_REVIEW_PORT") != "" {
		return nil
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		var err error
		base, err = os.UserHomeDir()
		if err != nil {
			return err
		}
	}
	path := filepath.Join(base, "Diffwrite", "launch.json")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var config struct {
		DataDirectory string `json:"dataDirectory"`
		Port          int    `json:"port"`
	}
	if err = json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("无法读取本机启动配置 launch.json：%w", err)
	}
	if string(data) == "null" {
		return fmt.Errorf("本机启动配置无效")
	}
	if os.Getenv("DIFFWRITE_REVIEW_DATA") == "" && config.DataDirectory != "" {
		if !filepath.IsAbs(config.DataDirectory) {
			return fmt.Errorf("本机数据目录必须是绝对路径")
		}
		if err = os.Setenv("DIFFWRITE_REVIEW_DATA", config.DataDirectory); err != nil {
			return err
		}
	}
	if os.Getenv("DIFFWRITE_REVIEW_PORT") == "" && config.Port != 0 {
		if config.Port < 1 || config.Port > 65535 {
			return fmt.Errorf("本机审稿端口无效")
		}
		return os.Setenv("DIFFWRITE_REVIEW_PORT", strconv.Itoa(config.Port))
	}
	return nil
}
