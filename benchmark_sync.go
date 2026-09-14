package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	benchmarkSyncFileName    = "benchmark-sync.json"
	benchmarkSyncPathPrefix  = "/agent-chat/benchmark-sync/v1"
	benchmarkSyncPort        = 39391
	benchmarkSyncCodeTTL     = 10 * time.Minute
	benchmarkSyncMaxLogCount = 200
	benchmarkSyncMaxBodySize = 50 << 20
)

// BenchmarkSyncPeer is a trusted device. Its secret tokens are kept separately
// in the local settings file and are never returned to the frontend.
type BenchmarkSyncPeer struct {
	DeviceID    string `json:"deviceID"`
	DeviceName  string `json:"deviceName"`
	Address     string `json:"address"`
	ConnectedAt string `json:"connectedAt"`
	Token       string `json:"-"`
}

type BenchmarkSyncPairRequest struct {
	RequestID  string `json:"requestID"`
	DeviceID   string `json:"deviceID"`
	DeviceName string `json:"deviceName"`
	Address    string `json:"address"`
	CreatedAt  string `json:"createdAt"`
	Status     string `json:"status"`
}

type benchmarkSyncPairSecrets struct {
	PairingCode    string `json:"pairingCode"`
	RequesterToken string `json:"requesterToken"`
	ResponderToken string `json:"responderToken,omitempty"`
}

type BenchmarkSyncLog struct {
	ID             string `json:"id"`
	OccurredAt     string `json:"occurredAt"`
	PeerDeviceID   string `json:"peerDeviceID,omitempty"`
	PeerDeviceName string `json:"peerDeviceName,omitempty"`
	Direction      string `json:"direction"`
	Status         string `json:"status"`
	SentCount      int    `json:"sentCount"`
	ReceivedCount  int    `json:"receivedCount"`
	DuplicateCount int    `json:"duplicateCount"`
	IgnoredCount   int    `json:"ignoredCount"`
	ConflictCount  int    `json:"conflictCount"`
	Message        string `json:"message,omitempty"`
}

type BenchmarkSyncState struct {
	DeviceID         string                     `json:"deviceID"`
	DeviceName       string                     `json:"deviceName"`
	LocalAddresses   []string                   `json:"localAddresses"`
	PairingCode      string                     `json:"pairingCode,omitempty"`
	PairingExpiresAt string                     `json:"pairingExpiresAt,omitempty"`
	Peers            []BenchmarkSyncPeer        `json:"peers"`
	IncomingRequests []BenchmarkSyncPairRequest `json:"incomingRequests"`
	OutgoingRequests []BenchmarkSyncPairRequest `json:"outgoingRequests"`
	Logs             []BenchmarkSyncLog         `json:"logs"`
}

type benchmarkSyncPersistentState struct {
	DeviceID           string                              `json:"deviceID"`
	DeviceName         string                              `json:"deviceName"`
	PairingCode        string                              `json:"pairingCode,omitempty"`
	PairingExpiresAt   string                              `json:"pairingExpiresAt,omitempty"`
	Peers              []BenchmarkSyncPeer                 `json:"peers"`
	PeerInboundTokens  map[string]string                   `json:"peerInboundTokens"`
	PeerOutboundTokens map[string]string                   `json:"peerOutboundTokens"`
	Incoming           []BenchmarkSyncPairRequest          `json:"incoming"`
	Outgoing           []BenchmarkSyncPairRequest          `json:"outgoing"`
	PairSecrets        map[string]benchmarkSyncPairSecrets `json:"pairSecrets"`
	Logs               []BenchmarkSyncLog                  `json:"logs"`
	Ignored            []string                            `json:"ignored"`
}

type benchmarkSyncStore struct {
	root       string
	benchmarks *modelBenchmarkStore

	mu       sync.Mutex
	loaded   bool
	state    benchmarkSyncPersistentState
	listener net.Listener
	server   *http.Server
	client   *http.Client
}

type benchmarkSyncPairPayload struct {
	Code           string `json:"code"`
	RequestID      string `json:"requestID"`
	DeviceID       string `json:"deviceID"`
	DeviceName     string `json:"deviceName"`
	CallbackURL    string `json:"callbackURL"`
	RequesterToken string `json:"requesterToken"`
}

type benchmarkSyncPairStatusPayload struct {
	Status         string `json:"status"`
	DeviceID       string `json:"deviceID,omitempty"`
	DeviceName     string `json:"deviceName,omitempty"`
	ResponderToken string `json:"responderToken,omitempty"`
	Message        string `json:"message,omitempty"`
}

type benchmarkSyncRecordsPayload struct {
	Version int              `json:"version"`
	Records []ModelBenchmark `json:"records"`
}

func newBenchmarkSyncStore(root string, benchmarks *modelBenchmarkStore) *benchmarkSyncStore {
	return &benchmarkSyncStore{
		root:       root,
		benchmarks: benchmarks,
		client:     &http.Client{Timeout: 20 * time.Second},
	}
}

