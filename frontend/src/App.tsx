import {FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState, WheelEvent} from 'react';
import {Events} from '@wailsio/runtime';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {App as ChatService} from '../bindings/github.com/taengson/agent-chat-desktop';
import type {
    ChatEvent,
    ChatRequest,
    Conversation,
    ConversationMessage,
    ConversationSummary,
    ResponseMetrics,
    SavedConnectionProfile,
    TokenUsage,
} from '../bindings/github.com/taengson/agent-chat-desktop/models';
import ModelBenchmarkWorkspace, {type ModelBenchmarkSidebarState} from './ModelBenchmark';
import './App.css';

type Role = 'user' | 'assistant';
type MessageStatus = 'complete' | 'streaming' | 'cancelled' | 'failed';

interface UIMessage {
    id: string;
    role: Role;
    content: string;
    status: MessageStatus;
    usage?: TokenUsage;
    metrics?: ResponseMetrics;
}

interface ModelOption {
    id: string;
    ownedBy?: string;
}

interface ModelTokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

const defaultBaseURL = 'http://localhost:8000';
const emptyBenchmarkSidebar: ModelBenchmarkSidebarState = {
    model: '',
    profileName: '',
    status: 'idle',
    completedCaseCount: 0,
    caseCount: 0,
    recent: [],
    isHistoryLoading: false,
};

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
        usage: message.usage ?? undefined,
        metrics: message.metrics ?? undefined,
    };
}

function toStoredMessages(messages: UIMessage[]): ConversationMessage[] {
    return messages.map(({id, role, content, status, usage, metrics}) => ({id, role, content, status, usage, metrics}));
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

function sortSavedConnectionProfiles(profiles: SavedConnectionProfile[]): SavedConnectionProfile[] {
    return [...profiles].sort((left, right) => left.name.localeCompare(right.name, 'ko-KR'));
}

function formatUpdatedAt(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return new Intl.DateTimeFormat('ko-KR', {month: 'short', day: 'numeric'}).format(date);
}

function canSaveConnectionProfile(baseURL: string): boolean {
    try {
        const parsed = new URL(baseURL);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && parsed.host !== ''
            && parsed.username === ''
            && parsed.password === ''
            && parsed.search === ''
            && parsed.hash === '';
    } catch {
        return false;
    }
}

function formatTokenCount(value: number): string {
    if (value < 1_000) {
        return new Intl.NumberFormat('ko-KR').format(value);
    }
    const shortened = value / 1_000;
    return `${new Intl.NumberFormat('ko-KR', {
        maximumFractionDigits: shortened < 100 ? 1 : 0,
    }).format(shortened)}K`;
}

function formatDuration(milliseconds: number): string {
    const seconds = milliseconds / 1_000;
    return `${new Intl.NumberFormat('ko-KR', {
        minimumFractionDigits: seconds < 10 ? 1 : 0,
        maximumFractionDigits: seconds < 10 ? 1 : 0,
    }).format(seconds)}초`;
}

function formatGenerationSpeed(usage?: TokenUsage, metrics?: ResponseMetrics): string | null {
    if (!usage || !metrics || usage.completionTokens <= 0 || metrics.firstTokenDurationMs <= 0) {
        return null;
    }
    const generationDuration = metrics.totalDurationMs - metrics.firstTokenDurationMs;
    if (generationDuration <= 0) {
        return null;
    }
    const tokensPerSecond = usage.completionTokens / (generationDuration / 1_000);
    return `생성 속도 ${new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 1}).format(tokensPerSecond)} tok/s`;
}

type StructuredCodeLanguage = 'diff' | 'json';

interface StructuredCodeBlock {
    language: StructuredCodeLanguage;
    content: string;
}

function isUnifiedDiff(content: string): boolean {
    const lines = content.split(/\r?\n/);
    const hasOldFile = lines.some((line) => line.startsWith('--- '));
    const hasNewFile = lines.some((line) => line.startsWith('+++ '));
    const hasChange = lines.some((line) => line.startsWith('@@ ')
        || line.startsWith('+') && !line.startsWith('+++ ')
        || line.startsWith('-') && !line.startsWith('--- '));

    return hasOldFile && hasNewFile && hasChange;
}

function detectStructuredCodeBlock(content: string): StructuredCodeBlock | null {
    const trimmed = content.trim();
    if (trimmed === '') {
        return null;
    }
    if (isUnifiedDiff(trimmed)) {
        return {language: 'diff', content: trimmed};
    }

    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
            return {language: 'json', content: JSON.stringify(parsed, null, 2)};
        }
    } catch {
        // A normal Markdown message need not be valid JSON.
    }

    return null;
}

