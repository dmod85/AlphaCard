import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slipContentDisposition } from './slip-disposition';

test('inline disposition keeps a safe eBay order number in the filename', () => {
    assert.equal(
        slipContentDisposition('86-15472-64588', false),
        'inline; filename="packing-slip-86-15472-64588.pdf"',
    );
});

test('download=true uses attachment instead of inline', () => {
    assert.equal(
        slipContentDisposition('86-15472-64588', true),
        'attachment; filename="packing-slip-86-15472-64588.pdf"',
    );
});

test('strips characters outside A-Za-z0-9_- from the filename', () => {
    assert.equal(
        slipContentDisposition('86/15472;64588.pdf', true),
        'attachment; filename="packing-slip-861547264588pdf.pdf"',
    );
});

test('underscores and letters are kept', () => {
    assert.equal(
        slipContentDisposition('Order_ABCdef', false),
        'inline; filename="packing-slip-Order_ABCdef.pdf"',
    );
});
