package main

import (
	"fmt"
	"net"
	"testing"
	"time"
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

func TestBenchmarkSyncResetSessionClearsConnectionState(t *testing.T) {
	syncStore := newBenchmarkSyncStore(t.TempDir(), newModelBenchmarkStore(t.TempDir()))
	t.Cleanup(func() { _ = syncStore.Close() })
	initial, err := syncStore.State()
	if err != nil {
		t.Fatalf("State() error = %v", err)
	}

	syncStore.mu.Lock()
	syncStore.state.DeviceName = "임시 동기화 PC"
	syncStore.state.PairingCode = "ABCD-EFGH"
	syncStore.state.PairingExpiresAt = time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	syncStore.state.Peers = []BenchmarkSyncPeer{{DeviceID: "peer-a", DeviceName: "다른 PC", Address: "http://127.0.0.1:39391"}}
	syncStore.state.PeerInboundTokens = map[string]string{"peer-a": "inbound-token"}
	syncStore.state.PeerOutboundTokens = map[string]string{"peer-a": "outbound-token"}
	syncStore.state.Incoming = []BenchmarkSyncPairRequest{{RequestID: "incoming-request", Status: "pending"}}
	syncStore.state.Outgoing = []BenchmarkSyncPairRequest{{RequestID: "outgoing-request", Status: "pending"}}
	syncStore.state.PairSecrets = map[string]benchmarkSyncPairSecrets{"incoming-request": {RequesterToken: "request-token"}}
	syncStore.state.Logs = []BenchmarkSyncLog{{ID: "sync-log", Direction: "bidirectional", Status: "completed"}}
	syncStore.state.Ignored = []string{"preserve-this-fingerprint"}
	if err := syncStore.saveLocked(); err != nil {
		syncStore.mu.Unlock()
		t.Fatalf("saveLocked() error = %v", err)
	}
	syncStore.mu.Unlock()

	if err := syncStore.ResetSession(); err != nil {
		t.Fatalf("ResetSession() error = %v", err)
	}
	next, err := syncStore.State()
	if err != nil {
		t.Fatalf("State() after ResetSession error = %v", err)
	}
	if next.DeviceID != initial.DeviceID || next.DeviceName == "임시 동기화 PC" {
		t.Fatalf("session identity was not reset: %#v", next)
	}
	if next.PairingCode != "" || len(next.Peers) != 0 || len(next.IncomingRequests) != 0 || len(next.OutgoingRequests) != 0 || len(next.Logs) != 0 {
		t.Fatalf("session state was not cleared: %#v", next)
	}
	syncStore.mu.Lock()
	ignored := append([]string(nil), syncStore.state.Ignored...)
	syncStore.mu.Unlock()
	if len(ignored) != 1 || ignored[0] != "preserve-this-fingerprint" {
		t.Fatalf("ignored fingerprints were not preserved: %#v", ignored)
	}
}
