const { encodeAudioBufferToWav } = require('../../frontend/audio-utils');

function ascii(view, offset, length) {
  return Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join('');
}

test('encodeAudioBufferToWav 将多声道音频编码为单声道 PCM WAV', () => {
  const channels = [
    Float32Array.from([1, -1, 0.5]),
    Float32Array.from([1, -1, -0.5]),
  ];
  const wav = encodeAudioBufferToWav({
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate: 48000,
    getChannelData: channel => channels[channel],
  });
  const view = new DataView(wav);

  expect(ascii(view, 0, 4)).toBe('RIFF');
  expect(ascii(view, 8, 4)).toBe('WAVE');
  expect(ascii(view, 36, 4)).toBe('data');
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(48000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(6);
  expect(view.getInt16(44, true)).toBe(32767);
  expect(view.getInt16(46, true)).toBe(-32768);
  expect(view.getInt16(48, true)).toBe(0);
});
