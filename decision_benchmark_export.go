package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const maxDecisionDatasetExportBytes = 5 * 1024 * 1024

// SaveDecisionDatasetExport saves a GUI-authored suite or case list at the
// path selected by the desktop save dialog. It does not execute a benchmark.
func (a *App) SaveDecisionDatasetExport(path, contents string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return errors.New("저장할 파일을 선택해 주세요")
	}
	if len(contents) > maxDecisionDatasetExportBytes {
		return errors.New("테스트셋 파일은 5MB 이하여야 합니다")
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".json":
		if !json.Valid([]byte(contents)) {
			return errors.New("올바른 JSON 테스트셋이 아닙니다")
		}
	case ".csv":
	default:
		return errors.New("JSON 또는 CSV 파일로만 저장할 수 있습니다")
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		return fmt.Errorf("테스트셋 파일을 저장할 수 없습니다: %w", err)
	}
	return nil
}
