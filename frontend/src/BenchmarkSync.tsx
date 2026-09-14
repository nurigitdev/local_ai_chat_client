import {FormEvent, useCallback, useEffect, useState} from 'react';
import {App as ChatService} from '../bindings/github.com/taengson/agent-chat-desktop';
import type {BenchmarkSyncLog, BenchmarkSyncPeer, BenchmarkSyncState} from '../bindings/github.com/taengson/agent-chat-desktop/models';

interface BenchmarkSyncProps {
    onBenchmarkHistoryChanged: () => void;
}

function formatTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('ko-KR', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date);
}

function formatExpiry(value?: string): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const seconds = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1_000));
    return seconds > 60 ? `${Math.ceil(seconds / 60)}분 후 만료` : `${seconds}초 후 만료`;
}

function syncLogSummary(log: BenchmarkSyncLog): string {
    const parts: string[] = [];
    if (log.sentCount) parts.push(`보냄 ${log.sentCount}`);
    if (log.receivedCount) parts.push(`받음 ${log.receivedCount}`);
    if (log.duplicateCount) parts.push(`중복 ${log.duplicateCount}`);
    if (log.ignoredCount) parts.push(`제외 ${log.ignoredCount}`);
    if (log.conflictCount) parts.push(`충돌 ${log.conflictCount}`);
    return parts.join(' · ') || '변경된 기록 없음';
}

function syncDirectionLabel(direction: string): string {
    if (direction === 'push') return '보내기';
    if (direction === 'pull') return '받기';
    if (direction === 'bidirectional') return '양방향';
    if (direction === 'send') return '전송';
    if (direction === 'receive') return '수신';
    return direction;
}

