export interface AttachmentChunk {
    label: string;
    content: string;
}

export interface AttachmentSelection {
    content: string;
    truncated: boolean;
    selectionSummary?: string;
}

const chunkTargetSize = 16 * 1024;
const selectionOverheadSize = 8 * 1024;
const attachmentExcerptMarker = '\n\n[문서가 길어 앞부분과 뒷부분만 모델에 전달했습니다.]\n\n';
const queryStopWords = new Set([
    '이', '그', '저', '것', '내용', '문서', '파일', '관련', '대해', '대한', '해서', '해주세요', '해줘',
    '알려줘', '알려주세요', '설명해줘', '설명해주세요', '정리해줘', '정리해주세요', '요약해줘', '요약해주세요',
    'the', 'and', 'for', 'with', 'from', 'about', 'this', 'that', 'please', 'document', 'file',
]);

export function textByteSize(content: string): number {
    return new TextEncoder().encode(content).byteLength;
}

function decodeLeadingUTF8(bytes: Uint8Array, length: number): string {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    for (let trim = 0; trim < 4; trim += 1) {
        try {
            return decoder.decode(bytes.slice(0, length - trim));
        } catch {
            // Avoid splitting a multi-byte character at an excerpt boundary.
        }
    }
    return new TextDecoder().decode(bytes.slice(0, length));
}

function decodeTrailingUTF8(bytes: Uint8Array, length: number): string {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    for (let trim = 0; trim < 4; trim += 1) {
        try {
            return decoder.decode(bytes.slice(bytes.length - length + trim));
        } catch {
            // Avoid splitting a multi-byte character at an excerpt boundary.
        }
    }
    return new TextDecoder().decode(bytes.slice(bytes.length - length));
}

function headingLabel(line: string): string | null {
    const value = line.trim();
    const pdfPage = value.match(/^\[PDF\s+(\d+)쪽\]$/);
    if (pdfPage) return `PDF ${pdfPage[1]}쪽`;

    const markdown = value.match(/^#{1,6}\s+(.+)$/);
    if (markdown) return markdown[1].trim();

    if (/^(?:제\s*\d+\s*(?:편|부|장|절|조)|\d+(?:\.\d+){0,4}[.)]?)\s+\S+/.test(value)) {
        return value;
    }
    return null;
}

function splitOversizedBlock(content: string, maxBytes: number): string[] {
    const pieces: string[] = [];
    let remaining = content.trim();
    while (textByteSize(remaining) > maxBytes) {
        const leading = decodeLeadingUTF8(new TextEncoder().encode(remaining), maxBytes);
        const threshold = Math.floor(leading.length * 0.45);
        const boundaries: number[] = [];
        for (const match of leading.matchAll(/\n\s*\n|\n|[.!?。！？](?:\s|$)/g)) {
            const boundary = (match.index || 0) + match[0].length;
            if (boundary >= threshold) boundaries.push(boundary);
        }
        const boundary = boundaries.length > 0 ? boundaries[boundaries.length - 1] : leading.length;
        const piece = leading.slice(0, boundary).trimEnd();
        if (!piece) break;
        pieces.push(piece);
        remaining = remaining.slice(boundary).trimStart();
    }
    if (remaining) pieces.push(remaining);
    return pieces;
}

function documentBlocks(content: string): Array<{label: string; content: string}> {
    const blocks: Array<{label: string; content: string}> = [];
    let currentLabel = '문서 내용';
    for (const paragraph of content.trim().split(/\n{2,}/)) {
        const lines = paragraph.split('\n');
        let segment: string[] = [];
        const pushSegment = () => {
            const value = segment.join('\n').trim();
            if (value) blocks.push({label: currentLabel, content: value});
            segment = [];
        };

        for (const line of lines) {
            const label = headingLabel(line);
            if (label && segment.some((value) => value.trim() !== '')) {
                pushSegment();
            }
            if (label) currentLabel = label;
            segment.push(line);
        }
        pushSegment();
    }
    return blocks;
}

export function createAttachmentChunks(content: string): AttachmentChunk[] {
    const normalized = content.replace(/\r\n?/g, '\n').trim();
    if (!normalized) return [];

    const chunks: AttachmentChunk[] = [];
    let current: AttachmentChunk | null = null;
    const pushCurrent = () => {
        if (current?.content) chunks.push(current);
        current = null;
    };

    for (const block of documentBlocks(normalized)) {
        const pieces = splitOversizedBlock(block.content, chunkTargetSize);
        for (let index = 0; index < pieces.length; index += 1) {
            const label = pieces.length > 1 ? `${block.label} · 계속 ${index + 1}` : block.label;
            const contentWithSeparator = current ? `${current.content}\n\n${pieces[index]}` : pieces[index];
            if (current && (current.label !== label || textByteSize(contentWithSeparator) > chunkTargetSize)) {
                pushCurrent();
            }
            if (!current) {
                current = {label, content: pieces[index]};
            } else {
                current.content = contentWithSeparator;
            }
        }
    }
    pushCurrent();
    return chunks;
}