func (s *benchmarkSyncStore) State() (BenchmarkSyncState, error) {
	if err := s.ensureServer(); err != nil {
		return BenchmarkSyncState{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	return s.publicStateLocked(), nil
}

func (s *benchmarkSyncStore) UpdateDeviceName(name string) (BenchmarkSyncState, error) {
	if err := s.ensureServer(); err != nil {
		return BenchmarkSyncState{}, err
	}
	name, err := normalizeBenchmarkSyncDeviceName(name)
	if err != nil {
		return BenchmarkSyncState{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	s.state.DeviceName = name
	if err := s.saveLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	return s.publicStateLocked(), nil
}

func (s *benchmarkSyncStore) CreatePairingCode() (BenchmarkSyncState, error) {
	if err := s.ensureServer(); err != nil {
		return BenchmarkSyncState{}, err
	}
	code, err := newBenchmarkSyncSecret(8)
	if err != nil {
		return BenchmarkSyncState{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	s.state.PairingCode = strings.ToUpper(code[:4] + "-" + code[4:])
	s.state.PairingExpiresAt = time.Now().Add(benchmarkSyncCodeTTL).UTC().Format(time.RFC3339Nano)
	if err := s.saveLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	return s.publicStateLocked(), nil
}

func (s *benchmarkSyncStore) StartPairing(address, code string) (BenchmarkSyncState, error) {
	if err := s.ensureServer(); err != nil {
		return BenchmarkSyncState{}, err
	}
	address, err := normalizeBenchmarkSyncAddress(address)
	if err != nil {
		return BenchmarkSyncState{}, err
	}
	code = normalizeBenchmarkSyncCode(code)
	if code == "" {
		return BenchmarkSyncState{}, errors.New("상대방이 표시한 일회용 코드를 입력해 주세요")
	}
	requesterToken, err := newBenchmarkSyncSecret(32)
	if err != nil {
		return BenchmarkSyncState{}, err
	}

	s.mu.Lock()
	if err := s.ensureLoadedLocked(); err != nil {
		s.mu.Unlock()
		return BenchmarkSyncState{}, err
	}
	callbackURL := s.callbackURLLocked()
	request := BenchmarkSyncPairRequest{
		RequestID:  newConversationID(),
		DeviceID:   s.state.DeviceID,
		DeviceName: s.state.DeviceName,
		Address:    address,
		CreatedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Status:     "pending",
	}
	s.state.Outgoing = upsertPairRequest(s.state.Outgoing, request)
	if s.state.PairSecrets == nil {
		s.state.PairSecrets = make(map[string]benchmarkSyncPairSecrets)
	}
	s.state.PairSecrets[request.RequestID] = benchmarkSyncPairSecrets{PairingCode: code, RequesterToken: requesterToken}
	if err := s.saveLocked(); err != nil {
		s.mu.Unlock()
		return BenchmarkSyncState{}, err
	}
	s.mu.Unlock()

	payload := benchmarkSyncPairPayload{
		Code:           code,
		RequestID:      request.RequestID,
		DeviceID:       request.DeviceID,
		DeviceName:     request.DeviceName,
		CallbackURL:    callbackURL,
		RequesterToken: requesterToken,
	}
	var response benchmarkSyncPairStatusPayload
	if err := s.doJSON(http.MethodPost, address+benchmarkSyncPathPrefix+"/pair", "", payload, &response); err != nil {
		s.setOutgoingPairStatus(request.RequestID, "failed", err.Error())
		return BenchmarkSyncState{}, fmt.Errorf("상대 PC에 연결 요청을 보낼 수 없습니다: %w", err)
	}
	if response.Status != "pending" && response.Status != "accepted" {
		s.setOutgoingPairStatus(request.RequestID, "rejected", response.Message)
		return BenchmarkSyncState{}, errors.New("상대 PC가 연결 요청을 받지 않았습니다")
	}
	if response.Status == "accepted" {
		return s.completeOutgoingPairing(request.RequestID, response)
	}
	return s.State()
}

func (s *benchmarkSyncStore) CheckPairing(requestID string) (BenchmarkSyncState, error) {
	requestID = strings.TrimSpace(requestID)
	if !isSafeConversationID(requestID) {
		return BenchmarkSyncState{}, errors.New("올바르지 않은 연결 요청입니다")
	}
	s.mu.Lock()
	if err := s.ensureLoadedLocked(); err != nil {
		s.mu.Unlock()
		return BenchmarkSyncState{}, err
	}
	request, ok := findPairRequest(s.state.Outgoing, requestID)
	secrets := s.state.PairSecrets[requestID]
	if !ok {
		s.mu.Unlock()
		return BenchmarkSyncState{}, errors.New("연결 요청을 찾을 수 없습니다")
	}
	s.mu.Unlock()
	if request.Status != "pending" {
		return s.State()
	}
	var response benchmarkSyncPairStatusPayload
	if err := s.doJSON(http.MethodGet, request.Address+benchmarkSyncPathPrefix+"/pair/"+url.PathEscape(requestID), secrets.PairingCode, nil, &response); err != nil {
		s.setOutgoingPairStatus(requestID, "failed", err.Error())
		return BenchmarkSyncState{}, fmt.Errorf("상대 PC의 연결 승인 상태를 확인할 수 없습니다: %w", err)
	}
	switch response.Status {
	case "pending":
		return s.State()
	case "accepted":
		return s.completeOutgoingPairing(requestID, response)
	case "rejected":
		s.setOutgoingPairStatus(requestID, "rejected", response.Message)
		return s.State()
	default:
		return BenchmarkSyncState{}, errors.New("상대 PC의 연결 승인 응답이 올바르지 않습니다")
	}
}

func (s *benchmarkSyncStore) ApprovePairing(requestID string) (BenchmarkSyncState, error) {
	requestID = strings.TrimSpace(requestID)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	index := pairRequestIndex(s.state.Incoming, requestID)
	if index < 0 {
		return BenchmarkSyncState{}, errors.New("연결 요청을 찾을 수 없습니다")
	}
	request := &s.state.Incoming[index]
	if request.Status != "pending" {
		return BenchmarkSyncState{}, errors.New("이미 처리한 연결 요청입니다")
	}
	responderToken, err := newBenchmarkSyncSecret(32)
	if err != nil {
		return BenchmarkSyncState{}, err
	}
	request.Status = "accepted"
	secrets := s.state.PairSecrets[requestID]
	if secrets.RequesterToken == "" {
		return BenchmarkSyncState{}, errors.New("연결 요청의 인증 정보가 없습니다")
	}
	secrets.ResponderToken = responderToken
	s.state.PairSecrets[requestID] = secrets
	s.state.Peers = upsertSyncPeer(s.state.Peers, BenchmarkSyncPeer{
		DeviceID: request.DeviceID, DeviceName: request.DeviceName, Address: request.Address,
		ConnectedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if s.state.PeerInboundTokens == nil {
		s.state.PeerInboundTokens = make(map[string]string)
	}
	s.state.PeerInboundTokens[request.DeviceID] = responderToken
	if s.state.PeerOutboundTokens == nil {
		s.state.PeerOutboundTokens = make(map[string]string)
	}
	s.state.PeerOutboundTokens[request.DeviceID] = secrets.RequesterToken
	if err := s.saveLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	return s.publicStateLocked(), nil
}

func (s *benchmarkSyncStore) RejectPairing(requestID string) (BenchmarkSyncState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	index := pairRequestIndex(s.state.Incoming, strings.TrimSpace(requestID))
	if index < 0 {
		return BenchmarkSyncState{}, errors.New("연결 요청을 찾을 수 없습니다")
	}
	if s.state.Incoming[index].Status != "pending" {
		return BenchmarkSyncState{}, errors.New("이미 처리한 연결 요청입니다")
	}
	s.state.Incoming[index].Status = "rejected"
	if err := s.saveLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	return s.publicStateLocked(), nil
}

func (s *benchmarkSyncStore) DeletePeer(deviceID string) (BenchmarkSyncState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	index := syncPeerIndex(s.state.Peers, strings.TrimSpace(deviceID))
	if index < 0 {
		return BenchmarkSyncState{}, errors.New("연결된 PC를 찾을 수 없습니다")
	}
	s.state.Peers = append(s.state.Peers[:index], s.state.Peers[index+1:]...)
	deviceID = strings.TrimSpace(deviceID)
	delete(s.state.PeerInboundTokens, deviceID)
	delete(s.state.PeerOutboundTokens, deviceID)
	if err := s.saveLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	return s.publicStateLocked(), nil
}

func (s *benchmarkSyncStore) ClearLogs() (BenchmarkSyncState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	s.state.Logs = nil
	if err := s.saveLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	return s.publicStateLocked(), nil
}

func (s *benchmarkSyncStore) IgnoreBenchmark(benchmark ModelBenchmark) error {
	fingerprint, err := benchmarkImportFingerprint(benchmark)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return err
	}
	encoded := hex.EncodeToString(fingerprint[:])
	for _, current := range s.state.Ignored {
		if current == encoded {
			return nil
		}
	}
	s.state.Ignored = append(s.state.Ignored, encoded)
	return s.saveLocked()
}

func (s *benchmarkSyncStore) Run(deviceID, direction string) (BenchmarkSyncState, error) {
	direction = strings.TrimSpace(strings.ToLower(direction))
	if direction != "push" && direction != "pull" && direction != "bidirectional" {
		return BenchmarkSyncState{}, errors.New("올바른 동기화 방향을 선택해 주세요")
	}
	s.mu.Lock()
	if err := s.ensureLoadedLocked(); err != nil {
		s.mu.Unlock()
		return BenchmarkSyncState{}, err
	}
	peerIndex := syncPeerIndex(s.state.Peers, strings.TrimSpace(deviceID))
	if peerIndex < 0 {
		s.mu.Unlock()
		return BenchmarkSyncState{}, errors.New("연결된 PC를 찾을 수 없습니다")
	}
	peer := s.state.Peers[peerIndex]
	peer.Token = s.state.PeerOutboundTokens[peer.DeviceID]
	if peer.Token == "" {
		s.mu.Unlock()
		return BenchmarkSyncState{}, errors.New("연결된 PC의 인증 정보가 없습니다. 연결을 해제한 뒤 다시 연결해 주세요")
	}
	s.mu.Unlock()

	log := BenchmarkSyncLog{ID: newConversationID(), OccurredAt: time.Now().UTC().Format(time.RFC3339Nano), PeerDeviceID: peer.DeviceID, PeerDeviceName: peer.DeviceName, Direction: direction, Status: "completed"}
	var runErr error
	if direction == "pull" || direction == "bidirectional" {
		var recordsPayload benchmarkSyncRecordsPayload
		if err := s.doJSON(http.MethodGet, peer.Address+benchmarkSyncPathPrefix+"/records", peer.Token, nil, &recordsPayload); err != nil {
			runErr = fmt.Errorf("받기 실패: %w", err)
		} else if recordsPayload.Version != 1 {
			runErr = errors.New("상대 PC의 동기화 형식 버전을 지원하지 않습니다")
		} else {
			outcome, err := s.importSyncedRecords(recordsPayload.Records)
			if err != nil {
				runErr = fmt.Errorf("받기 실패: %w", err)
			} else {
				log.ReceivedCount += len(outcome.Imported)
				log.DuplicateCount += outcome.DuplicateCount
				log.IgnoredCount += outcome.IgnoredCount
				log.ConflictCount += outcome.ConflictCount
			}
		}
	}
	if runErr == nil && (direction == "push" || direction == "bidirectional") {
		records, err := s.recordsForSync()
		if err != nil {
			runErr = fmt.Errorf("보내기 준비 실패: %w", err)
		} else {
			var outcome benchmarkRecordImportOutcome
			err = s.doJSON(http.MethodPost, peer.Address+benchmarkSyncPathPrefix+"/records", peer.Token, benchmarkSyncRecordsPayload{Version: 1, Records: records}, &outcome)
			if err != nil {
				runErr = fmt.Errorf("보내기 실패: %w", err)
			} else {
				log.SentCount = len(records)
				log.DuplicateCount += outcome.DuplicateCount
				log.IgnoredCount += outcome.IgnoredCount
				log.ConflictCount += outcome.ConflictCount
			}
		}
	}
	if runErr != nil {
		log.Status = "failed"
		log.Message = runErr.Error()
	}
	s.appendLog(log)
	if runErr != nil {
		return BenchmarkSyncState{}, runErr
	}
	return s.State()
}

func (s *benchmarkSyncStore) Close() error {
	s.mu.Lock()
	server := s.server
	listener := s.listener
	s.server = nil
	s.listener = nil
	s.mu.Unlock()
	if server != nil {
		return server.Close()
	}
	if listener != nil {
		return listener.Close()
	}
	return nil
}

func (s *benchmarkSyncStore) ensureServer() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return err
	}
	if s.listener != nil {
		return nil
	}
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", benchmarkSyncPort))
	if err != nil {
		listener, err = net.Listen("tcp", ":0")
		if err != nil {
			return fmt.Errorf("동기화 연결을 받을 수 없습니다: %w", err)
		}
	}
	s.listener = listener
	s.server = &http.Server{Handler: http.HandlerFunc(s.serveHTTP), ReadHeaderTimeout: 5 * time.Second}
	go func(server *http.Server, listener net.Listener) { _ = server.Serve(listener) }(s.server, listener)
	return nil
}

func (s *benchmarkSyncStore) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	path := request.URL.Path
	switch {
	case path == benchmarkSyncPathPrefix+"/pair" && request.Method == http.MethodPost:
		s.handlePairRequest(writer, request)
	case strings.HasPrefix(path, benchmarkSyncPathPrefix+"/pair/") && request.Method == http.MethodGet:
		s.handlePairStatus(writer, request, strings.TrimPrefix(path, benchmarkSyncPathPrefix+"/pair/"))
	case path == benchmarkSyncPathPrefix+"/records" && request.Method == http.MethodGet:
		peer, ok := s.authorizedPeer(request)
		if !ok {
			writeSyncError(writer, http.StatusUnauthorized, "연결된 PC의 인증 정보가 필요합니다")
			return
		}
		records, err := s.recordsForSync()
		if err != nil {
			writeSyncError(writer, http.StatusInternalServerError, err.Error())
			return
		}
		s.appendLog(BenchmarkSyncLog{ID: newConversationID(), OccurredAt: time.Now().UTC().Format(time.RFC3339Nano), PeerDeviceID: peer.DeviceID, PeerDeviceName: peer.DeviceName, Direction: "send", Status: "completed", SentCount: len(records)})
		writeSyncJSON(writer, http.StatusOK, benchmarkSyncRecordsPayload{Version: 1, Records: records})
	case path == benchmarkSyncPathPrefix+"/records" && request.Method == http.MethodPost:
		peer, ok := s.authorizedPeer(request)
		if !ok {
			writeSyncError(writer, http.StatusUnauthorized, "연결된 PC의 인증 정보가 필요합니다")
			return
		}
		var payload benchmarkSyncRecordsPayload
		if err := decodeSyncJSON(request, &payload); err != nil {
			writeSyncError(writer, http.StatusBadRequest, err.Error())
			return
		}
		if payload.Version != 1 {
			writeSyncError(writer, http.StatusBadRequest, "지원하지 않는 동기화 형식입니다")
			return
		}
		outcome, err := s.importSyncedRecords(payload.Records)
		if err != nil {
			writeSyncError(writer, http.StatusBadRequest, err.Error())
			return
		}
		s.appendLog(BenchmarkSyncLog{ID: newConversationID(), OccurredAt: time.Now().UTC().Format(time.RFC3339Nano), PeerDeviceID: peer.DeviceID, PeerDeviceName: peer.DeviceName, Direction: "receive", Status: "completed", ReceivedCount: len(outcome.Imported), DuplicateCount: outcome.DuplicateCount, IgnoredCount: outcome.IgnoredCount, ConflictCount: outcome.ConflictCount})
		writeSyncJSON(writer, http.StatusOK, outcome)
	default:
		writeSyncError(writer, http.StatusNotFound, "동기화 경로를 찾을 수 없습니다")
	}
}

func (s *benchmarkSyncStore) handlePairRequest(writer http.ResponseWriter, request *http.Request) {
	var payload benchmarkSyncPairPayload
	if err := decodeSyncJSON(request, &payload); err != nil {
		writeSyncError(writer, http.StatusBadRequest, err.Error())
		return
	}
	payload.Code = normalizeBenchmarkSyncCode(payload.Code)
	payload.CallbackURL, _ = normalizeBenchmarkSyncAddress(payload.CallbackURL)
	payload.DeviceName, _ = normalizeBenchmarkSyncDeviceName(payload.DeviceName)
	if payload.Code == "" || !isSafeConversationID(payload.RequestID) || strings.TrimSpace(payload.DeviceID) == "" || payload.CallbackURL == "" || payload.DeviceName == "" || len(payload.RequesterToken) < 24 {
		writeSyncError(writer, http.StatusBadRequest, "연결 요청 정보가 올바르지 않습니다")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		writeSyncError(writer, http.StatusInternalServerError, err.Error())
		return
	}
	if expiredSyncTime(s.state.PairingExpiresAt) || s.state.PairingCode == "" || subtle.ConstantTimeCompare([]byte(payload.Code), []byte(s.state.PairingCode)) != 1 {
		writeSyncError(writer, http.StatusForbidden, "일회용 코드가 올바르지 않거나 만료되었습니다")
		return
	}
	requestToStore := BenchmarkSyncPairRequest{RequestID: payload.RequestID, DeviceID: strings.TrimSpace(payload.DeviceID), DeviceName: payload.DeviceName, Address: payload.CallbackURL, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Status: "pending"}
	if existing, ok := findPairRequest(s.state.Incoming, payload.RequestID); ok {
		response := benchmarkSyncPairStatusPayload{Status: existing.Status, Message: "연결 승인 대기 중"}
		if existing.Status == "accepted" {
			secrets := s.state.PairSecrets[existing.RequestID]
			response.DeviceID = s.state.DeviceID
			response.DeviceName = s.state.DeviceName
			response.ResponderToken = secrets.ResponderToken
		}
		writeSyncJSON(writer, http.StatusOK, response)
		return
	}
	s.state.Incoming = append(s.state.Incoming, requestToStore)
	if s.state.PairSecrets == nil {
		s.state.PairSecrets = make(map[string]benchmarkSyncPairSecrets)
	}
	s.state.PairSecrets[payload.RequestID] = benchmarkSyncPairSecrets{PairingCode: payload.Code, RequesterToken: payload.RequesterToken}
	if err := s.saveLocked(); err != nil {
		writeSyncError(writer, http.StatusInternalServerError, err.Error())
		return
	}
	writeSyncJSON(writer, http.StatusAccepted, benchmarkSyncPairStatusPayload{Status: "pending", Message: "상대 PC의 승인을 기다리고 있습니다"})
}

func (s *benchmarkSyncStore) handlePairStatus(writer http.ResponseWriter, request *http.Request, requestID string) {
	requestID, err := url.PathUnescape(requestID)
	if err != nil || !isSafeConversationID(requestID) {
		writeSyncError(writer, http.StatusBadRequest, "연결 요청 정보가 올바르지 않습니다")
		return
	}
	code := normalizeBenchmarkSyncCode(request.Header.Get("X-Agent-Chat-Pair-Code"))
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		writeSyncError(writer, http.StatusInternalServerError, err.Error())
		return
	}
	pairRequest, ok := findPairRequest(s.state.Incoming, requestID)
	secrets := s.state.PairSecrets[requestID]
	if !ok || secrets.PairingCode == "" || subtle.ConstantTimeCompare([]byte(code), []byte(secrets.PairingCode)) != 1 {
		writeSyncError(writer, http.StatusForbidden, "연결 승인 정보를 확인할 수 없습니다")
		return
	}
	response := benchmarkSyncPairStatusPayload{Status: pairRequest.Status}
	if pairRequest.Status == "accepted" {
		response.DeviceID = s.state.DeviceID
		response.DeviceName = s.state.DeviceName
		response.ResponderToken = secrets.ResponderToken
	}
	if pairRequest.Status == "rejected" {
		response.Message = "상대 PC에서 연결 요청을 거절했습니다"
	}
	writeSyncJSON(writer, http.StatusOK, response)
}

func (s *benchmarkSyncStore) authorizedPeer(request *http.Request) (BenchmarkSyncPeer, bool) {
	token := strings.TrimSpace(strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "))
	if token == "" {
		return BenchmarkSyncPeer{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ensureLoadedLocked() != nil {
		return BenchmarkSyncPeer{}, false
	}
	for _, peer := range s.state.Peers {
		inboundToken := s.state.PeerInboundTokens[peer.DeviceID]
		if inboundToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(inboundToken)) == 1 {
			return peer, true
		}
	}
	return BenchmarkSyncPeer{}, false
}

func (s *benchmarkSyncStore) recordsForSync() ([]ModelBenchmark, error) {
	records, err := s.benchmarks.completedRecords()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if err := s.ensureLoadedLocked(); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	deviceID, deviceName := s.state.DeviceID, s.state.DeviceName
	s.mu.Unlock()
	for index := range records {
		record := &records[index]
		if record.OriginDeviceID == "" {
			record.OriginDeviceID = deviceID
		}
		if record.OriginDeviceName == "" {
			record.OriginDeviceName = deviceName
		}
		if record.OriginBenchmarkID == "" {
			record.OriginBenchmarkID = record.ID
		}
	}
	return records, nil
}

func (s *benchmarkSyncStore) importSyncedRecords(records []ModelBenchmark) (benchmarkRecordImportOutcome, error) {
	s.mu.Lock()
	if err := s.ensureLoadedLocked(); err != nil {
		s.mu.Unlock()
		return benchmarkRecordImportOutcome{}, err
	}
	ignored := make(map[[sha256.Size]byte]struct{}, len(s.state.Ignored))
	for _, encoded := range s.state.Ignored {
		if raw, err := hex.DecodeString(encoded); err == nil && len(raw) == sha256.Size {
			var fingerprint [sha256.Size]byte
			copy(fingerprint[:], raw)
			ignored[fingerprint] = struct{}{}
		}
	}
	deviceID, deviceName := s.state.DeviceID, s.state.DeviceName
	s.mu.Unlock()
	for index := range records {
		record := &records[index]
		if record.OriginDeviceID == "" {
			record.OriginDeviceID = deviceID
		}
		if record.OriginDeviceName == "" {
			record.OriginDeviceName = deviceName
		}
		if record.OriginBenchmarkID == "" {
			record.OriginBenchmarkID = record.ID
		}
		record.Source = benchmarkSourceSync
		record.Imported = true
	}
	return s.benchmarks.importRecordsFromSource(records, benchmarkSourceSync, ignored)
}

func (s *benchmarkSyncStore) completeOutgoingPairing(requestID string, response benchmarkSyncPairStatusPayload) (BenchmarkSyncState, error) {
	if response.DeviceID == "" || response.DeviceName == "" || len(response.ResponderToken) < 24 {
		return BenchmarkSyncState{}, errors.New("상대 PC의 연결 승인 정보가 올바르지 않습니다")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoadedLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	index := pairRequestIndex(s.state.Outgoing, requestID)
	if index < 0 {
		return BenchmarkSyncState{}, errors.New("연결 요청을 찾을 수 없습니다")
	}
	request := &s.state.Outgoing[index]
	secrets := s.state.PairSecrets[requestID]
	if secrets.RequesterToken == "" {
		return BenchmarkSyncState{}, errors.New("연결 요청의 인증 정보가 없습니다")
	}
	request.Status = "accepted"
	s.state.Peers = upsertSyncPeer(s.state.Peers, BenchmarkSyncPeer{DeviceID: response.DeviceID, DeviceName: response.DeviceName, Address: request.Address, ConnectedAt: time.Now().UTC().Format(time.RFC3339Nano)})
	if s.state.PeerInboundTokens == nil {
		s.state.PeerInboundTokens = make(map[string]string)
	}
	s.state.PeerInboundTokens[response.DeviceID] = secrets.RequesterToken
	if s.state.PeerOutboundTokens == nil {
		s.state.PeerOutboundTokens = make(map[string]string)
	}
	s.state.PeerOutboundTokens[response.DeviceID] = response.ResponderToken
	if err := s.saveLocked(); err != nil {
		return BenchmarkSyncState{}, err
	}
	return s.publicStateLocked(), nil
}

func (s *benchmarkSyncStore) setOutgoingPairStatus(requestID, status, message string) {
	_ = message
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ensureLoadedLocked() != nil {
		return
	}
	index := pairRequestIndex(s.state.Outgoing, requestID)
	if index < 0 {
		return
	}
	s.state.Outgoing[index].Status = status
	_ = s.saveLocked()
}

func (s *benchmarkSyncStore) appendLog(log BenchmarkSyncLog) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ensureLoadedLocked() != nil {
		return
	}
	s.state.Logs = append([]BenchmarkSyncLog{log}, s.state.Logs...)
	if len(s.state.Logs) > benchmarkSyncMaxLogCount {
		s.state.Logs = s.state.Logs[:benchmarkSyncMaxLogCount]
	}
	_ = s.saveLocked()
}

func (s *benchmarkSyncStore) ensureLoadedLocked() error {
	if s.loaded {
		return nil
	}
	path, err := s.filePath()
	if err != nil {
		return err
	}
	contents, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		name, nameErr := os.Hostname()
		if nameErr != nil || strings.TrimSpace(name) == "" {
			name = "Agent Chat"
		}
		if name, nameErr = normalizeBenchmarkSyncDeviceName(name); nameErr != nil {
			name = "Agent Chat"
		}
		id, idErr := newBenchmarkSyncSecret(20)
		if idErr != nil {
			return idErr
		}
		s.state = benchmarkSyncPersistentState{DeviceID: strings.ToLower(id), DeviceName: name}
		s.loaded = true
		return s.saveLocked()
	}
	if err != nil {
		return fmt.Errorf("동기화 정보를 읽을 수 없습니다: %w", err)
	}
	if err := json.Unmarshal(contents, &s.state); err != nil {
		return errors.New("동기화 정보 형식이 올바르지 않습니다")
	}
	s.state.DeviceID = strings.TrimSpace(s.state.DeviceID)
	s.state.DeviceName, _ = normalizeBenchmarkSyncDeviceName(s.state.DeviceName)
	if s.state.DeviceID == "" || s.state.DeviceName == "" {
		return errors.New("동기화 장치 정보가 올바르지 않습니다")
	}
	s.loaded = true
	return nil
}

func (s *benchmarkSyncStore) publicStateLocked() BenchmarkSyncState {
	peers := append([]BenchmarkSyncPeer(nil), s.state.Peers...)
	for index := range peers {
		peers[index].Token = ""
	}
	incoming := publicPairRequests(s.state.Incoming)
	outgoing := publicPairRequests(s.state.Outgoing)
	logs := append([]BenchmarkSyncLog(nil), s.state.Logs...)
	state := BenchmarkSyncState{DeviceID: s.state.DeviceID, DeviceName: s.state.DeviceName, LocalAddresses: s.localAddressesLocked(), Peers: peers, IncomingRequests: incoming, OutgoingRequests: outgoing, Logs: logs}
	if !expiredSyncTime(s.state.PairingExpiresAt) {
		state.PairingCode = s.state.PairingCode
		state.PairingExpiresAt = s.state.PairingExpiresAt
	}
	return state
}

func (s *benchmarkSyncStore) filePath() (string, error) {
	root, err := applicationDataDirectory(s.root)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("동기화 저장 폴더를 만들 수 없습니다: %w", err)
	}
	return filepath.Join(root, benchmarkSyncFileName), nil
}

func (s *benchmarkSyncStore) saveLocked() error {
	path, err := s.filePath()
	if err != nil {
		return err
	}
	contents, err := json.Marshal(s.state)
	if err != nil {
		return fmt.Errorf("동기화 정보를 저장할 수 없습니다: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".benchmark-sync-*")
	if err != nil {
		return fmt.Errorf("동기화 정보 임시 파일을 만들 수 없습니다: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("동기화 정보 권한을 설정할 수 없습니다: %w", err)
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return fmt.Errorf("동기화 정보를 저장할 수 없습니다: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("동기화 정보를 저장할 수 없습니다: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("동기화 정보를 교체할 수 없습니다: %w", err)
	}
	return nil
}

func (s *benchmarkSyncStore) localAddressesLocked() []string {
	if s.listener == nil {
		return nil
	}
	port := s.listener.Addr().(*net.TCPAddr).Port
	addresses := make([]string, 0, 4)
	interfaces, err := net.Interfaces()
	if err == nil {
		for _, current := range interfaces {
			if current.Flags&net.FlagUp == 0 || current.Flags&net.FlagLoopback != 0 {
				continue
			}
			interfaceAddresses, _ := current.Addrs()
			for _, address := range interfaceAddresses {
				ip, _, err := net.ParseCIDR(address.String())
				if err != nil || ip.To4() == nil {
					continue
				}
				addresses = append(addresses, fmt.Sprintf("http://%s:%d", ip.String(), port))
			}
		}
	}
	sort.Strings(addresses)
	if len(addresses) == 0 {
		addresses = append(addresses, fmt.Sprintf("http://127.0.0.1:%d", port))
	}
	return addresses
}

func (s *benchmarkSyncStore) callbackURLLocked() string {
	addresses := s.localAddressesLocked()
	if len(addresses) == 0 {
		return ""
	}
	return addresses[0]
}

func (s *modelBenchmarkStore) completedRecords() ([]ModelBenchmark, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	directory, err := s.directory()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("벤치마크 목록을 읽을 수 없습니다: %w", err)
	}
	records := make([]ModelBenchmark, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || strings.ToLower(filepath.Ext(entry.Name())) != ".md" {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("벤치마크 기록을 읽을 수 없습니다: %w", err)
		}
		benchmark, err := parseModelBenchmark(contents)
		if err != nil {
			return nil, fmt.Errorf("벤치마크 기록 형식이 올바르지 않습니다: %w", err)
		}
		if benchmark.Status == "completed" {
			records = append(records, benchmark)
		}
	}
	return records, nil
}

func (s *benchmarkSyncStore) doJSON(method, endpoint, pairingCode string, body any, output any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(encoded))
	}
	request, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if strings.HasPrefix(pairingCode, "Bearer ") {
		request.Header.Set("Authorization", pairingCode)
	} else if pairingCode != "" {
		if len(pairingCode) >= 24 {
			request.Header.Set("Authorization", "Bearer "+pairingCode)
		} else {
			request.Header.Set("X-Agent-Chat-Pair-Code", pairingCode)
		}
	}
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure benchmarkSyncPairStatusPayload
		_ = json.NewDecoder(io.LimitReader(response.Body, 32<<10)).Decode(&failure)
		if failure.Message != "" {
			return errors.New(failure.Message)
		}
		return fmt.Errorf("상대 PC가 %d 응답을 반환했습니다", response.StatusCode)
	}
	if output == nil {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, benchmarkSyncMaxBodySize)).Decode(output); err != nil {
		return errors.New("상대 PC의 응답 형식이 올바르지 않습니다")
	}
	return nil
}

func decodeSyncJSON(request *http.Request, output any) error {
	if !strings.HasPrefix(request.Header.Get("Content-Type"), "application/json") {
		return errors.New("JSON 요청이 필요합니다")
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, benchmarkSyncMaxBodySize))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return errors.New("요청 정보 형식이 올바르지 않습니다")
	}
	return nil
}

func writeSyncJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeSyncError(writer http.ResponseWriter, status int, message string) {
	writeSyncJSON(writer, status, benchmarkSyncPairStatusPayload{Status: "error", Message: message})
}

func normalizeBenchmarkSyncAddress(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("상대 PC 주소를 입력해 주세요")
	}
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("http 또는 https 형식의 PC 주소를 입력해 주세요")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func normalizeBenchmarkSyncDeviceName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len([]rune(value)) > 80 || strings.ContainsAny(value, "\r\n") {
		return "", errors.New("PC 이름은 1~80자로 입력해 주세요")
	}
	return value, nil
}

func normalizeBenchmarkSyncCode(value string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))
}

func newBenchmarkSyncSecret(length int) (string, error) {
	const alphabet = "abcdefghijkmnopqrstuvwxyz23456789"
	buffer := make([]byte, length)
	if _, err := rand.Read(buffer); err != nil {
		return "", errors.New("안전한 연결 정보를 만들 수 없습니다")
	}
	for index := range buffer {
		buffer[index] = alphabet[int(buffer[index])%len(alphabet)]
	}
	return string(buffer), nil
}

func expiredSyncTime(value string) bool {
	if value == "" {
		return true
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return err != nil || !time.Now().Before(parsed)
}

func publicPairRequests(requests []BenchmarkSyncPairRequest) []BenchmarkSyncPairRequest {
	return append([]BenchmarkSyncPairRequest(nil), requests...)
}

func upsertPairRequest(requests []BenchmarkSyncPairRequest, request BenchmarkSyncPairRequest) []BenchmarkSyncPairRequest {
	if index := pairRequestIndex(requests, request.RequestID); index >= 0 {
		requests[index] = request
		return requests
	}
	return append(requests, request)
}

func findPairRequest(requests []BenchmarkSyncPairRequest, requestID string) (BenchmarkSyncPairRequest, bool) {
	index := pairRequestIndex(requests, requestID)
	if index < 0 {
		return BenchmarkSyncPairRequest{}, false
	}
	return requests[index], true
}
func pairRequestIndex(requests []BenchmarkSyncPairRequest, requestID string) int {
	for index, request := range requests {
		if request.RequestID == requestID {
			return index
		}
	}
	return -1
}
func syncPeerIndex(peers []BenchmarkSyncPeer, deviceID string) int {
	for index, peer := range peers {
		if peer.DeviceID == deviceID {
			return index
		}
	}
	return -1
}
func upsertSyncPeer(peers []BenchmarkSyncPeer, peer BenchmarkSyncPeer) []BenchmarkSyncPeer {
	if index := syncPeerIndex(peers, peer.DeviceID); index >= 0 {
		peers[index] = peer
		return peers
	}
	return append(peers, peer)
}
