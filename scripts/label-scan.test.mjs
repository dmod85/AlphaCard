import assert from 'node:assert/strict';
import test from 'node:test';
import { decideLabelScan } from './label-print.mjs';

test('a new file waits until the next look, then prints once', () => {
    const first = decideLabelScan({ recordedMtime: undefined, size: 100, mtime: 5, pending: undefined, hash: null, printedHashes: {} });
    assert.equal(first.type, 'wait');
    const second = decideLabelScan({
        recordedMtime: undefined,
        size: 100,
        mtime: 5,
        pending: first.pending,
        hash: 'abc',
        printedHashes: {},
    });
    assert.equal(second.type, 'print');
});

test('a file still downloading is not printed', () => {
    const first = decideLabelScan({ recordedMtime: undefined, size: 10, mtime: 1, pending: undefined, hash: null, printedHashes: {} });
    const grown = decideLabelScan({
        recordedMtime: undefined,
        size: 80,
        mtime: 2,
        pending: first.pending,
        hash: 'abc',
        printedHashes: {},
    });
    assert.equal(grown.type, 'wait');
});

test('the same bytes are not printed from a second copy', () => {
    const decision = decideLabelScan({
        recordedMtime: undefined,
        size: 100,
        mtime: 9,
        pending: { size: 100, mtime: 9 },
        hash: 'abc',
        printedHashes: { abc: 1 },
    });
    assert.equal(decision.type, 'duplicate');
});

test('a recorded mtime is left alone', () => {
    const decision = decideLabelScan({
        recordedMtime: 5,
        size: 100,
        mtime: 5,
        pending: undefined,
        hash: 'abc',
        printedHashes: {},
    });
    assert.equal(decision.type, 'seen');
});
