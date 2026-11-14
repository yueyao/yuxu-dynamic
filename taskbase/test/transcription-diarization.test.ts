import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignSpeakers, normalizeTurns } from '../src/transcription/diarization.ts';

test('整集统一编号，词级切换保留中英文空格标点、跨600秒身份一致', () => {
  const turns = normalizeTurns([
    { start: 601, end: 603, speaker: 'alice' }, { start: 0, end: 1, speaker: 'alice' },
    { start: 1, end: 2, speaker: 'bob' },
  ]);
  const aligned = alignSpeakers([
    { start: 0, end: 2, text: '你好， world!', words: [
      { start: 0, end: 1, text: '你好，' }, { start: 1, end: 2, text: ' world!' }] },
    { start: 601, end: 602, text: '回来。' },
  ], turns);
  assert.deepEqual(aligned.map((s) => s.speaker_id), ['speaker_1', 'speaker_2', 'speaker_1']);
  assert.equal(aligned.slice(0, 2).map((s) => s.text).join(''), '你好， world!');
  assert.equal('words' in aligned[0]!, false);
});

test('重叠/无交集标未知，同人重复区间不会重复计权，文本不匹配回退整段', () => {
  const turns = normalizeTurns([{ start: 0, end: 2, speaker: 'a' },
    { start: 0, end: 2, speaker: 'a' }, { start: 0, end: 2, speaker: 'b' }]);
  const result = alignSpeakers([{ start: 0, end: 2, text: '重叠' },
    { start: 3, end: 4, text: '没有' }], turns);
  assert.ok(result.every((s) => !s.speaker_id));
  const fallback = alignSpeakers([{ start: 0, end: 2, text: '不能丢字',
    words: [{ start: 0, end: 1, text: '丢字' }] }], normalizeTurns([{ start: 0, end: 2, speaker: 'a' }]));
  assert.equal(fallback[0]?.text, '不能丢字');
  assert.equal(fallback[0]?.speaker_id, 'speaker_1');
  assert.throws(() => normalizeTurns([{ start: 1, end: 0, speaker: 'a' }]), /DIARIZATION_INVALID/);
});

test('主导覆盖阈值、零时长词回退、单人连续与三人编号', () => {
  const turns = normalizeTurns([{ start: 0, end: 3, speaker: 'a' },
    { start: 3, end: 4, speaker: 'b' }, { start: 4, end: 5, speaker: 'c' }]);
  const result = alignSpeakers([{ start: 0, end: 3, text: '你好', words: [
    { start: 0, end: 1, text: '你' }, { start: 1, end: 3, text: '好' }] },
    { start: 3, end: 4, text: '第二', words: [{ start: 3, end: 3, text: '第二' }] },
    { start: 4, end: 5, text: '第三' }], turns);
  assert.deepEqual(result.map((s) => s.speaker_id), ['speaker_1', 'speaker_2', 'speaker_3']);
  assert.equal(result[0]?.text, '你好');
});
