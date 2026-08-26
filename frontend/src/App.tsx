import {FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState, WheelEvent} from 'react';
import {Events} from '@wailsio/runtime';
import {App as ChatService} from '../bindings/github.com/taengson/agent-chat-desktop';
import type {
    ChatEvent,
    ChatRequest,
    Conversation,
    ConversationMessage,
    ConversationSummary,
} from '../bindings/github.com/taengson/agent-chat-desktop/models';
import './App.css';

type Role = 'user' | 'assistant';
type MessageStatus = 'complete' | 'streaming' | 'cancelled' | 'failed';

interface UIMessage {
    id: string;
    role: Role;
    content: string;
    status: MessageStatus;
}

interface ModelOption {
    id: string;
    ownedBy?: string;
}

const defaultBaseURL = 'http://localhost:8000';

function makeID(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function appendAssistantDelta(content: string, delta: string): string {
    if (content !== '') {
        return content + delta;
    }

    return delta.replace(/^(?:[ \t]*\r?\n)+[ \t]*/, '');
}

function toUIMessage(message: ConversationMessage): UIMessage {
    return {
        id: message.id,
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.content,
        status: ['complete', 'streaming', 'cancelled', 'failed'].includes(message.status)
            ? message.status as MessageStatus
            : 'complete',
    };
}

function toStoredMessages(messages: UIMessage[]): ConversationMessage[] {
    return messages.map(({id, role, content, status}) => ({id, role, content, status}));
}

function summaryFromConversation(conversation: Conversation): ConversationSummary {
    return {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messages?.length || 0,
    };
}

function sortConversations(conversations: ConversationSummary[]): ConversationSummary[] {
    return [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function formatUpdatedAt(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return new Intl.DateTimeFormat('ko-KR', {month: 'short', day: 'numeric'}).format(date);
}

function App() {
    const [baseURL, setBaseURL] = useState(defaultBaseURL);
    const [apiKey, setAPIKey] = useState('');
    const [models, setModels] = useState<ModelOption[]>([]);
    const [selectedModel, setSelectedModel] = useState('');
    const [loadingModels, setLoadingModels] = useState(false);
    const [connectionMessage, setConnectionMessage] = useState('서버 연결 전');
    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
    const [loadingConversations, setLoadingConversations] = useState(true);
    const [messages, setMessages] = useState<UIMessage[]>([]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [canScrollUp, setCanScrollUp] = useState(false);
    const [showScrollToLatest, setShowScrollToLatest] = useState(false);

    const activeRequestRef = useRef<string | null>(null);
    const assistantMessageRef = useRef<string | null>(null);
    const activeConversationRef = useRef<Conversation | null>(null);
    const messagesRef = useRef<UIMessage[]>([]);
    const messageListRef = useRef<HTMLDivElement | null>(null);
    const shouldAutoScrollRef = useRef(true);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

    function replaceMessages(nextMessages: UIMessage[]) {
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
    }

    function activateConversation(conversation: Conversation) {
        activeConversationRef.current = conversation;
        setActiveConversation(conversation);
        replaceMessages((conversation.messages || []).map(toUIMessage));
        shouldAutoScrollRef.current = true;
        setCanScrollUp(false);
        setShowScrollToLatest(false);
    }

    function upsertConversationSummary(conversation: Conversation) {
        const summary = summaryFromConversation(conversation);
        setConversations((current) => sortConversations([
            summary,
            ...current.filter((item) => item.id !== summary.id),
        ]));
    }

    async function saveMessages(nextMessages: UIMessage[], source = activeConversationRef.current) {
        if (!source) {
            return;
        }
        const saved = await ChatService.SaveConversation({...source, messages: toStoredMessages(nextMessages)});
        activeConversationRef.current = saved;
        setActiveConversation(saved);
        upsertConversationSummary(saved);
    }

    function persistMessages(nextMessages: UIMessage[]) {
        const pendingSave = saveQueueRef.current.then(() => saveMessages(nextMessages));
        saveQueueRef.current = pendingSave.catch(() => undefined);
        void pendingSave.catch((reason) => setError(String(reason)));
    }

    function scheduleMessageSave(nextMessages: UIMessage[]) {
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
        }
        saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            persistMessages(nextMessages);
        }, 400);
    }

    async function createConversation() {
        if (busy) {
            return;
        }
        try {
            setError('');
            const conversation = await ChatService.CreateConversation();
            activateConversation(conversation);
            upsertConversationSummary(conversation);
        } catch (reason) {
            setError(String(reason));
        }
    }

    async function openConversation(id: string) {
        if (busy || id === activeConversationRef.current?.id) {
            return;
        }
        try {
            setError('');
            const conversation = await ChatService.OpenConversation(id);
            activateConversation(conversation);
        } catch (reason) {
            setError(String(reason));
        }
    }

    useEffect(() => {
        let cancelled = false;

        async function loadConversations() {
            try {
                const loaded = await ChatService.ListConversations();
                if (cancelled) {
                    return;
                }
                const nextConversations = sortConversations(loaded || []);
                setConversations(nextConversations);
                if (nextConversations.length === 0) {
                    await createConversation();
                } else {
                    const emptyConversation = nextConversations.find((conversation) => conversation.messageCount === 0);
                    if (emptyConversation) {
                        await openConversation(emptyConversation.id);
                    }
                }
            } catch (reason) {
                if (!cancelled) {
                    setError(String(reason));
                }
            } finally {
                if (!cancelled) {
                    setLoadingConversations(false);
                }
            }
        }

        void loadConversations();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const cancelListener = Events.On('chat:event', (event) => {
            const payload: ChatEvent = event.data;
            if (payload.requestID !== activeRequestRef.current) {
                return;
            }
            const assistantID = assistantMessageRef.current;
            if (!assistantID) {
                return;
            }

            const delta = payload.delta;
            if (payload.type === 'delta' && delta) {
                replaceMessages(messagesRef.current.map((message) =>
                    message.id === assistantID
                        ? {...message, content: appendAssistantDelta(message.content, delta)}
                        : message,
                ));
                scheduleMessageSave(messagesRef.current);
                return;
            }

            if (payload.type === 'completed') {
                finishRequest(assistantID, 'complete');
            } else if (payload.type === 'cancelled') {
                finishRequest(assistantID, 'cancelled');
            } else if (payload.type === 'failed') {
                setError(payload.error || '응답 생성 중 오류가 발생했습니다.');
                finishRequest(assistantID, 'failed');
            }
        });
        return cancelListener;
    }, []);

    useEffect(() => () => {
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
        }
    }, []);

    useEffect(() => {
        const element = messageListRef.current;
        if (element && shouldAutoScrollRef.current) {
            element.scrollTop = element.scrollHeight;
            setCanScrollUp(element.scrollTop > 1);
            setShowScrollToLatest(false);
        }
    }, [messages]);

    const canSend = useMemo(
        () => input.trim() !== '' && selectedModel !== '' && activeConversation !== null && !busy,
        [input, selectedModel, activeConversation, busy],
    );

    function finishRequest(assistantID: string, status: MessageStatus) {
        const nextMessages = messagesRef.current.map((message) =>
            message.id === assistantID ? {...message, status} : message,
        );
        replaceMessages(nextMessages);
        activeRequestRef.current = null;
        assistantMessageRef.current = null;
        setBusy(false);
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        persistMessages(nextMessages);
    }

    function updateScrollState(element: HTMLDivElement) {
        const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
        const isNearBottom = distanceFromBottom <= 48;
        shouldAutoScrollRef.current = isNearBottom;
        setCanScrollUp(element.scrollTop > 1);
        setShowScrollToLatest(!isNearBottom);
    }

    function handleMessageListScroll() {
        const element = messageListRef.current;
        if (element) {
            updateScrollState(element);
        }
    }

    function handleChatPanelWheel(event: WheelEvent<HTMLElement>) {
        const element = messageListRef.current;
        if (!element || event.deltaY === 0) {
            return;
        }

        const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
        const nextScrollTop = Math.min(maximumScrollTop, Math.max(0, element.scrollTop + event.deltaY));
        if (nextScrollTop === element.scrollTop) {
            return;
        }

        event.preventDefault();
        element.scrollTop = nextScrollTop;
        updateScrollState(element);
    }

    function scrollToPrevious() {
        const element = messageListRef.current;
        if (!element) {
            return;
        }

        shouldAutoScrollRef.current = false;
        element.scrollTop = Math.max(0, element.scrollTop - element.clientHeight * 0.8);
        updateScrollState(element);
    }

    function scrollToLatest() {
        const element = messageListRef.current;
        if (!element) {
            return;
        }

        shouldAutoScrollRef.current = true;
        element.scrollTop = element.scrollHeight;
        setShowScrollToLatest(false);
    }

    async function loadModels() {
        setLoadingModels(true);
        setError('');
        setConnectionMessage('연결 확인 중…');
        try {
            const result = await ChatService.ListModels({baseURL, apiKey});
            const nextModels = (result || []) as ModelOption[];
            setModels(nextModels);
            setSelectedModel((current) =>
                nextModels.some((model) => model.id === current) ? current : (nextModels[0]?.id || ''),
            );
            setConnectionMessage(nextModels.length > 0 ? `${nextModels.length}개 모델 연결됨` : '사용 가능한 모델 없음');
        } catch (reason) {
            setModels([]);
            setSelectedModel('');
            setConnectionMessage('연결 실패');
            setError(String(reason));
        } finally {
            setLoadingModels(false);
        }
    }

    async function sendMessage(event?: FormEvent) {
        event?.preventDefault();
        const text = input.trim();
        const conversation = activeConversationRef.current;
        if (!text || !selectedModel || busy || !conversation) {
            return;
        }

        const requestID = makeID();
        const userMessage: UIMessage = {id: makeID(), role: 'user', content: text, status: 'complete'};
        const assistantMessage: UIMessage = {id: makeID(), role: 'assistant', content: '', status: 'streaming'};
        const nextMessages = [...messagesRef.current, userMessage, assistantMessage];

        activeRequestRef.current = requestID;
        assistantMessageRef.current = assistantMessage.id;
        shouldAutoScrollRef.current = true;
        setShowScrollToLatest(false);
        replaceMessages(nextMessages);
        setInput('');
        setBusy(true);
        setError('');

        try {
            await saveMessages(nextMessages, conversation);
            const request: ChatRequest = {
                requestID,
                profile: {baseURL, apiKey},
                model: selectedModel,
                messages: nextMessages
                    .filter((message) => message.role === 'user' || message.content !== '')
                    .map(({role, content}) => ({role, content})),
            };
            await ChatService.StartChat(request);
        } catch (reason) {
            setError(String(reason));
            finishRequest(assistantMessage.id, 'failed');
        }
    }

    async function stopGeneration() {
        const requestID = activeRequestRef.current;
        if (requestID) {
            await ChatService.CancelChat(requestID);
        }
    }

    function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void sendMessage();
        }
    }

    return (
        <div className="app-shell">
            <aside className="sidebar">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true" />
                    <div>
                        <strong>Agent Chat</strong>
                        <span>Local AI desktop</span>
                    </div>
                </div>

                <section className="conversations" aria-label="대화">
                    <div className="section-heading">
                        <span>대화</span>
                        <button className="new-conversation-button" type="button" onClick={() => void createConversation()} disabled={busy}>
                            + 새 대화
                        </button>
                    </div>
                    <div className="conversation-list">
                        {loadingConversations && <p className="conversation-empty">대화 불러오는 중…</p>}
                        {!loadingConversations && conversations.map((conversation) => (
                            <button
                                className={`conversation-item ${conversation.id === activeConversation?.id ? 'active' : ''}`}
                                key={conversation.id}
                                type="button"
                                onClick={() => void openConversation(conversation.id)}
                                disabled={busy}
                            >
                                <span>{conversation.title}</span>
                                <small>{conversation.messageCount}개 메시지 · {formatUpdatedAt(conversation.updatedAt)}</small>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="settings">
                    <div className="section-heading">
                        <span>연결</span>
                        <span className={`connection-dot ${models.length ? 'online' : ''}`} />
                    </div>

                    <label>
                        서버 URL
                        <input
                            value={baseURL}
                            onChange={(event) => setBaseURL(event.target.value)}
                            placeholder="http://localhost:8000"
                            spellCheck={false}
                        />
                    </label>

                    <label>
                        API 키 <small>선택</small>
                        <input
                            value={apiKey}
                            onChange={(event) => setAPIKey(event.target.value)}
                            placeholder="필요한 경우 입력"
                            type="password"
                            autoComplete="off"
                        />
                    </label>

                    <button className="secondary-button" onClick={loadModels} disabled={loadingModels || busy}>
                        {loadingModels ? '확인 중…' : '모델 불러오기'}
                    </button>
                    <p className="connection-message">{connectionMessage}</p>

                    <label>
                        모델
                        <select
                            value={selectedModel}
                            onChange={(event) => setSelectedModel(event.target.value)}
                            disabled={!models.length || busy}
                        >
                            {!models.length && <option value="">모델을 불러와 주세요</option>}
                            {models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                        </select>
                    </label>
                </section>

                <p className="privacy-note">대화는 이 컴퓨터의 사용자 설정 폴더에 Markdown 파일로 저장됩니다. 연결 정보는 아직 저장되지 않습니다.</p>
            </aside>

            <main className="chat-panel" onWheel={handleChatPanelWheel}>
                <header className="chat-header">
                    <div>
                        <span className="eyebrow">CURRENT CONVERSATION</span>
                        <strong>{activeConversation?.title || '대화를 선택해 주세요'}</strong>
                    </div>
                    <span className="chat-model">{selectedModel || '모델 미선택'}</span>
                </header>

                <div className="message-list" ref={messageListRef} onScroll={handleMessageListScroll}>
                    {!activeConversation ? (
                        <div className="empty-state">
                            <div className="empty-symbol">AI</div>
                            <h1>대화를 선택하거나 새로 시작하세요</h1>
                            <p>왼쪽 목록에서 이전 대화를 열거나 새 대화를 만든 뒤 메시지를 입력하세요.</p>
                            <button className="empty-state-button" type="button" onClick={() => void createConversation()} disabled={busy}>
                                새 대화 시작
                            </button>
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-symbol">AI</div>
                            <h1>로컬 모델과 대화를 시작하세요</h1>
                            <p>왼쪽에서 서버를 연결하고 모델을 선택한 뒤 메시지를 입력하세요.</p>
                        </div>
                    ) : (
                        <div className="message-column">
                            {messages.map((message) => (
                                <article className={`message ${message.role}`} key={message.id}>
                                    <span className="message-role">{message.role === 'user' ? '나' : 'AI'}</span>
                                    <div className="message-content">
                                        {message.content || (message.status === 'streaming' ? <span className="typing">생각 중</span> : '')}
                                        {message.status === 'cancelled' && <span className="message-state">중단됨</span>}
                                        {message.status === 'failed' && <span className="message-state error-state">실패</span>}
                                    </div>
                                </article>
                            ))}
                        </div>
                    )}
                </div>

                {canScrollUp && (
                    <button className="scroll-previous-button" type="button" onClick={scrollToPrevious}>
                        이전 메시지 ↑
                    </button>
                )}
                {showScrollToLatest && (
                    <button className="scroll-latest-button" type="button" onClick={scrollToLatest}>
                        최신 메시지 ↓
                    </button>
                )}

                <div className="composer-area">
                    {error && <div className="error-banner" role="alert">{error}</div>}
                    <form className="composer" onSubmit={sendMessage}>
                        <textarea
                            value={input}
                            onChange={(event) => setInput(event.target.value)}
                            onKeyDown={handleComposerKeyDown}
                            placeholder={!activeConversation ? '대화를 선택하거나 새로 시작해 주세요' : selectedModel ? '메시지를 입력하세요' : '먼저 모델을 연결해 주세요'}
                            disabled={!activeConversation || !selectedModel || busy}
                            rows={1}
                        />
                        {busy ? (
                            <button className="stop-button" type="button" onClick={stopGeneration} aria-label="생성 중단">
                                <span />
                            </button>
                        ) : (
                            <button className="send-button" type="submit" disabled={!canSend} aria-label="전송">↑</button>
                        )}
                    </form>
                    <span className="composer-hint">Enter 전송 · Shift + Enter 줄바꿈</span>
                </div>
            </main>
        </div>
    );
}

export default App;
