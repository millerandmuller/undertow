import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatSender } from '../src/chat/send.ts';
import type { Helix } from '../src/util/helix.ts';

function senderFor(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
  now: () => number = () => 10_000,
  log: (entry: unknown) => void = () => undefined,
): ChatSender {
  const helix = { request } as Helix;
  return new ChatSender(helix, 'streamer-id', { now, log });
}

test('chat sender includes reply parent id and both broadcaster ids', async () => {
  let path = '';
  let body: Record<string, unknown> = {};
  const sender = senderFor(async (requestPath, init) => {
    path = requestPath;
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return { data: [{ is_sent: true, drop_reason: null }] };
  });
  assert.equal(await sender.send('Thanks for the message.', 'parent-123'), true);
  assert.equal(path, 'chat/messages');
  assert.equal(body.broadcaster_id, 'streamer-id');
  assert.equal(body.sender_id, 'streamer-id');
  assert.equal(body.reply_parent_message_id, 'parent-123');
});

test('chat sender logs a rejected message once without retrying', async () => {
  let requests = 0;
  const logs: unknown[] = [];
  const sender = senderFor(async () => {
    requests++;
    return { data: [{ is_sent: false, drop_reason: 'automod' }] };
  }, () => 10_000, (entry) => logs.push(entry));
  assert.equal(await sender.send('A clear note.'), false);
  assert.equal(requests, 1);
  assert.equal(logs.length, 1);
});

test('chat sender rejects over-long messages before a request', async () => {
  let requests = 0;
  const sender = senderFor(async () => {
    requests++;
    return { data: [{ is_sent: true, drop_reason: null }] };
  });
  await assert.rejects(sender.send('x'.repeat(501)), /500 characters/);
  assert.equal(requests, 0);
});

test('chat sender limits outbound messages to one per three seconds', async () => {
  let nowMs = 10_000;
  let requests = 0;
  const logs: unknown[] = [];
  const sender = senderFor(async () => {
    requests++;
    return { data: [{ is_sent: true, drop_reason: null }] };
  }, () => nowMs, (entry) => logs.push(entry));
  assert.equal(await sender.send('First.'), true);
  assert.equal(await sender.send('Too soon.'), false);
  nowMs += 3000;
  assert.equal(await sender.send('Next.'), true);
  assert.equal(requests, 2);
  assert.equal(logs.length, 1);
});
