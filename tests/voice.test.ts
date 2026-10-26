import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OneBotApiError, type OneBotClient } from '../src/onebot-client.ts';
import { listVoiceCharacters, sendAiVoice, transcribeVoice } from '../src/voice.ts';

function fixture(response: unknown) {
  const calls: Array<{ action: string; params: Record<string, unknown>; signal?: AbortSignal }> = [];
  const client: Pick<OneBotClient, 'raw'> = {
    async raw<T>(action: string, params: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<T> {
      calls.push({ action, params, signal: options.signal });
      if (response instanceof Error) throw response;
      return response as T;
    },
  };
  return { client, calls };
}

test('voice catalog preserves categories and exposes public QQ character identifiers', async () => {
  const f = fixture([{ type: '经典', characters: [
    { character_id: 'voice-1', character_name: '示例音色', preview_url: 'https://example.com/preview.mp3', ignored: 'extra' },
    { character_id: 'voice-2', character_name: '另一音色' },
  ] }]);
  const signal = new AbortController().signal;
  assert.deepEqual(await listVoiceCharacters(f.client, '123456', signal), [{ type: '经典', characters: [
    { id: 'voice-1', name: '示例音色', previewUrl: 'https://example.com/preview.mp3' },
    { id: 'voice-2', name: '另一音色' },
  ] }]);
  assert.deepEqual(f.calls, [{ action: 'get_ai_characters', params: { group_id: 123456 }, signal }]);
  assert.deepEqual(await listVoiceCharacters(fixture([]).client, '123456'), []);
});

test('AI speech sends one native QQ voice action and returns its signed receipt', async () => {
  const f = fixture({ message_id: -42 });
  const signal = new AbortController().signal;
  assert.deepEqual(await sendAiVoice(f.client, '123456', ' 晚上好。 ', 'voice-1', signal), { messageId: '-42' });
  assert.deepEqual(f.calls, [{ action: 'send_group_ai_record', params: {
    group_id: 123456, character: 'voice-1', text: ' 晚上好。 ',
  }, signal }]);
});

test('transcription uses the QQ message ID and preserves the returned text', async () => {
  const f = fixture({ text: '你好\n这是 QQ 语音识别。' });
  const signal = new AbortController().signal;
  assert.deepEqual(await transcribeVoice(f.client, -77, signal), { text: '你好\n这是 QQ 语音识别。' });
  assert.deepEqual(f.calls, [{ action: 'fetch_ptt_text', params: { message_id: -77 }, signal }]);
  await assert.rejects(transcribeVoice(fixture({ text: '  ' }).client, -77), /暂未返回语音文字/);
});

test('voice actions validate local inputs before dispatch', async () => {
  const f = fixture(null);
  for (const groupId of ['../123', '0', '-1', '9007199254740992', '1e3']) {
    await assert.rejects(listVoiceCharacters(f.client, groupId));
    await assert.rejects(sendAiVoice(f.client, groupId, 'hello', 'voice-1'));
  }
  for (const messageId of [0, 1.5, NaN, Infinity, 2_147_483_648, -2_147_483_649]) {
    await assert.rejects(transcribeVoice(f.client, messageId));
  }
  await assert.rejects(sendAiVoice(f.client, '123456', ' ', 'voice-1'), /非空文字/);
  await assert.rejects(sendAiVoice(f.client, '123456', 'hello', ' '), /语音角色/);
  assert.equal(f.calls.length, 0);
});

test('voice response validation rejects malformed catalog, speech receipts and text', async () => {
  for (const result of [null, {}, [null], [{ type: 'voices', characters: [null] }],
    [{ type: 'voices', characters: [{ character_id: '', character_name: 'voice' }] }],
    [{ type: 'voices', characters: [{ character_id: '1', character_name: 'voice', preview_url: 3 }] }]]) {
    await assert.rejects(listVoiceCharacters(fixture(result).client, '123456'), /无效/);
  }
  for (const result of [null, 'audio-url', {}, { message_id: 0 }, { message_id: true }, { message_id: '4.2' }, { message_id: 2_147_483_648 }]) {
    await assert.rejects(sendAiVoice(fixture(result).client, '123456', 'hello', 'voice-1'));
  }
  for (const result of [null, {}, { text: 12 }]) await assert.rejects(transcribeVoice(fixture(result).client, -77), /无效/);
});

test('cancelled requests are not dispatched and API failures are never retried or replaced', async () => {
  const stopped = new AbortController(); stopped.abort(new Error('caller cancelled'));
  const f = fixture(null);
  await assert.rejects(listVoiceCharacters(f.client, '123456', stopped.signal), /caller cancelled/);
  await assert.rejects(sendAiVoice(f.client, '123456', 'hello', 'voice-1', stopped.signal), /caller cancelled/);
  await assert.rejects(transcribeVoice(f.client, -77, stopped.signal), /caller cancelled/);
  assert.equal(f.calls.length, 0);
  const failed = new OneBotApiError('send_group_ai_record', 100);
  const rejected = fixture(failed);
  await assert.rejects(sendAiVoice(rejected.client, '123456', 'hello', 'voice-1'), error => error === failed);
  assert.equal(rejected.calls.length, 1);
});
