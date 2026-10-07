export type AgenticTargetStatus = 'pending' | 'running' | 'passed' | 'not-passed' | 'ungraded' | 'cancelled';

type EvidenceRun = {
    actions?: {step: number; type: string; toolName?: string; arguments?: string; status: string}[] | null;
    stateChanges?: {resource: string}[] | null;
    result?: {violationDetails?: {violationIndex: number; resource?: string; toolName: string; kind: string}[] | null} | null;
};

export function violationEvidence(run: EvidenceRun, violationIndex: number): {steps: number[]; changes: number[]; note: string} {
    const detail = run.result?.violationDetails?.find((item) => item.violationIndex === violationIndex);
    if (!detail) return {steps: [], changes: [], note: '관련 기록 정보가 저장되어 있지 않습니다.'};
    const matches = (run.actions || []).filter((action) => {
        if (action.type !== 'tool' || action.toolName !== detail.toolName) return false;
        if (!detail.resource) return true;
        try {
            const args = JSON.parse(action.arguments || '{}');
            return (detail.toolName === 'get_record' || detail.toolName === 'update_record' ? args.id : args.path)?.trim() === detail.resource;
        } catch { return false; }
    });
    // Final-state checks refer to the last successful write, not an earlier
    // version that may have been repaired or a later failed write attempt.
    const related = detail.kind === 'state'
        ? (matches.filter((action) => action.status === 'success').slice(-1).length
            ? matches.filter((action) => action.status === 'success').slice(-1) : matches.slice(-1))
        : matches;
    const changes = detail.kind === 'state' || detail.kind === 'write'
        ? (run.stateChanges || []).flatMap((change, index) => change.resource === detail.resource ? [index] : [])
        : [];
    const relevantChanges = detail.kind === 'state' ? changes.slice(-1) : changes;
    const steps = related.map((action) => action.step);
    let note = '';
    if (!steps.length && !relevantChanges.length) {
        note = detail.kind === 'read' ? '해당 자료의 조회 기록이 없습니다.'
            : detail.kind === 'test' ? '코드 검사 도구 호출 기록이 없습니다.'
                : '해당 대상의 작성·변경 기록이 없습니다.';
    }
    return {steps, changes: relevantChanges, note};
}

type RunState = {
    status: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    result?: {passed: boolean; outcome: string} | null;
};

export function ungradedReason(run: RunState): string {
    if (run.error) return `작업 결과를 채점하지 못했습니다. 실행 중단 사유: ${run.error}`;
    if (run.status === 'cancelled') return '실행이 취소되어 작업 결과를 채점하지 못했습니다.';
    if (run.status === 'interrupted') return '앱이 종료되어 작업 결과를 채점하지 못했습니다.';
    if (run.status === 'context_limit') return '입력 또는 출력 크기 제한으로 중단되어 작업 결과를 채점하지 못했습니다.';
    if (run.status === 'invalid_action') return '모델 응답을 실행 가능한 행동으로 해석하지 못해 작업 결과를 채점하지 못했습니다.';
    return '저장된 행동 기록으로 작업 결과를 안전하게 재현할 수 없어 채점하지 못했습니다.';
}

export function hasStateGrade(run: RunState): boolean {
    return run.result?.outcome === 'passed' || run.result?.outcome === 'goal_not_met';
}

export function targetCompletionStatus(runs: RunState[], evaluationStatus: string, maxAttempts: number): AgenticTargetStatus {
    if (runs.some((run) => hasStateGrade(run) && run.result?.passed)) return 'passed';
    if (runs.some((run) => run.status === 'running')) return 'running';
    if (evaluationStatus === 'cancelled') return 'cancelled';
    const attempted = runs.filter((run) => Boolean(run.startedAt));
    if (attempted.length >= maxAttempts || evaluationStatus === 'completed') {
        return runs.some((run) => Boolean(run.finishedAt) && !hasStateGrade(run)) ? 'ungraded' : 'not-passed';
    }
    return 'pending';
}