function diffLineClassName(line: string): string {
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('@@ ') || line.startsWith('diff --git ') || line.startsWith('index ')) {
        return 'diff-meta';
    }
    if (line.startsWith('+')) {
        return 'diff-addition';
    }
    if (line.startsWith('-')) {
        return 'diff-removal';
    }
    return '';
}

function StructuredCode({block}: {block: StructuredCodeBlock}) {
    if (block.language === 'diff') {
        return (
            <pre className="detected-code-block"><code className="language-diff">{block.content.split(/\r?\n/).map((line, index) => (
                    <span className={`diff-line ${diffLineClassName(line)}`} key={`${index}-${line}`}>
                        {line || '\u00a0'}
                    </span>
                ))}</code></pre>
        );
    }

    return <pre className="detected-code-block"><code className="language-json">{block.content}</code></pre>;
}

function AssistantMessageContent({content}: {content: string}) {
    const structuredCodeBlock = detectStructuredCodeBlock(content);
    if (structuredCodeBlock) {
        return <StructuredCode block={structuredCodeBlock}/>;
    }

    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}

function App() {
    const [workspace, setWorkspace] = useState<'chat' | 'benchmark'>('chat');
    const [benchmarkBusy, setBenchmarkBusy] = useState(false);
    const [benchmarkSidebar, setBenchmarkSidebar] = useState<ModelBenchmarkSidebarState>(emptyBenchmarkSidebar);
    const [benchmarkOpenRequestID, setBenchmarkOpenRequestID] = useState<string | null>(null);
    const [baseURL, setBaseURL] = useState(defaultBaseURL);
    const [apiKey, setAPIKey] = useState('');
    const [models, setModels] = useState<ModelOption[]>([]);
    const [selectedModel, setSelectedModel] = useState('');
    const [modelTokenUsage, setModelTokenUsage] = useState<Record<string, ModelTokenUsage>>({});
    const [loadingModels, setLoadingModels] = useState(false);
    const [connectionMessage, setConnectionMessage] = useState('서버 연결 전');
    const [connectionProfileReady, setConnectionProfileReady] = useState(false);
    const [savedConnectionProfiles, setSavedConnectionProfiles] = useState<SavedConnectionProfile[]>([]);
    const [selectedSavedConnectionProfileID, setSelectedSavedConnectionProfileID] = useState('');
    const [connectionProfileName, setConnectionProfileName] = useState('');
    const [savingConnectionProfile, setSavingConnectionProfile] = useState(false);
    const [connectionProfileToDelete, setConnectionProfileToDelete] = useState<SavedConnectionProfile | null>(null);
    const [deletingConnectionProfile, setDeletingConnectionProfile] = useState(false);
    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [conversationSearch, setConversationSearch] = useState('');
    const [conversationsExpanded, setConversationsExpanded] = useState(true);
    const [connectionsExpanded, setConnectionsExpanded] = useState(true);
    const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
    const [loadingConversations, setLoadingConversations] = useState(true);
    const [conversationToDelete, setConversationToDelete] = useState<Conversation | null>(null);
    const [deletingConversation, setDeletingConversation] = useState(false);
    const [renamingConversation, setRenamingConversation] = useState(false);
    const [conversationTitleDraft, setConversationTitleDraft] = useState('');
    const [messages, setMessages] = useState<UIMessage[]>([]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [copiedMessageID, setCopiedMessageID] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [canScrollUp, setCanScrollUp] = useState(false);
    const [showScrollToLatest, setShowScrollToLatest] = useState(false);

    const activeRequestRef = useRef<string | null>(null);
    const assistantMessageRef = useRef<string | null>(null);
    const activeRequestModelRef = useRef<string | null>(null);
    const usageRecordedForRequestRef = useRef<string | null>(null);
    const activeConversationRef = useRef<Conversation | null>(null);
    const messagesRef = useRef<UIMessage[]>([]);
    const messageListRef = useRef<HTMLDivElement | null>(null);
    const shouldAutoScrollRef = useRef(true);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
    const connectionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const skipInitialConnectionSaveRef = useRef(true);
    const cancelRequestedRef = useRef(false);
    const stopFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const copiedMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleBenchmarkBusyChange = useCallback((nextBusy: boolean) => {
        setBenchmarkBusy(nextBusy);
    }, []);

    const handleBenchmarkSidebarChange = useCallback((nextState: ModelBenchmarkSidebarState) => {
        setBenchmarkSidebar(nextState);
    }, []);

    const handleBenchmarkOpenRequestHandled = useCallback(() => {
        setBenchmarkOpenRequestID(null);
    }, []);

    function replaceMessages(nextMessages: UIMessage[]) {
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
    }

    function activateConversation(conversation: Conversation) {
        activeConversationRef.current = conversation;
        setActiveConversation(conversation);
        setRenamingConversation(false);
        setConversationTitleDraft('');
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

    function requestConversationDelete() {
        const conversation = activeConversationRef.current;
        if (!conversation || busy) {
            return;
        }
        setConversationToDelete(conversation);
    }

    async function confirmConversationDelete() {
        const conversation = conversationToDelete;
        if (!conversation || busy || deletingConversation) {
            return;
        }

        try {
            setDeletingConversation(true);
            setError('');
            await ChatService.DeleteConversation(conversation.id);
            setConversations((current) => current.filter((item) => item.id !== conversation.id));
            if (activeConversationRef.current?.id === conversation.id) {
                activeConversationRef.current = null;
                setActiveConversation(null);
                replaceMessages([]);
            }
            setInput('');
            shouldAutoScrollRef.current = true;
            setCanScrollUp(false);
            setShowScrollToLatest(false);
            setConversationToDelete(null);
        } catch (reason) {
            setError(String(reason));
        } finally {
            setDeletingConversation(false);
        }
    }

    function beginConversationRename() {
        const conversation = activeConversationRef.current;
        if (!conversation || busy) {
            return;
        }
        setConversationTitleDraft(conversation.title);
        setRenamingConversation(true);
    }

    async function saveConversationTitle() {
        const conversation = activeConversationRef.current;
        const title = conversationTitleDraft.trim();
        if (!conversation || busy || !title) {
            if (!title) {
                setError('대화 이름을 입력해 주세요.');
            }
            return;
        }

        try {
            setError('');
            const saved = await ChatService.SaveConversation({
                ...conversation,
                title,
                messages: toStoredMessages(messagesRef.current),
            });
            activeConversationRef.current = saved;
            setActiveConversation(saved);
            upsertConversationSummary(saved);
            setRenamingConversation(false);
        } catch (reason) {
            setError(String(reason));
        }
    }

    function updateBaseURL(value: string) {
        setBaseURL(value);
        setModels([]);
        setSelectedModel('');
        setModelTokenUsage({});
        setConnectionMessage('서버 주소가 변경되었습니다. 모델을 다시 불러와 주세요');
    }

    function selectSavedConnectionProfile(id: string) {
        const profile = savedConnectionProfiles.find((item) => item.id === id);
        setSelectedSavedConnectionProfileID(id);
        if (!profile) {
            setConnectionProfileName('');
            return;
        }

        setConnectionProfileName(profile.name);
        updateBaseURL(profile.baseURL);
        setAPIKey('');
        setConnectionMessage('프로필을 선택했습니다. API 키를 입력한 뒤 모델을 불러와 주세요');
    }

    async function saveNamedConnectionProfile() {
        if (busy || savingConnectionProfile) {
            return;
        }
        if (!canSaveConnectionProfile(baseURL)) {
            setError('저장할 수 있는 서버 URL을 입력해 주세요.');
            return;
        }

        try {
            setSavingConnectionProfile(true);
            setError('');
            const saved = await ChatService.SaveNamedConnectionProfile({
                id: selectedSavedConnectionProfileID,
                name: connectionProfileName,
                baseURL,
            });
            setSavedConnectionProfiles((current) => sortSavedConnectionProfiles([
                ...current.filter((item) => item.id !== saved.id),
                saved,
            ]));
            setSelectedSavedConnectionProfileID(saved.id);
            setConnectionProfileName(saved.name);
            setConnectionMessage('연결 프로필을 저장했습니다');
        } catch (reason) {
            setError(String(reason));
        } finally {
            setSavingConnectionProfile(false);
        }
    }

    function requestSavedConnectionProfileDelete() {
        const profile = savedConnectionProfiles.find((item) => item.id === selectedSavedConnectionProfileID);
        if (!profile || busy || savingConnectionProfile) {
            return;
        }
        setConnectionProfileToDelete(profile);
    }

    async function confirmSavedConnectionProfileDelete() {
        const profile = connectionProfileToDelete;
        if (!profile || deletingConnectionProfile) {
            return;
        }
        try {
            setDeletingConnectionProfile(true);
            setError('');
            await ChatService.DeleteSavedConnectionProfile(profile.id);
            setSavedConnectionProfiles((current) => current.filter((item) => item.id !== profile.id));
            if (selectedSavedConnectionProfileID === profile.id) {
                setSelectedSavedConnectionProfileID('');
                setConnectionProfileName('');
            }
            setConnectionMessage('연결 프로필을 삭제했습니다');
            setConnectionProfileToDelete(null);
        } catch (reason) {
            setError(String(reason));
        } finally {
            setDeletingConnectionProfile(false);
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
        let cancelled = false;

        async function loadConnectionProfiles() {
            try {
                const [profile, profiles] = await Promise.all([
                    ChatService.LoadConnectionProfile(),
                    ChatService.ListSavedConnectionProfiles(),
                ]);
                if (cancelled) {
                    return;
                }
                setSavedConnectionProfiles(sortSavedConnectionProfiles(profiles || []));
                if (profile.baseURL) {
                    setBaseURL(profile.baseURL);
                    setConnectionMessage('저장된 서버 주소를 불러왔습니다. 모델을 불러와 선택해 주세요');
                }
            } catch (reason) {
                if (!cancelled) {
                    setError(String(reason));
                }
            } finally {
                if (!cancelled) {
                    setConnectionProfileReady(true);
                }
            }
        }

        void loadConnectionProfiles();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!connectionProfileReady) {
            return;
        }
        if (skipInitialConnectionSaveRef.current) {
            skipInitialConnectionSaveRef.current = false;
            return;
        }
        if (!canSaveConnectionProfile(baseURL)) {
            return;
        }
        if (connectionSaveTimerRef.current) {
            clearTimeout(connectionSaveTimerRef.current);
        }
        const profile: SavedConnectionProfile = {id: '', name: '', baseURL};
        connectionSaveTimerRef.current = setTimeout(() => {
            connectionSaveTimerRef.current = null;
            void ChatService.SaveConnectionProfile(profile).catch((reason) => setError(String(reason)));
        }, 400);
    }, [baseURL, connectionProfileReady]);

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
                if (cancelRequestedRef.current) {
                    return;
                }
                replaceMessages(messagesRef.current.map((message) =>
                    message.id === assistantID
                        ? {...message, content: appendAssistantDelta(message.content, delta)}
                        : message,
                ));
                scheduleMessageSave(messagesRef.current);
                return;
            }

            const usage = payload.usage;
            if (payload.type === 'usage' && usage) {
                replaceMessages(messagesRef.current.map((message) =>
                    message.id === assistantID ? {...message, usage} : message,
                ));
                if (usageRecordedForRequestRef.current !== payload.requestID) {
                    const model = activeRequestModelRef.current;
                    if (model) {
                        setModelTokenUsage((current) => {
                            const previous = current[model] || {promptTokens: 0, completionTokens: 0, totalTokens: 0};
                            return {
                                ...current,
                                [model]: {
                                    promptTokens: previous.promptTokens + usage.promptTokens,
                                    completionTokens: previous.completionTokens + usage.completionTokens,
                                    totalTokens: previous.totalTokens + usage.totalTokens,
                                },
                            };
                        });
                    }
                    usageRecordedForRequestRef.current = payload.requestID;
                }
                return;
            }

            if (payload.type === 'completed') {
                finishRequest(assistantID, 'complete', payload.metrics);
            } else if (payload.type === 'cancelled') {
                finishRequest(assistantID, 'cancelled', payload.metrics);
            } else if (payload.type === 'failed') {
                setError(payload.error || '응답 생성 중 오류가 발생했습니다.');
                finishRequest(assistantID, 'failed', payload.metrics);
            }
        });
        return cancelListener;
    }, []);

    useEffect(() => () => {
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
        }
        if (connectionSaveTimerRef.current) {
            clearTimeout(connectionSaveTimerRef.current);
        }
        if (stopFallbackTimerRef.current) {
            clearTimeout(stopFallbackTimerRef.current);
        }
        if (copiedMessageTimerRef.current) {
            clearTimeout(copiedMessageTimerRef.current);
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

    const visibleConversations = useMemo(() => {
        const query = conversationSearch.trim().toLocaleLowerCase('ko-KR');
        if (!query) {
            return conversations;
        }
        return conversations.filter((conversation) => conversation.title.toLocaleLowerCase('ko-KR').includes(query));
    }, [conversationSearch, conversations]);

    const canSend = useMemo(
        () => input.trim() !== '' && selectedModel !== '' && activeConversation !== null && !busy,
        [input, selectedModel, activeConversation, busy],
    );

    function finishRequest(assistantID: string, status: MessageStatus, metrics?: ResponseMetrics | null) {
        if (assistantMessageRef.current !== assistantID) {
            return;
        }
        const nextMessages = messagesRef.current.map((message) =>
            message.id === assistantID ? {...message, status, metrics: metrics ?? message.metrics} : message,
        );
        replaceMessages(nextMessages);
        activeRequestRef.current = null;
        assistantMessageRef.current = null;
        activeRequestModelRef.current = null;
        usageRecordedForRequestRef.current = null;
        cancelRequestedRef.current = false;
        setCancelling(false);
        if (stopFallbackTimerRef.current) {
            clearTimeout(stopFallbackTimerRef.current);
            stopFallbackTimerRef.current = null;
        }
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
            setModelTokenUsage({});
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

    async function beginAssistantResponse(
        conversation: Conversation,
        assistantMessage: UIMessage,
        nextMessages: UIMessage[],
        requestMessages: UIMessage[],
    ) {
        const requestID = makeID();
        activeRequestRef.current = requestID;
        assistantMessageRef.current = assistantMessage.id;
        activeRequestModelRef.current = selectedModel;
        usageRecordedForRequestRef.current = null;
        cancelRequestedRef.current = false;
        setCancelling(false);
        shouldAutoScrollRef.current = true;
        setShowScrollToLatest(false);
        replaceMessages(nextMessages);
        setBusy(true);
        setError('');

        try {
            await saveMessages(nextMessages, conversation);
            const request: ChatRequest = {
                requestID,
                profile: {baseURL, apiKey},
                model: selectedModel,
                messages: requestMessages
                    .filter((message) => message.role === 'user' || message.content !== '')
                    .map(({role, content}) => ({role, content})),
            };
            await ChatService.StartChat(request);
        } catch (reason) {
            setError(String(reason));
            finishRequest(assistantMessage.id, 'failed');
        }
    }

    async function sendMessage(event?: FormEvent) {
        event?.preventDefault();
        const text = input.trim();
        const conversation = activeConversationRef.current;
        if (!text || !selectedModel || busy || !conversation) {
            return;
        }

        const userMessage: UIMessage = {id: makeID(), role: 'user', content: text, status: 'complete'};
        const assistantMessage: UIMessage = {id: makeID(), role: 'assistant', content: '', status: 'streaming'};
        const nextMessages = [...messagesRef.current, userMessage, assistantMessage];
        setInput('');
        await beginAssistantResponse(conversation, assistantMessage, nextMessages, nextMessages);
    }

    async function regenerateResponse(messageID: string) {
        const conversation = activeConversationRef.current;
        const messageIndex = messagesRef.current.findIndex((message) => message.id === messageID);
        if (!conversation || !selectedModel || busy || messageIndex < 1 || messageIndex !== messagesRef.current.length - 1) {
            return;
        }

        const previousMessages = messagesRef.current.slice(0, messageIndex);
        const previousMessage = previousMessages[previousMessages.length - 1];
        if (!previousMessage || previousMessage.role !== 'user') {
            return;
        }

        const assistantMessage: UIMessage = {id: messageID, role: 'assistant', content: '', status: 'streaming'};
        await beginAssistantResponse(conversation, assistantMessage, [...previousMessages, assistantMessage], previousMessages);
    }

    async function copyMessage(message: UIMessage) {
        if (!message.content) {
            return;
        }
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(message.content);
            } else {
                const temporary = document.createElement('textarea');
                temporary.value = message.content;
                temporary.style.position = 'fixed';
                temporary.style.opacity = '0';
                document.body.append(temporary);
                temporary.select();
                const copied = document.execCommand('copy');
                temporary.remove();
                if (!copied) {
                    throw new Error('클립보드에 복사할 수 없습니다.');
                }
            }
            setCopiedMessageID(message.id);
            if (copiedMessageTimerRef.current) {
                clearTimeout(copiedMessageTimerRef.current);
            }
            copiedMessageTimerRef.current = setTimeout(() => {
                copiedMessageTimerRef.current = null;
                setCopiedMessageID(null);
            }, 1_800);
        } catch (reason) {
            setError(String(reason));
        }
    }

    async function stopGeneration() {
        const requestID = activeRequestRef.current;
        const assistantID = assistantMessageRef.current;
        if (!requestID || !assistantID || cancelling) {
            return;
        }

        try {
            cancelRequestedRef.current = true;
            setCancelling(true);
            await ChatService.CancelChat(requestID);
            if (activeRequestRef.current !== requestID || assistantMessageRef.current !== assistantID) {
                return;
            }
            if (stopFallbackTimerRef.current) {
                clearTimeout(stopFallbackTimerRef.current);
            }
            stopFallbackTimerRef.current = setTimeout(() => {
                if (activeRequestRef.current === requestID && assistantMessageRef.current === assistantID) {
                    finishRequest(assistantID, 'cancelled');
                }
            }, 2_000);
        } catch (reason) {
            cancelRequestedRef.current = false;
            setCancelling(false);
            setError(String(reason));
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

                <nav className="workspace-switch" aria-label="작업 공간">
                    <button
                        className={workspace === 'chat' ? 'active' : ''}
                        type="button"
                        onClick={() => setWorkspace('chat')}
                        disabled={busy || benchmarkBusy}
                    >
                        채팅
                    </button>
                    <button
                        className={workspace === 'benchmark' ? 'active' : ''}
                        type="button"
                        onClick={() => setWorkspace('benchmark')}
                        disabled={busy || benchmarkBusy}
                    >
                        모델 실험실
                    </button>
                </nav>

                {workspace === 'chat' ? (
                    <>
                <section className={`conversations ${conversationsExpanded ? '' : 'collapsed'}`} aria-label="대화">
                    <div className="section-heading">
                        <button
                            className="section-toggle"
                            type="button"
                            onClick={() => setConversationsExpanded((current) => !current)}
                            aria-expanded={conversationsExpanded}
                            aria-controls="conversation-content"
                        >
                            <span>대화</span>
                            <span className="section-toggle-indicator" aria-hidden="true">⌄</span>
                        </button>
                        <button className="new-conversation-button" type="button" onClick={() => void createConversation()} disabled={busy}>
                            + 새 대화
                        </button>
                    </div>
                    {conversationsExpanded && (
                        <div className="collapsible-content" id="conversation-content">
                            <input
                                className="conversation-search"
                                value={conversationSearch}
                                onChange={(event) => setConversationSearch(event.target.value)}
                                placeholder="대화 검색"
                                type="search"
                            />
                            <div className="conversation-list">
                                {loadingConversations && <p className="conversation-empty">대화 불러오는 중…</p>}
                                {!loadingConversations && visibleConversations.map((conversation) => (
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
                                {!loadingConversations && conversations.length > 0 && visibleConversations.length === 0 && (
                                    <p className="conversation-empty">검색 결과가 없습니다.</p>
                                )}
                            </div>
                        </div>
                    )}
                </section>

                <section className={`settings ${connectionsExpanded ? '' : 'collapsed'}`} aria-label="연결">
                    <div className="section-heading">
                        <button
                            className="section-toggle"
                            type="button"
                            onClick={() => setConnectionsExpanded((current) => !current)}
                            aria-expanded={connectionsExpanded}
                            aria-controls="connection-content"
                        >
                            <span>연결</span>
                            <span className="section-toggle-indicator" aria-hidden="true">⌄</span>
                        </button>
                        <span className={`connection-dot ${models.length ? 'online' : ''}`} />
                    </div>
                    {connectionsExpanded && (
                        <div className="collapsible-content" id="connection-content">

                            <label>
                                저장된 프로필 <small>API 키 제외</small>
                                <select
                                    value={selectedSavedConnectionProfileID}
                                    onChange={(event) => selectSavedConnectionProfile(event.target.value)}
                                    disabled={busy || savingConnectionProfile}
                                >
                                    <option value="">새 연결 프로필</option>
                                    {savedConnectionProfiles.map((profile) => (
                                        <option key={profile.id} value={profile.id}>{profile.name}</option>
                                    ))}
                                </select>
                            </label>

                            <label>
                                프로필 이름
                                <input
                                    value={connectionProfileName}
                                    onChange={(event) => setConnectionProfileName(event.target.value)}
                                    placeholder="예: 로컬 vLLM"
                                    disabled={busy || savingConnectionProfile}
                                />
                            </label>

                            <label>
                                서버 URL
                                <input
                                    value={baseURL}
                                    onChange={(event) => updateBaseURL(event.target.value)}
                                    placeholder="http://localhost:8000"
                                    spellCheck={false}
                                />
                            </label>

                            <button
                                className={`profile-save-button ${selectedSavedConnectionProfileID ? 'update' : 'create'}`}
                                type="button"
                                onClick={() => void saveNamedConnectionProfile()}
                                disabled={busy || savingConnectionProfile || !connectionProfileName.trim()}
                            >
                                {savingConnectionProfile ? '저장 중…' : selectedSavedConnectionProfileID ? '프로필 업데이트' : '프로필 저장'}
                            </button>
                            {selectedSavedConnectionProfileID && (
                                <button
                                    className="profile-delete-button"
                                    type="button"
                                    onClick={requestSavedConnectionProfileDelete}
                                    disabled={busy || savingConnectionProfile}
                                >
                                    프로필 삭제
                                </button>
                            )}

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
                                <span className="model-select-heading">
                                    <span>모델</span>
                                    {selectedModel && (
                                        <span className="model-token-usage">
                                            누적 {formatTokenCount(modelTokenUsage[selectedModel]?.totalTokens || 0)} 토큰
                                        </span>
                                    )}
                                </span>
                                <select
                                    value={selectedModel}
                                    onChange={(event) => setSelectedModel(event.target.value)}
                                    disabled={!models.length || busy}
                                >
                                    {!models.length && <option value="">모델을 불러와 주세요</option>}
                                    {models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                                </select>
                            </label>

                            <p className="privacy-note">프로필에는 이름과 서버 URL만 저장됩니다. 모델과 API 키는 저장하지 않으며 앱을 다시 열면 모델을 불러오고 API 키를 다시 입력해야 합니다.</p>
                        </div>
                    )}
                </section>
                    </>
                ) : (
                    <section className="benchmark-sidebar">
                        <div className="section-heading"><span>모델 실험실</span></div>
                        {benchmarkSidebar.model ? (
                            <section className="benchmark-sidebar-current">
                                <span className={benchmarkSidebar.status}>실행 중</span>
                                <strong>{benchmarkSidebar.model}</strong>
                                <small>{benchmarkSidebar.profileName} · {benchmarkSidebar.completedCaseCount}/{benchmarkSidebar.caseCount}개 완료</small>
                            </section>
                        ) : (
                            <p>저장된 프로필에서 모델 하나를 선택해 편집 가능한 4개 테스트를 순차 실행합니다.</p>
                        )}
                        <section className="benchmark-sidebar-history" aria-label="최근 벤치마크">
                            <span>최근 벤치마크</span>
                            <div className="benchmark-sidebar-history-list">
                                {benchmarkSidebar.isHistoryLoading && <small>기록을 불러오는 중…</small>}
                                {!benchmarkSidebar.isHistoryLoading && benchmarkSidebar.recent.length === 0 && <small>아직 저장된 벤치마크가 없습니다.</small>}
                                {benchmarkSidebar.recent.map((item) => (
                                    <button
                                        className="benchmark-sidebar-history-item"
                                        key={item.id}
                                        type="button"
                                        disabled={benchmarkBusy}
                                        onClick={() => setBenchmarkOpenRequestID(item.id)}
                                    >
                                        <strong>{item.model}</strong>
                                        <span>{item.suiteName}</span>
                                        <small>{item.completedCaseCount}/{item.caseCount}개 완료 · {formatUpdatedAt(item.updatedAt)}</small>
                                    </button>
                                ))}
                            </div>
                        </section>
                        <small>저장된 프로필 {savedConnectionProfiles.length}개</small>
                    </section>
                )}
            </aside>

            {workspace === 'benchmark' ? (
                <main className="benchmark-panel">
                    <ModelBenchmarkWorkspace
                        profiles={savedConnectionProfiles}
                        onBusyChange={handleBenchmarkBusyChange}
                        onSidebarChange={handleBenchmarkSidebarChange}
                        openBenchmarkID={benchmarkOpenRequestID}
                        onOpenBenchmarkHandled={handleBenchmarkOpenRequestHandled}
                    />
                </main>
            ) : (
            <main className="chat-panel" onWheel={handleChatPanelWheel}>
                <header className="chat-header">
                    <div>
                        <span className="eyebrow">CURRENT CONVERSATION</span>
                        {renamingConversation ? (
                            <form className="conversation-title-form" onSubmit={(event) => {
                                event.preventDefault();
                                void saveConversationTitle();
                            }}>
                                <input
                                    value={conversationTitleDraft}
                                    onChange={(event) => setConversationTitleDraft(event.target.value)}
                                    aria-label="대화 이름"
                                    autoFocus
                                />
                                <button className="text-button" type="submit">저장</button>
                                <button className="text-button" type="button" onClick={() => setRenamingConversation(false)}>취소</button>
                            </form>
                        ) : (
                            <strong>{activeConversation?.title || '대화를 선택해 주세요'}</strong>
                        )}
                    </div>
                    <div className="chat-header-actions">
                        {activeConversation && !busy && !renamingConversation && (
                            <button className="text-button" type="button" onClick={beginConversationRename}>
                                이름 변경
                            </button>
                        )}
                        {activeConversation && !busy && (
                            <button className="delete-conversation-button" type="button" onClick={requestConversationDelete}>
                                대화 삭제
                            </button>
                        )}
                    </div>
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
                            {messages.map((message, index) => (
                                <article className={`message ${message.role}`} key={message.id}>
                                    <span className="message-role">{message.role === 'user' ? '나' : 'AI'}</span>
                                    <div className={`message-content${message.role === 'assistant' ? ' markdown-content' : ''}`}>
                                        {message.content ? (
                                            message.role === 'assistant' ? (
                                                <AssistantMessageContent content={message.content}/>
                                            ) : message.content
                                        ) : (message.status === 'streaming' ? <span className="typing">생각 중</span> : '')}
                                        {message.status === 'cancelled' && <span className="message-state">중단됨</span>}
                                        {message.status === 'failed' && <span className="message-state error-state">실패</span>}
                                        {message.role === 'assistant' && message.metrics && (
                                            <div className="message-metrics">
                                                <span>응답 {formatDuration(message.metrics.totalDurationMs)}</span>
                                                {message.metrics.firstTokenDurationMs > 0 && (
                                                    <span>첫 토큰 {formatDuration(message.metrics.firstTokenDurationMs)}</span>
                                                )}
                                                {formatGenerationSpeed(message.usage, message.metrics) && (
                                                    <span>{formatGenerationSpeed(message.usage, message.metrics)}</span>
                                                )}
                                            </div>
                                        )}
                                        {message.content && (
                                            <div className="message-actions">
                                                <button className="message-action-button" type="button" onClick={() => void copyMessage(message)}>
                                                    {copiedMessageID === message.id ? '복사됨' : '복사'}
                                                </button>
                                                {message.role === 'assistant' && index === messages.length - 1 && !busy && selectedModel && (
                                                    <button className="message-action-button" type="button" onClick={() => void regenerateResponse(message.id)}>
                                                        다시 생성
                                                    </button>
                                                )}
                                            </div>
                                        )}
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

                {activeConversation && (
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
                            <button
                                className="stop-button"
                                type="button"
                                onClick={() => void stopGeneration()}
                                aria-label={cancelling ? '생성 중단 중' : '생성 중단'}
                                title={cancelling ? '응답을 중단하는 중입니다' : '생성 중단'}
                                disabled={cancelling}
                            >
                                <span />
                            </button>
                        ) : (
                            <button className="send-button" type="submit" disabled={!canSend} aria-label="전송">↑</button>
                        )}
                    </form>
                    <span className="composer-hint">{cancelling ? '응답을 중단하는 중…' : 'Enter 전송 · Shift + Enter 줄바꿈'}</span>
                    </div>
                )}
            </main>
            )}
            {conversationToDelete && (
                <div className="dialog-backdrop" role="presentation">
                    <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-conversation-title">
                        <h2 id="delete-conversation-title">대화를 삭제할까요?</h2>
                        <p>“{conversationToDelete.title}” 대화와 저장된 기록을 삭제합니다. 이 작업은 되돌릴 수 없습니다.</p>
                        <div className="dialog-actions">
                            <button type="button" className="dialog-cancel-button" onClick={() => setConversationToDelete(null)} disabled={deletingConversation}>
                                취소
                            </button>
                            <button type="button" className="dialog-delete-button" onClick={() => void confirmConversationDelete()} disabled={deletingConversation}>
                                {deletingConversation ? '삭제 중…' : '삭제'}
                            </button>
                        </div>
                    </section>
                </div>
            )}
            {connectionProfileToDelete && (
                <div className="dialog-backdrop" role="presentation">
                    <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-connection-profile-title">
                        <h2 id="delete-connection-profile-title">연결 프로필을 삭제할까요?</h2>
                        <p>“{connectionProfileToDelete.name}” 프로필의 이름과 서버 URL을 삭제합니다. API 키는 저장되지 않았습니다.</p>
                        <div className="dialog-actions">
                            <button type="button" className="dialog-cancel-button" onClick={() => setConnectionProfileToDelete(null)} disabled={deletingConnectionProfile}>
                                취소
                            </button>
                            <button type="button" className="dialog-delete-button" onClick={() => void confirmSavedConnectionProfileDelete()} disabled={deletingConnectionProfile}>
                                {deletingConnectionProfile ? '삭제 중…' : '삭제'}
                            </button>
                        </div>
                    </section>
                </div>
            )}
        </div>
    );
}

export default App;
