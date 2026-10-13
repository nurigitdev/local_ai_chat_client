package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDecisionDatasetExportWritesSupportedFiles(t *testing.T) {
	app := NewApp()
	for _, item := range []struct{ name, contents string }{
		{"suite.json", `{"name":"한국어·영어 테스트셋"}`},
		{"cases.csv", "\ufeffid,text,expected\r\nko-1,한국어,true\r\n"},
	} {
		t.Run(item.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), item.name)
			if err := app.SaveDecisionDatasetExport(path, item.contents); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != item.contents {
				t.Fatalf("export = %q, err = %v", got, err)
			}
		})
	}
}

func TestDecisionDatasetExportRejectsInvalidInputBeforeWriting(t *testing.T) {
	app := NewApp()
	for _, item := range []struct{ name, contents string }{
		{"suite.txt", `{}`},
		{"suite.json", `not json`},
		{"suite.csv", strings.Repeat("x", maxDecisionDatasetExportBytes+1)},
	} {
		t.Run(item.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), item.name)
			if err := os.WriteFile(path, []byte("existing"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := app.SaveDecisionDatasetExport(path, item.contents); err == nil {
				t.Fatal("accepted invalid export")
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != "existing" {
				t.Fatalf("changed file after rejected export: %q, %v", got, err)
			}
		})
	}
	if err := app.SaveDecisionDatasetExport(" ", `{}`); err == nil {
		t.Fatal("accepted an empty path")
	}
}
