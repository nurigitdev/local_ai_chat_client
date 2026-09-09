interface ContextMessage {
    role: 'user' | 'assistant';
    content: string;
    attachments: Array<{name: string; content: string}>;
}

function messageContentForModel(message: ContextMessage): string {
    const attachmentContent = message.attachments.map((attachment) => (
        `[첨부 파일: ${attachment.name}]\n${attachment.content}\n[첨부 파일 끝]`
    ));
    const request = message.content.trim();
    if (attachmentContent.length === 0) return request;
    return [...attachmentContent, request && `[사용자 요청]\n${request}`].filter(Boolean).join('\n\n');
}

export function messagesForModel(messages: ContextMessage[], includeHistory: boolean) {
    // A new send includes an empty assistant placeholder; a retry ends at the
    // question being retried. Find the user message for both request shapes.
    const latestQuestion = [...messages].reverse().find((message) => message.role === 'user');
    const context = includeHistory ? messages : latestQuestion ? [latestQuestion] : [];
    return context
        .map((message) => ({role: message.role, content: messageContentForModel(message)}))
        .filter((message) => message.role === 'user' || message.content !== '');
}