function fallbackExcerpt(content: string, contentBudget: number): AttachmentSelection {
    const normalized = content.replace(/\r\n?/g, '\n');
    const bytes = new TextEncoder().encode(normalized);
    if (bytes.byteLength <= contentBudget) {
        return {content: normalized, truncated: false};
    }

    const availableSize = contentBudget - textByteSize(attachmentExcerptMarker);
    const leadingSize = Math.floor(availableSize * 0.7);
    const trailingSize = availableSize - leadingSize;
    return {
        content: `${decodeLeadingUTF8(bytes, leadingSize)}${attachmentExcerptMarker}${decodeTrailingUTF8(bytes, trailingSize)}`,
        truncated: true,
        selectionSummary: '앞·뒤 발췌본 전달',
    };
}

function queryTerms(query: string): string[] {
    const terms = new Set<string>();
    for (const token of query.toLocaleLowerCase('ko-KR').match(/[\p{L}\p{N}]{2,}/gu) || []) {
        if (!queryStopWords.has(token)) terms.add(token);
        const withoutParticle = token.replace(/(은|는|이|가|을|를|와|과|에|의|으로|로|에서|에게|한테|부터|까지|보다|처럼|도|만)$/u, '');
        if (withoutParticle.length >= 2 && !queryStopWords.has(withoutParticle)) {
            terms.add(withoutParticle);
        }
    }
    return [...terms];
}

function relevanceScore(chunk: AttachmentChunk, terms: string[]): number {
    const label = chunk.label.toLocaleLowerCase('ko-KR');
    const content = chunk.content.toLocaleLowerCase('ko-KR');
    let score = 0;
    for (const term of terms) {
        if (label.includes(term)) score += 8;
        const occurrences = content.split(term).length - 1;
        score += Math.min(occurrences, 3) * 2;
    }
    return score;
}

function displayLabel(label: string): string {
    const trimmed = label.replace(/\s+/g, ' ').trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}

function selectedChunkSize(chunk: AttachmentChunk, index: number, total: number): number {
    return textByteSize(`[문서 단위 ${index + 1}/${total}: ${displayLabel(chunk.label)}]\n${chunk.content}\n\n`);
}

function renderSelectedChunks(
    chunks: AttachmentChunk[],
    selected: Map<number, number>,
    contentBudget: number,
): {content: string; selectedCount: number} | null {
    const selectedIndexes = [...selected.keys()].sort((left, right) => left - right);
    const render = (indexes: number[]) => {
        const header = `[문서 전체 ${chunks.length}개 단위 중 ${indexes.length}개를 질문 관련성과 앞뒤 문맥에 따라 전달합니다.]`;
        return `${header}\n\n${indexes.map((index) => (
            `[문서 단위 ${index + 1}/${chunks.length}: ${displayLabel(chunks[index].label)}]\n${chunks[index].content}`
        )).join('\n\n')}`;
    };

    while (selectedIndexes.length > 0) {
        const content = render(selectedIndexes);
        if (textByteSize(content) <= contentBudget) {
            return {content, selectedCount: selectedIndexes.length};
        }

        let removeAt = 0;
        for (let index = 1; index < selectedIndexes.length; index += 1) {
            const candidate = selectedIndexes[index];
            const current = selectedIndexes[removeAt];
            if ((selected.get(candidate) || 0) < (selected.get(current) || 0)) {
                removeAt = index;
            }
        }
        selectedIndexes.splice(removeAt, 1);
    }
    return null;
}

export function selectAttachmentContent(
    source: string,
    chunks: AttachmentChunk[],
    query: string,
    contentBudget: number,
): AttachmentSelection {
    const normalized = source.replace(/\r\n?/g, '\n');
    if (textByteSize(normalized) <= contentBudget) {
        return {content: normalized, truncated: false};
    }

    const terms = queryTerms(query);
    const ranked = chunks
        .map((chunk, index) => ({index, score: relevanceScore(chunk, terms)}))
        .filter((chunk) => chunk.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);
    if (ranked.length === 0) {
        return fallbackExcerpt(normalized, contentBudget);
    }

    const availableSize = Math.max(0, contentBudget - selectionOverheadSize);
    const anchorBudget = Math.floor(availableSize * 0.3);
    const selected = new Map<number, number>();
    let usedSize = 0;
    const add = (index: number, priority: number, limit: number) => {
        if (index < 0 || index >= chunks.length || selected.has(index)) return false;
        const size = selectedChunkSize(chunks[index], index, chunks.length);
        if (usedSize + size > limit) return false;
        selected.set(index, priority);
        usedSize += size;
        return true;
    };

    let left = 0;
    let right = chunks.length - 1;
    let useLeading = true;
    while (left <= right && usedSize < anchorBudget) {
        const index = useLeading ? left++ : right--;
        add(index, 1, anchorBudget);
        useLeading = !useLeading;
    }

    for (const {index} of ranked) {
        add(index, 3, availableSize);
    }
    for (const {index} of ranked) {
        add(index - 1, 2, availableSize);
        add(index + 1, 2, availableSize);
    }

    const rendered = renderSelectedChunks(chunks, selected, contentBudget);
    if (!rendered || rendered.selectedCount === 0) {
        return fallbackExcerpt(normalized, contentBudget);
    }
    return {
        content: rendered.content,
        truncated: true,
        selectionSummary: `문서 ${chunks.length}개 단위 중 ${rendered.selectedCount}개 전달`,
    };
}
