package main

import (
	"fmt"
	"net"
	"testing"
)

func TestBenchmarkImportSourcePriorityAndOriginConflict(t *testing.T) {
	store := newModelBenchmarkStore(t.TempDir())
	record := completedBenchmarkForReport("origin-benchmark")
	record.OriginDeviceID = "device-a"
	record.OriginDeviceName = "테스트 PC A"
	record.OriginBenchmarkID = "origin-benchmark"

	first, err := store.importRecordsFromSource([]ModelBenchmark{record}, benchmarkSourceSync, nil)
	if err != nil || len(first.Imported) != 1 {
		t.Fatalf("sync import = %#v, %v", first, err)
	}
	stored, err := store.Open(first.Imported[0].ID)
	if err != nil || stored.Source != benchmarkSourceSync {
		t.Fatalf("stored sync record = %#v, %v", stored, err)
	}

	// The same payload imported through a report must not be duplicated. Its
	// stronger report provenance replaces the weaker sync provenance instead.
	report, err := store.importRecordsFromSource([]ModelBenchmark{record}, benchmarkSourceReport, nil)
	if err != nil || report.DuplicateCount != 1 || report.UpgradedCount != 1 {
		t.Fatalf("report upgrade = %#v, %v", report, err)
	}
	stored, err = store.Open(stored.ID)
	if err != nil || stored.Source != benchmarkSourceReport || !stored.Imported {
		t.Fatalf("upgraded record = %#v, %v", stored, err)
	}

	conflicting := record
	conflicting.ID = "another-local-id"
	conflicting.Model = "changed-model"
	conflicting.UpdatedAt = "2026-09-10T01:02:04Z"
	conflict, err := store.importRecordsFromSource([]ModelBenchmark{conflicting}, benchmarkSourceSync, nil)
	if err != nil || conflict.ConflictCount != 1 || len(conflict.Imported) != 0 {
		t.Fatalf("origin conflict = %#v, %v", conflict, err)
	}
}

func TestBenchmarkSyncPairingAndPush(t *testing.T) {
	storeA := newModelBenchmarkStore(t.TempDir())
	storeB := newModelBenchmarkStore(t.TempDir())
	syncRootA := t.TempDir()
	syncRootB := t.TempDir()
	syncA := newBenchmarkSyncStore(syncRootA, storeA)
	syncB := newBenchmarkSyncStore(syncRootB, storeB)
	t.Cleanup(func() { _ = syncA.Close(); _ = syncB.Close() })

	if _, err := syncA.State(); err != nil {
		t.Fatalf("syncA State() error = %v", err)
	}
	if _, err := syncB.State(); err != nil {
		t.Fatalf("syncB State() error = %v", err)
	}
	if _, err := syncB.UpdateDeviceName("테스트 PC B"); err != nil {
		t.Fatalf("syncB UpdateDeviceName() error = %v", err)
	}
	stateA, err := syncA.CreatePairingCode()
	if err != nil {
		t.Fatalf("CreatePairingCode() error = %v", err)
	}
	addressA := fmt.Sprintf("http://127.0.0.1:%d", syncA.listener.Addr().(*net.TCPAddr).Port)
	stateB, err := syncB.StartPairing(addressA, stateA.PairingCode)
	if err != nil || len(stateB.OutgoingRequests) != 1 {
		t.Fatalf("StartPairing() = %#v, %v", stateB, err)
	}
	stateA, err = syncA.State()
	if err != nil || len(stateA.IncomingRequests) != 1 {
		t.Fatalf("incoming request = %#v, %v", stateA, err)
	}
	if _, err := syncA.ApprovePairing(stateA.IncomingRequests[0].RequestID); err != nil {
		t.Fatalf("ApprovePairing() error = %v", err)
	}
	stateB, err = syncB.CheckPairing(stateB.OutgoingRequests[0].RequestID)
	if err != nil || len(stateB.Peers) != 1 {
		t.Fatalf("CheckPairing() = %#v, %v", stateB, err)
	}
	if err := syncB.Close(); err != nil {
		t.Fatalf("syncB Close() error = %v", err)
	}
	syncB = newBenchmarkSyncStore(syncRootB, storeB)
	stateB, err = syncB.State()
	if err != nil || len(stateB.Peers) != 1 {
		t.Fatalf("reopened syncB State() = %#v, %v", stateB, err)
	}

	local := completedBenchmarkForReport("benchmark-b")
	created, err := storeB.Create(local)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := storeB.Save(created); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if _, err := syncB.Run(stateB.Peers[0].DeviceID, "push"); err != nil {
		t.Fatalf("Run(push) error = %v", err)
	}
	summaries, err := storeA.List()
	if err != nil || len(summaries) != 1 || summaries[0].Source != benchmarkSourceSync || summaries[0].OriginDeviceName != "테스트 PC B" {
		t.Fatalf("synced summaries = %#v, %v", summaries, err)
	}
}
