export type ReasoningEffort = '' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const reasoningEffortOptions: Array<{value: ReasoningEffort; label: string}> = [
    {value: '', label: '자동 (auto)'},
    {value: 'none', label: '없음 (none)'},
    {value: 'minimal', label: '최소 (minimal)'},
    {value: 'low', label: '낮음 (low)'},
    {value: 'medium', label: '보통 (medium)'},
    {value: 'high', label: '높음 (high)'},
    {value: 'xhigh', label: '매우 높음 (xhigh)'},
    {value: 'max', label: '최대 (max)'},
];

export function reasoningEffortLabel(value?: string): string {
    return reasoningEffortOptions.find((option) => option.value === value)?.label || '자동 (auto)';
}

export function reasoningEffortFilenameTag(value?: string): string {
    const normalized = reasoningEffortOptions.some((option) => option.value === value) ? value : '';
    return `r-${normalized || 'auto'}`;
}

export function reasoningEffortWarning(value: ReasoningEffort): string {
    if (value === 'xhigh') {
        return 'xhigh는 응답 시간과 토큰 사용량이 늘어날 수 있으며, 지원하지 않는 서버에서는 실행이 실패할 수 있습니다.';
    }
    if (value === 'max') {
        return 'max는 가장 높은 추론 강도입니다. 응답 시간과 토큰 사용량이 크게 늘어날 수 있으며, 지원하지 않는 서버에서는 실행이 실패할 수 있습니다.';
    }
    return '';
}
