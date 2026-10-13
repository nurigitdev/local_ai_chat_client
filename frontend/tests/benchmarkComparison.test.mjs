import assert from 'node:assert/strict';
import test from 'node:test';
import {
    mapComparisonSelectionToSuite,
    normalizeComparisonSelection,
    practicalBenchmarkPairCandidates,
    practicalBenchmarkSuite,
} from '../.vite/test/benchmarkComparison.js';

function record(id, suiteName, updatedAt, model = 'model-a', profileBaseURL = 'http://server-a', reasoningEffort = 'auto') {
    return {id, suiteName, updatedAt, model, profileBaseURL, reasoningEffort, profileName: '기본', status: 'completed', caseCount: 4};
}

test('practical comparison keeps only the latest pair for each execution condition', () => {
    const candidates = practicalBenchmarkPairCandidates([
        record('document-old', '문서·한국어 실무', '2026-10-01T00:00:00Z'),
        record('development-old', '개발·지시 이행', '2026-10-01T00:01:00Z'),
        record('document-new', '문서·한국어 실무', '2026-10-02T00:00:00Z'),
        record('development-new', '개발·지시 이행', '2026-10-02T00:01:00Z'),
    ]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].document.id, 'document-new');
    assert.equal(candidates[0].development.id, 'development-new');
});

test('practical comparison keeps distinct model, server and reasoning conditions separate', () => {
    const candidates = practicalBenchmarkPairCandidates([
        record('a-doc', '문서/한국어 실무', '2026-10-01T00:00:00Z'),
        record('a-dev', '개발/지시 이행', '2026-10-01T00:01:00Z'),
        record('b-doc', '문서·한국어 실무', '2026-10-02T00:00:00Z', 'model-b'),
        record('b-dev', '개발·지시 이행', '2026-10-02T00:01:00Z', 'model-b'),
        record('unpaired', '문서·한국어 실무', '2026-10-03T00:00:00Z', 'model-c'),
    ]);
    assert.deepEqual(candidates.map((candidate) => candidate.document.model).sort(), ['model-a', 'model-b']);
    assert.equal(practicalBenchmarkSuite('문서/한국어 실무'), 'document');
    assert.equal(practicalBenchmarkSuite('개발·지시 이행'), 'development');
});

test('practical comparison keeps connection profiles with the same server separate', () => {
    const candidates = practicalBenchmarkPairCandidates([
        record('profile-a-doc', '문서·한국어 실무', '2026-10-01T00:00:00Z'),
        record('profile-a-dev', '개발·지시 이행', '2026-10-01T00:01:00Z'),
        {...record('profile-b-doc', '문서·한국어 실무', '2026-10-02T00:00:00Z'), profileName: '다른 프로필'},
        {...record('profile-b-dev', '개발·지시 이행', '2026-10-02T00:01:00Z'), profileName: '다른 프로필'},
    ]);
    assert.equal(candidates.length, 2);
});

test('comparison selection keeps its A, B and C records when they remain available', () => {
    assert.deepEqual(
        normalizeComparisonSelection(['document-new', 'document-old', 'document-third'], {
            A: 'document-old',
            B: 'document-new',
            C: 'document-third',
        }),
        {A: 'document-old', B: 'document-new', C: 'document-third'},
    );
});

test('comparison keeps A and B assigned to matching conditions across suites', () => {
    const documentRecords = [
        record('document-profile-a', '문서·한국어 실무', '2026-10-02T00:00:00Z'),
        {...record('document-profile-b', '문서·한국어 실무', '2026-10-01T00:00:00Z'), profileName: '다른 프로필'},
    ];
    const developmentRecords = [
        {...record('development-profile-b', '개발·지시 이행', '2026-10-02T00:00:00Z'), profileName: '다른 프로필'},
        record('development-profile-a', '개발·지시 이행', '2026-10-01T00:00:00Z'),
    ];
    assert.deepEqual(
        mapComparisonSelectionToSuite(
            documentRecords,
            {A: 'document-profile-a', B: 'document-profile-b', C: ''},
            developmentRecords,
            {A: '', B: '', C: ''},
        ),
        {A: 'development-profile-a', B: 'development-profile-b', C: ''},
    );
});
