import { describe, expect, it } from 'vitest';
import {
  MAX_CLIENT_MESSAGE_BYTES,
  isValidRoomId,
  parseClientMessage,
} from '../../shared/protocol.ts';

const TOKEN = 'A'.repeat(43);

describe('parseClientMessage', () => {
  it('accepts every well-formed message type', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'hello', token: TOKEN, protocol: 1 }))).toEqual({
      type: 'hello',
      token: TOKEN,
      protocol: 1,
    });
    expect(parseClientMessage(JSON.stringify({ type: 'hello', token: TOKEN, protocol: 1, sit: false }))).toEqual({
      type: 'hello',
      token: TOKEN,
      protocol: 1,
      sit: false,
    });
    expect(parseClientMessage('{"type":"move","from":"e2","to":"e4","expectedPly":0}')).toEqual({
      type: 'move',
      from: 'e2',
      to: 'e4',
      expectedPly: 0,
    });
    expect(parseClientMessage('{"type":"move","from":"e7","to":"e8","promotion":"q","expectedPly":9}')).toMatchObject({
      promotion: 'q',
    });
    expect(parseClientMessage('{"type":"resign","game":1}')).toEqual({ type: 'resign', game: 1 });
    expect(parseClientMessage('{"type":"draw","action":"offer","game":2}')).toEqual({
      type: 'draw',
      action: 'offer',
      game: 2,
    });
    expect(parseClientMessage('{"type":"rematch","want":true,"game":1}')).toEqual({
      type: 'rematch',
      want: true,
      game: 1,
    });
    expect(parseClientMessage('{"type":"sit"}')).toEqual({ type: 'sit' });
    expect(parseClientMessage('{"type":"sit","color":"b"}')).toEqual({ type: 'sit', color: 'b' });
    expect(parseClientMessage('{"type":"leave"}')).toEqual({ type: 'leave' });
  });

  it.each([
    ['not json', 'hello'],
    ['array', '[]'],
    ['null', 'null'],
    ['unknown type', '{"type":"teleport"}'],
    ['bad square', '{"type":"move","from":"e9","to":"e4","expectedPly":0}'],
    ['square injection', '{"type":"move","from":"e2;DROP","to":"e4","expectedPly":0}'],
    ['bad promotion', '{"type":"move","from":"e7","to":"e8","promotion":"k","expectedPly":0}'],
    ['negative ply', '{"type":"move","from":"e2","to":"e4","expectedPly":-1}'],
    ['fractional ply', '{"type":"move","from":"e2","to":"e4","expectedPly":0.5}'],
    ['string ply', '{"type":"move","from":"e2","to":"e4","expectedPly":"0"}'],
    ['extra keys', '{"type":"move","from":"e2","to":"e4","expectedPly":0,"color":"w"}'],
    ['short token', '{"type":"hello","token":"abc","protocol":1}'],
    ['token with bad chars', `{"type":"hello","token":"${'+'.repeat(43)}","protocol":1}`],
    ['bad draw action', '{"type":"draw","action":"force","game":1}'],
    ['bad rematch flag', '{"type":"rematch","want":"yes","game":1}'],
    ['bad seat colour', '{"type":"sit","color":"red"}'],
    ['non-boolean sit flag', `{"type":"hello","token":"${'A'.repeat(43)}","protocol":1,"sit":"no"}`],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('rejects oversized messages before parsing', () => {
    const huge = JSON.stringify({ type: 'leave', padding: 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES) });
    expect(parseClientMessage(huge)).toBeNull();
  });
});

describe('isValidRoomId', () => {
  it('accepts generated IDs and the world room', () => {
    expect(isValidRoomId('aB3dE5gH9k')).toBe(true);
    expect(isValidRoomId('world')).toBe(true);
  });

  it.each(['', 'short', 'aB3dE5gH9k1', '../../etc', 'aB3dE5gH9!', 'WORLD'])('rejects %j', (id) => {
    expect(isValidRoomId(id)).toBe(false);
  });
});