export default function BenchmarkSyncWorkspace({onBenchmarkHistoryChanged}: BenchmarkSyncProps) {
    const [state, setState] = useState<BenchmarkSyncState | null>(null);
    const [deviceName, setDeviceName] = useState('');
    const [address, setAddress] = useState('');
    const [code, setCode] = useState('');
    const [busyAction, setBusyAction] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const applyState = useCallback((next: BenchmarkSyncState) => {
        setState(next);
        setDeviceName(next.deviceName);
    }, []);

    const refresh = useCallback(async () => {
        try {
            const next = await ChatService.GetBenchmarkSyncState();
            applyState(next);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }, [applyState]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (!(state?.outgoingRequests || []).some((request) => request.status === 'pending')) return undefined;
        const timer = window.setInterval(() => {
            const pending = (state?.outgoingRequests || []).filter((request) => request.status === 'pending');
            pending.forEach((request) => {
                void ChatService.CheckBenchmarkSyncPairing(request.requestID).then((next) => {
                    applyState(next);
                }).catch(() => {
                    // A temporary network failure should not hide the pending request.
                });
            });
        }, 3_000);
        return () => window.clearInterval(timer);
    }, [applyState, state?.outgoingRequests]);

    async function runAction(action: string, operation: () => Promise<BenchmarkSyncState>, historyChanged = false) {
        if (busyAction) return;
        setBusyAction(action);
        setError('');
        setNotice('');
        try {
            const next = await operation();
            applyState(next);
            if (historyChanged) onBenchmarkHistoryChanged();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setBusyAction('');
        }
    }

    async function copyAddress(value: string) {
        try {
            await navigator.clipboard.writeText(value);
            setNotice('PC 주소를 복사했습니다.');
        } catch {
            setNotice('PC 주소를 선택해 복사해 주세요.');
        }
    }

    function submitPairing(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        void runAction('pair', async () => {
            const next = await ChatService.StartBenchmarkSyncPairing(address, code);
            setNotice('연결 요청을 보냈습니다. 상대 PC에서 승인해 주세요.');
            return next;
        });
    }

    function submitDeviceName(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        void runAction('device-name', () => ChatService.UpdateBenchmarkSyncDeviceName(deviceName));
    }

    const peers = state?.peers || [];
    const incomingRequests = state?.incomingRequests || [];
    const outgoingRequests = state?.outgoingRequests || [];
    const logs = state?.logs || [];

    return (
        <main className="benchmark-sync-workspace">
            <header className="benchmark-sync-header">
                <div>
                    <span className="eyebrow">BENCHMARK SYNC</span>
                    <h1>벤치마크 결과 동기화</h1>
                    <p>신뢰하는 같은 네트워크의 PC와 결과만 주고받습니다. API 키, 연결 설정, 대화 내용은 전송하지 않습니다.</p>
                </div>
                <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={Boolean(busyAction)}>새로 고침</button>
            </header>

            <p className="benchmark-sync-warning">공용 네트워크에서는 사용하지 마세요. 처음 연결할 때 양쪽 PC에서 일회용 코드와 연결 요청을 확인합니다.</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            {notice && <p className="form-notice">{notice}</p>}

            <section className="benchmark-sync-grid" aria-label="동기화 연결 설정">
                <section className="benchmark-sync-card">
                    <div className="benchmark-sync-card-heading">
                        <div>
                            <span className="eyebrow">THIS PC</span>
                            <h2>이 PC 정보</h2>
                        </div>
                    </div>
                    <form className="benchmark-sync-device-form" onSubmit={submitDeviceName}>
                        <label>
                            <span>PC 이름</span>
                            <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} disabled={Boolean(busyAction)}/>
                        </label>
                        <button className="secondary-button" type="submit" disabled={Boolean(busyAction) || deviceName === state?.deviceName}>저장</button>
                    </form>
                    <p className="benchmark-sync-device-id">장치 ID · {state?.deviceID || '불러오는 중…'}</p>
                    <div className="benchmark-sync-addresses">
                        <span>상대방에게 전달할 PC 주소</span>
                        {(state?.localAddresses || []).map((localAddress) => (
                            <button key={localAddress} className="benchmark-sync-address" type="button" onClick={() => void copyAddress(localAddress)} title="클릭하여 복사">
                                {localAddress}
                            </button>
                        ))}
                    </div>
                    <div className="benchmark-sync-code-row">
                        <div>
                            <span>일회용 연결 코드</span>
                            <strong>{state?.pairingCode || '—'}</strong>
                            {state?.pairingCode && <small>{formatExpiry(state.pairingExpiresAt)}</small>}
                        </div>
                        <button className="primary-button" type="button" onClick={() => void runAction('code', async () => {
                            const next = await ChatService.CreateBenchmarkSyncPairingCode();
                            setNotice('새 일회용 연결 코드를 만들었습니다.');
                            return next;
                        })} disabled={Boolean(busyAction)}>{state?.pairingCode ? '새 코드' : '코드 만들기'}</button>
                    </div>
                </section>

                <section className="benchmark-sync-card">
                    <div className="benchmark-sync-card-heading">
                        <div>
                            <span className="eyebrow">CONNECT</span>
                            <h2>상대 PC 연결</h2>
                        </div>
                    </div>
                    <form className="benchmark-sync-connect-form" onSubmit={submitPairing}>
                        <label>
                            <span>상대 PC 주소</span>
                            <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="예: 192.168.0.20:39391" disabled={Boolean(busyAction)}/>
                        </label>
                        <label>
                            <span>일회용 코드</span>
                            <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="예: ABCD-EFGH" disabled={Boolean(busyAction)}/>
                        </label>
                        <button className="primary-button" type="submit" disabled={Boolean(busyAction) || !address.trim() || !code.trim()}>연결 요청 보내기</button>
                    </form>
                    {outgoingRequests.length > 0 && <div className="benchmark-sync-request-list">
                        {outgoingRequests.slice(0, 3).map((request) => (
                            <p key={request.requestID} className={`benchmark-sync-request ${request.status}`}>
                                <strong>{request.deviceName || request.address}</strong>
                                <span>{request.status === 'pending' ? '승인 대기 중' : request.status === 'accepted' ? '연결됨' : request.status === 'rejected' ? '거절됨' : '확인 실패'}</span>
                            </p>
                        ))}
                    </div>}
                </section>
            </section>

            {incomingRequests.length > 0 && <section className="benchmark-sync-card benchmark-sync-incoming">
                <div className="benchmark-sync-card-heading">
                    <div><span className="eyebrow">PENDING</span><h2>받은 연결 요청</h2></div>
                    <small>연결할 PC가 맞는지 확인한 뒤 승인해 주세요.</small>
                </div>
                {incomingRequests.map((request) => (
                    <div className="benchmark-sync-incoming-item" key={request.requestID}>
                        <div><strong>{request.deviceName}</strong><span>{request.address} · {formatTime(request.createdAt)}</span></div>
                        {request.status === 'pending' ? <div className="benchmark-sync-actions">
                            <button className="secondary-button" type="button" disabled={Boolean(busyAction)} onClick={() => void runAction(`reject-${request.requestID}`, () => ChatService.RejectBenchmarkSyncPairing(request.requestID))}>거절</button>
                            <button className="primary-button" type="button" disabled={Boolean(busyAction)} onClick={() => void runAction(`approve-${request.requestID}`, async () => {
                                const next = await ChatService.ApproveBenchmarkSyncPairing(request.requestID);
                                setNotice(`${request.deviceName} PC를 연결했습니다.`);
                                return next;
                            })}>승인</button>
                        </div> : <small>{request.status === 'accepted' ? '승인됨' : '거절됨'}</small>}
                    </div>
                ))}
            </section>}

            <section className="benchmark-sync-card benchmark-sync-peers">
                <div className="benchmark-sync-card-heading">
                    <div><span className="eyebrow">TRUSTED PCS</span><h2>연결된 PC</h2></div>
                    <small>{peers.length}대</small>
                </div>
                {peers.length === 0 ? <p className="benchmark-sync-empty">아직 연결된 PC가 없습니다. 위에서 상대 PC의 주소와 일회용 코드를 입력해 주세요.</p> : peers.map((peer) => <PeerRow key={peer.deviceID} peer={peer} busy={Boolean(busyAction)} onSync={(direction) => void runAction(`sync-${peer.deviceID}`, () => ChatService.RunBenchmarkSync(peer.deviceID, direction), true)} onDelete={() => void runAction(`delete-${peer.deviceID}`, () => ChatService.DeleteBenchmarkSyncPeer(peer.deviceID))}/>) }
            </section>

            <section className="benchmark-sync-card benchmark-sync-logs">
                <div className="benchmark-sync-card-heading">
                    <div><span className="eyebrow">LOCAL ACTIVITY</span><h2>동기화 기록</h2></div>
                    <button className="text-button" type="button" disabled={Boolean(busyAction) || logs.length === 0} onClick={() => void runAction('clear-logs', () => ChatService.ClearBenchmarkSyncLogs())}>기록 지우기</button>
                </div>
                {logs.length === 0 ? <p className="benchmark-sync-empty">아직 동기화 기록이 없습니다. 최근 200개 활동만 이 PC에 보관됩니다.</p> : <div className="benchmark-sync-log-list">
                    {logs.map((log) => <div className={`benchmark-sync-log ${log.status}`} key={log.id}>
                        <div><strong>{syncDirectionLabel(log.direction)} · {log.peerDeviceName || '알 수 없는 PC'}</strong><span>{syncLogSummary(log)}</span>{log.message && <small>{log.message}</small>}</div>
                        <time>{formatTime(log.occurredAt)}</time>
                    </div>)}
                </div>}
            </section>
        </main>
    );
}

function PeerRow({peer, busy, onSync, onDelete}: {peer: BenchmarkSyncPeer; busy: boolean; onSync: (direction: string) => void; onDelete: () => void}) {
    return <article className="benchmark-sync-peer">
        <div><strong>{peer.deviceName}</strong><span>{peer.address}</span><small>{formatTime(peer.connectedAt)}에 연결</small></div>
        <div className="benchmark-sync-actions">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => onSync('pull')}>받기</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => onSync('push')}>보내기</button>
            <button className="primary-button" type="button" disabled={busy} onClick={() => onSync('bidirectional')}>양방향 동기화</button>
            <button className="text-button danger" type="button" disabled={busy} onClick={onDelete}>연결 해제</button>
        </div>
    </article>;
}
