import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptHunk, anchorLine, computeHunks, joinLines, minimalEdit, rejectHunk, splitLines } from '../src/diff';

/** Accepting every hunk (last first, so offsets stay valid) must give the new text. */
function acceptAll(oldText: string, newText: string): string {
  let base = oldText;
  for (const h of computeHunks(oldText, newText).reverse()) base = acceptHunk(base, h);
  return base;
}

/** Rejecting every hunk must give the old text back. */
function rejectAll(oldText: string, newText: string): string {
  let cur = newText;
  for (const h of computeHunks(oldText, newText).reverse()) cur = rejectHunk(cur, h);
  return cur;
}

function roundTrips(oldText: string, newText: string): void {
  assert.equal(acceptAll(oldText, newText), newText);
  assert.equal(rejectAll(oldText, newText), oldText);
}

test('split/join round-trips', () => {
  for (const t of ['', 'a', 'a\n', 'a\r\nb\r\n', '\n\n']) assert.equal(joinLines(splitLines(t)), t);
  assert.deepEqual(splitLines(''), []);
});

test('no change → no hunks', () => {
  assert.deepEqual(computeHunks('a\nb\n', 'a\nb\n'), []);
});

test('simple change', () => {
  const hunks = computeHunks('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepEqual(hunks, [{ oldStart: 1, oldLines: ['b'], newStart: 1, newLines: ['B'] }]);
  roundTrips('a\nb\nc\n', 'a\nB\nc\n');
});

test('pure deletion', () => {
  const hunks = computeHunks('a\nb\nc\nd\n', 'a\nd\n');
  assert.deepEqual(hunks, [{ oldStart: 1, oldLines: ['b', 'c'], newStart: 1, newLines: [] }]);
  roundTrips('a\nb\nc\nd\n', 'a\nd\n');
});

test('pure deletion at end of file without trailing newline anchors past the end', () => {
  const hunks = computeHunks('a\nb', 'a');
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].newStart, 1);
  assert.deepEqual(hunks[0].newLines, []);
  assert.equal(anchorLine(hunks[0], 1), 0);
  roundTrips('a\nb', 'a');
});

test('CRLF lines are kept intact', () => {
  const oldText = 'one\r\ntwo\r\nthree\r\n';
  const newText = 'one\r\nTWO\r\nthree\r\n';
  const hunks = computeHunks(oldText, newText);
  assert.deepEqual(hunks, [{ oldStart: 1, oldLines: ['two\r'], newStart: 1, newLines: ['TWO\r'] }]);
  roundTrips(oldText, newText);
});

test('EOF without trailing newline', () => {
  roundTrips('a\nb', 'a\nb\nc');
  roundTrips('a\nb\n', 'a\nb');
  roundTrips('a\nb', 'a\nb\n');
});

test('new file (empty baseline)', () => {
  const hunks = computeHunks('', 'x\ny\n');
  assert.deepEqual(hunks, [{ oldStart: 0, oldLines: [], newStart: 0, newLines: ['x', 'y', ''] }]);
  roundTrips('', 'x\ny\n');
});

test('file emptied', () => {
  roundTrips('x\ny\n', '');
});

test('adjacent and multiple hunks are handled independently', () => {
  const oldText = 'a\nb\nc\nd\ne\nf\ng\n';
  const newText = 'a\nB\nc\nD\nd\ne\ng\nh\n';
  const hunks = computeHunks(oldText, newText);
  assert.ok(hunks.length >= 3);
  roundTrips(oldText, newText);
  // Accepting or rejecting a single hunk leaves the others in place.
  for (const h of hunks) {
    assert.equal(computeHunks(acceptHunk(oldText, h), newText).length, hunks.length - 1);
    assert.equal(computeHunks(oldText, rejectHunk(newText, h)).length, hunks.length - 1);
  }
});

test('minimalEdit produces the target and trims common text', () => {
  const cases: [string, string][] = [
    ['hello world', 'hello there world'],
    ['abc', 'abc'],
    ['', 'x'],
    ['x', ''],
    ['a\r\nb\r\n', 'a\r\nc\r\nb\r\n'],
    ['😀a', '😁a'],
  ];
  for (const [from, to] of cases) {
    const e = minimalEdit(from, to);
    assert.equal(from.slice(0, e.start) + e.text + from.slice(e.end), to);
  }
  assert.deepEqual(minimalEdit('hello world', 'hello there world'), { start: 6, end: 6, text: 'there ' });
});

test('minimalEdit never splits a CRLF or surrogate pair', () => {
  const e = minimalEdit('a\r\nb', 'a\nb');
  assert.ok(!(e.start > 0 && 'a\r\nb'[e.start - 1] === '\r' && 'a\r\nb'[e.start] === '\n'));
  const s = minimalEdit('😀', '😁');
  assert.equal(s.start, 0);
});
