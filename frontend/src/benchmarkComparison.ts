export type PracticalBenchmarkSuite = 'document' | 'development';
export type PracticalComparisonLabel = 'A' | 'B' | 'C';
export type PracticalComparisonSelection = Record<PracticalComparisonLabel, string>;
export type PracticalBenchmarkRecord = {
    id: string;
    suiteName: string;
    model: string;
    profileName: string;
    profileBaseURL: string;
    reasoningEffort?: string;
    updatedAt: string;
};

export type PracticalBenchmarkPairCandidate = {
    id: string;
    document: PracticalBenchmarkRecord;
    development: PracticalBenchmarkRecord;
};

export function practicalBenchmarkSuite(suiteName: string): PracticalBenchmarkSuite | null {
    const normalized = suiteName.replace(/[\s·/]+/g, '');
    if (normalized.includes('문서한국어실무')) return 'document';
    if (normalized.includes('개발지시이행')) return 'development';
    return null;
}

export function normalizeComparisonSelection(
    availableIDs: string[],
    selection: PracticalComparisonSelection,
): PracticalComparisonSelection {
    const A = availableIDs.includes(selection.A) ? selection.A : availableIDs[0] || '';
    const B = availableIDs.includes(selection.B) && selection.B !== A
        ? selection.B
        : availableIDs.find((id) => id !== A) || '';
    const C = availableIDs.includes(selection.C) && selection.C !== A && selection.C !== B
        ? selection.C
        : '';
    return {A, B, C};
}

export function practicalBenchmarkConditionKey(record: PracticalBenchmarkRecord): string {
    return [record.model, record.profileName, record.profileBaseURL, record.reasoningEffort || ''].join('\u0000');
}

export function mapComparisonSelectionToSuite(
    sourceRecords: PracticalBenchmarkRecord[],
    sourceSelection: PracticalComparisonSelection,
    targetRecords: PracticalBenchmarkRecord[],
    targetSelection: PracticalComparisonSelection,
): PracticalComparisonSelection {
    const recordsByID = new Map(sourceRecords.map((record) => [record.id, record]));
    const targetByCondition = new Map<string, PracticalBenchmarkRecord>();
    for (const record of targetRecords) {
        const key = practicalBenchmarkConditionKey(record);
        if (!targetByCondition.has(key)) targetByCondition.set(key, record);
    }
    const usedIDs = new Set<string>();
    const next = {} as PracticalComparisonSelection;
    for (const label of ['A', 'B', 'C'] as PracticalComparisonLabel[]) {
        const source = recordsByID.get(sourceSelection[label]);
        const matching = source ? targetByCondition.get(practicalBenchmarkConditionKey(source)) : undefined;
        const existing = targetRecords.find((record) => record.id === targetSelection[label]);
        const selected = matching || existing;
        next[label] = selected && !usedIDs.has(selected.id) ? selected.id : '';
        if (next[label]) usedIDs.add(next[label]);
    }
    return next;
}

function isMoreRecent(left: PracticalBenchmarkRecord, right: PracticalBenchmarkRecord): boolean {
    const leftTime = Date.parse(left.updatedAt) || 0;
    const rightTime = Date.parse(right.updatedAt) || 0;
    return leftTime > rightTime || (leftTime === rightTime && left.id > right.id);
}

// A condition is model + connection profile + server + reasoning effort. Repeated
// runs under that condition are represented by the most recent completed pair.
export function practicalBenchmarkPairCandidates(records: PracticalBenchmarkRecord[]): PracticalBenchmarkPairCandidate[] {
    const documents = new Map<string, PracticalBenchmarkRecord>();
    const developments = new Map<string, PracticalBenchmarkRecord>();
    for (const record of records) {
        const suite = practicalBenchmarkSuite(record.suiteName);
        if (!suite) continue;
        const target = suite === 'document' ? documents : developments;
        const key = practicalBenchmarkConditionKey(record);
        const current = target.get(key);
        if (!current || isMoreRecent(record, current)) target.set(key, record);
    }
    return [...documents.entries()]
        .flatMap(([key, document]) => {
            const development = developments.get(key);
            return development ? [{id: `${document.id}:${development.id}`, document, development}] : [];
        })
        .sort((left, right) => {
            const leftTime = Math.max(Date.parse(left.document.updatedAt) || 0, Date.parse(left.development.updatedAt) || 0);
            const rightTime = Math.max(Date.parse(right.document.updatedAt) || 0, Date.parse(right.development.updatedAt) || 0);
            return rightTime - leftTime || left.id.localeCompare(right.id);
        });
}
