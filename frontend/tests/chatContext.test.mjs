import assert from 'node:assert/strict';
import test from 'node:test';
import {messagesForModel} from '../.vite/test/chatContext.js';

const previousQuestion = {
    role: 'user', content: '이전 문서를 요약해줘.',
    attachments: [{name: 'previous.txt', content: '이전 문서 내용'}],
};
const previousAnswer = {role: 'assistant', content: '이전 문서의 요약입니다.', attachments: []};
const currentQuestion = {
    role: 'user', content: '현재 문서를 설명해줘.',
    attachments: [{name: 'current.txt', content: '현재 문서 내용'}],
};
const placeholder = {role: 'assistant', content: '', attachments: []};
const currentContent = '[첨부 파일: current.txt]\n현재 문서 내용\n[첨부 파일 끝]\n\n[사용자 요청]\n현재 문서를 설명해줘.';

test('history off sends the current question and attachment without changing saved history', () => {
    const messages = [previousQuestion, previousAnswer, currentQuestion, placeholder];
    const savedHistory = structuredClone(messages);
    assert.deepEqual(messagesForModel(messages, false), [{role: 'user', content: currentContent}]);
    assert.deepEqual(messages, savedHistory);
});

test('history on includes previous questions, answers, and attachments in order', () => {
    assert.deepEqual(messagesForModel([previousQuestion, previousAnswer, currentQuestion, placeholder], true), [
        {role: 'user', content: '[첨부 파일: previous.txt]\n이전 문서 내용\n[첨부 파일 끝]\n\n[사용자 요청]\n이전 문서를 요약해줘.'},
        {role: 'assistant', content: previousAnswer.content},
        {role: 'user', content: currentContent},
    ]);
});

test('retry applies the selected history setting to the question being regenerated', () => {
    const retryMessages = [previousQuestion, previousAnswer, currentQuestion];
    assert.deepEqual(messagesForModel(retryMessages, false), [{role: 'user', content: currentContent}]);
    assert.deepEqual(messagesForModel(retryMessages, true), messagesForModel([...retryMessages, placeholder], true));
});

test('an attachment-only question remains sendable with history off', () => {
    const attachmentOnly = {...currentQuestion, content: '   '};
    assert.deepEqual(messagesForModel([previousQuestion, previousAnswer, attachmentOnly, placeholder], false), [
        {role: 'user', content: '[첨부 파일: current.txt]\n현재 문서 내용\n[첨부 파일 끝]'},
    ]);
    assert.deepEqual(messagesForModel([previousAnswer, placeholder], false), []);
});
