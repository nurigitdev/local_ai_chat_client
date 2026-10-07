import assert from 'node:assert/strict';
import test from 'node:test';
import {hasStateGrade, targetCompletionStatus, ungradedReason, violationEvidence} from '../.vite/test/agenticResult.js';

test('the final attempt remains running until it finishes', () => {
    const run = {status: 'running', startedAt: '2026-10-07T00:00:00Z'};
    assert.equal(targetCompletionStatus([run], 'running', 1), 'running');
});

test('final-state evidence uses the last successful write and last change of that exact resource', () => {
    const run = {
        result: {violationDetails: [{violationIndex: 0, kind: 'state', toolName: 'write_file', resource: 'result.json'}]},
        actions: [
            {step: 1, type: 'tool', toolName: 'write_file', arguments: '{"path":"result.json"}', status: 'success'},
            {step: 2, type: 'tool', toolName: 'write_file', arguments: '{"path":"other.json"}', status: 'success'},
            {step: 3, type: 'tool', toolName: 'write_file', arguments: '{"path":"result.json"}', status: 'success'},
            {step: 4, type: 'tool', toolName: 'write_file', arguments: '{"path":"result.json"}', status: 'error'},
        ],
        stateChanges: [{resource: 'result.json'}, {resource: 'other.json'}, {resource: 'result.json'}],
    };
    assert.deepEqual(violationEvidence(run, 0), {steps: [3], changes: [2], note: ''});
});

test('read evidence includes failed queries but does not include searches, other records or changes', () => {
    const run = {
        result: {violationDetails: [{violationIndex: 0, kind: 'read', toolName: 'get_record', resource: 'R-401'}]},
        actions: [
            {step: 1, type: 'tool', toolName: 'get_record', arguments: '{"id":"R-401"}', status: 'error'},
            {step: 2, type: 'tool', toolName: 'get_record', arguments: '{"id":"R-402"}', status: 'success'},
            {step: 3, type: 'tool', toolName: 'list_records', arguments: '{}', status: 'success'},
            {step: 4, type: 'tool', toolName: 'get_record', arguments: '{"id":', status: 'error'},
        ],
        stateChanges: [{resource: 'R-401'}],
    };
    assert.deepEqual(violationEvidence(run, 0), {steps: [1], changes: [], note: ''});
});

test('missing calls and old records do not fabricate evidence links', () => {
    const result = {violationDetails: [{violationIndex: 0, kind: 'test', toolName: 'run_tests'}]};
    const missing = violationEvidence({result}, 0);
    assert.deepEqual(missing.steps, []);
    assert.match(missing.note, /호출 기록이 없습니다/);
    const legacy = violationEvidence({actions: [{step: 1, type: 'tool', toolName: 'run_tests', status: 'success'}]}, 0);
    assert.deepEqual(legacy.steps, []);
    assert.match(legacy.note, /정보가 저장되어 있지 않습니다/);
});

test('ungraded explanations distinguish cancellation, limits and unverifiable history', () => {
    assert.match(ungradedReason({status: 'cancelled'}), /취소/);
    assert.match(ungradedReason({status: 'context_limit'}), /크기 제한/);
    assert.match(ungradedReason({status: 'connection_error'}), /안전하게 재현/);
    assert.match(ungradedReason({status: 'connection_error', error: '연결 종료'}), /연결 종료/);
});

test('an interrupted but graded run may pass', () => {
    const run = {
        status: 'connection_error', startedAt: '2026-10-07T00:00:00Z', finishedAt: '2026-10-07T00:01:00Z',
        result: {passed: true, outcome: 'passed'},
    };
    assert.equal(hasStateGrade(run), true);
    assert.equal(targetCompletionStatus([run], 'completed', 1), 'passed');
});

test('technical failure without a grade is not shown as a failed grade', () => {
    const run = {
        status: 'connection_error', startedAt: '2026-10-07T00:00:00Z', finishedAt: '2026-10-07T00:01:00Z',
        result: {passed: false, outcome: 'connection_error'},
    };
    assert.equal(hasStateGrade(run), false);
    assert.equal(targetCompletionStatus([run], 'completed', 1), 'ungraded');
    assert.equal(targetCompletionStatus([{...run, result: {passed: false, outcome: 'goal_not_met'}}], 'completed', 1), 'not-passed');
});
