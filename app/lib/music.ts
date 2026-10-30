/**
 * 战役遭遇里 DM 共享音乐：DM 在浏览器里选一个标签页（或整个屏幕）连声音一起共享，
 * 声音经 WebRTC 直接发给每个玩家（点对点，不经服务器），服务器只转握手消息（/encounters/:id/rtc）。
 *
 * 握手（都走服务器转发；to 空 = 发给其他所有人）：
 *   玩家进来 → 所有人：who        DM 开始共享 → 所有人：hello
 *   DM → 玩家：hello（回 who）     玩家 → DM：want
 *   DM → 玩家：offer               玩家 → DM：answer          双方：ice
 *   DM 停止 → 所有人：bye
 */
import { useSyncExternalStore } from 'react';
import { api } from './api';

export interface MusicUi {
  /** 我在共享：几个人连上了 */
  hosting: boolean;
  listeners: number;
  /** 我在听：谁在放、要不要点一下才能出声（浏览器不让网页自己出声） */
  from: string | null;
  playing: boolean;
  blocked: boolean;
  volume: number;
  muted: boolean;
  error: string | null;
}

interface Signal { from: string; fromName: string; fromRole: 'dm' | 'player'; data: { t: string; sdp?: string; ice?: RTCIceCandidateInit } }

// 几家公共 STUN（谷歌的在国内可能连不上，多放几个）
const ICE: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
  { urls: 'stun:stun.miwifi.com:3478' },
];

const VOL_KEY = 'dnd.music.volume';
const loadVol = (): number => { try { const v = Number(localStorage.getItem(VOL_KEY)); return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 0.6; } catch { return 0.6; } };

let ui: MusicUi = { hosting: false, listeners: 0, from: null, playing: false, blocked: false, volume: loadVol(), muted: false, error: null };
const subs = new Set<() => void>();
const set = (p: Partial<MusicUi>) => { ui = { ...ui, ...p }; for (const l of subs) l(); };

let enc: string | null = null;
let me: string | null = null;
/** DM：共享出去的声音 + 每个玩家一条连接 */
let local: MediaStream | null = null;
const out = new Map<string, Pc>();
/** 玩家：连着 DM 的那条 */
let inbound: { host: string; pc: Pc } | null = null;
let audio: HTMLAudioElement | null = null;

/** 一条连接 + 对方描述还没到时先攒着的 ICE 候选 */
interface Pc { pc: RTCPeerConnection; queue: RTCIceCandidateInit[] }

function send(data: Record<string, unknown>, to?: string): void {
  if (!enc || !me) return;
  api('POST', `encounters/${enc}/rtc`, { from: me, ...(to ? { to } : {}), data }).catch(() => { /* 握手丢一条：对方会超时重来 */ });
}

/** Opus 开立体声、码率拉高（默认是单声道语音档） */
function hifi(sdp: string): string {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (_m, p: string) =>
    `a=fmtp:${pt} ${p.split(';').filter((x) => !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)=/.test(x.trim())).join(';')};stereo=1;sprop-stereo=1;maxaveragebitrate=256000;usedtx=0`);
}

function makePc(peer: string, onState: () => void): Pc {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const x: Pc = { pc, queue: [] };
  pc.onicecandidate = (ev) => { if (ev.candidate) send({ t: 'ice', ice: ev.candidate.toJSON() }, peer); };
  pc.onconnectionstatechange = onState;
  return x;
}
async function flush(x: Pc): Promise<void> {
  for (const c of x.queue.splice(0)) await x.pc.addIceCandidate(c).catch(() => {});
}

function countListeners(): void {
  set({ listeners: [...out.values()].filter((x) => x.pc.connectionState === 'connected').length });
}

/* ───── DM：共享 ───── */

async function offerTo(peer: string): Promise<void> {
  if (!local) return;
  out.get(peer)?.pc.close();
  const x = makePc(peer, () => {
    const st = x.pc.connectionState;
    if (st === 'failed' || st === 'closed') { x.pc.close(); if (out.get(peer) === x) out.delete(peer); }
    countListeners();
  });
  out.set(peer, x);
  for (const t of local.getAudioTracks()) {
    const sender = x.pc.addTrack(t, local);
    const p = sender.getParameters();
    p.encodings = (p.encodings?.length ? p.encodings : [{}]).map((e) => ({ ...e, maxBitrate: 256_000 }));
    sender.setParameters(p).catch(() => {});
  }
  const offer = await x.pc.createOffer();
  offer.sdp = hifi(offer.sdp ?? '');
  await x.pc.setLocalDescription(offer);
  send({ t: 'offer', sdp: offer.sdp }, peer);
}

/* ───── 玩家：收听 ───── */

function stopListening(): void {
  inbound?.pc.pc.close();
  inbound = null;
  if (audio) { audio.pause(); audio.srcObject = null; }
  set({ from: null, playing: false, blocked: false });
}

async function play(): Promise<void> {
  if (!audio) return;
  try { await audio.play(); set({ playing: true, blocked: false }); } catch { set({ blocked: true }); }
}

async function onOffer(s: Signal): Promise<void> {
  inbound?.pc.pc.close();
  const x = makePc(s.from, () => {
    const st = x.pc.connectionState;
    if ((st === 'failed' || st === 'closed') && inbound?.pc === x) {
      stopListening();
      if (st === 'failed') set({ error: '和 DM 的音乐连接断了（网络打不通的话可能要服务器中转）' });
    }
  });
  inbound = { host: s.from, pc: x };
  set({ from: s.fromName, error: null });
  x.pc.ontrack = (ev) => {
    if (!audio) { audio = new Audio(); audio.autoplay = true; }
    audio.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
    audio.volume = ui.volume;
    audio.muted = ui.muted;
    void play();
  };
  await x.pc.setRemoteDescription({ type: 'offer', sdp: s.data.sdp ?? '' });
  await flush(x);
  const ans = await x.pc.createAnswer();
  ans.sdp = hifi(ans.sdp ?? '');
  await x.pc.setLocalDescription(ans);
  send({ t: 'answer', sdp: ans.sdp }, s.from);
}

/* ───── 对外 ───── */

export const music = {
  /** 进战役遭遇时（连上推送之后）：编号、角色 */
  attach(encounterId: string, peer: string): void {
    if (enc !== encounterId) music.detach();
    enc = encounterId;
    me = peer;
    // 问一声：有人在放吗（DM 会回 hello）
    if (!inbound) send({ t: 'who' });
  },
  detach(): void {
    if (ui.hosting) music.stop();
    stopListening();
    enc = null;
    me = null;
  },
  /** 推送里来的握手消息 */
  onSignal(s: Signal): void {
    const t = s.data.t;
    if (t === 'who') { if (local) { const x = out.get(s.from); if (!x || x.pc.connectionState !== 'connected') send({ t: 'hello' }, s.from); } return; }
    if (t === 'hello') { if (!local && (!inbound || inbound.host !== s.from || inbound.pc.pc.connectionState !== 'connected')) send({ t: 'want' }, s.from); return; }
    if (t === 'want') { if (local) void offerTo(s.from).catch((e) => set({ error: `连不上 ${s.fromName}：${(e as Error).message}` })); return; }
    if (t === 'offer') { if (!local) void onOffer(s).catch((e) => set({ error: '接收音乐失败：' + (e as Error).message })); return; }
    if (t === 'answer') {
      const x = out.get(s.from);
      if (x) void x.pc.setRemoteDescription({ type: 'answer', sdp: s.data.sdp ?? '' }).then(() => flush(x)).catch(() => {});
      return;
    }
    if (t === 'ice' && s.data.ice) {
      const x = out.get(s.from) ?? (inbound?.host === s.from ? inbound.pc : null);
      if (!x) return;
      if (x.pc.remoteDescription) void x.pc.addIceCandidate(s.data.ice).catch(() => {});
      else x.queue.push(s.data.ice);
      return;
    }
    if (t === 'bye' && inbound?.host === s.from) stopListening();
  },
  /** DM：选一个标签页 / 屏幕，连声音一起共享 */
  async start(): Promise<void> {
    if (local) return;
    set({ error: null });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,   // Chrome 要求带画面；拿到后马上关掉，只留声音
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        // 非标准但 Chrome / Edge 认：默认不列本页、允许系统声音
        ...({ selfBrowserSurface: 'exclude', systemAudio: 'include', preferCurrentTab: false } as Record<string, unknown>),
      });
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') set({ error: '没能开始共享：' + (e as Error).message });
      return;
    }
    for (const t of stream.getVideoTracks()) { t.stop(); stream.removeTrack(t); }
    const tracks = stream.getAudioTracks();
    if (!tracks.length) { set({ error: '没有声音：选标签页时要勾上「同时共享标签页音频」（整个屏幕要勾「共享系统音频」）' }); return; }
    for (const t of tracks) { t.contentHint = 'music'; t.onended = () => music.stop(); }
    local = stream;
    stopListening();
    set({ hosting: true, listeners: 0 });
    send({ t: 'hello' });
  },
  stop(): void {
    for (const x of out.values()) x.pc.close();
    out.clear();
    for (const t of local?.getTracks() ?? []) t.stop();
    local = null;
    send({ t: 'bye' });
    set({ hosting: false, listeners: 0 });
  },
  /** 玩家：浏览器挡住了自动播放，点一下 */
  resume(): void { void play(); },
  setVolume(v: number): void {
    const volume = Math.max(0, Math.min(1, v));
    if (audio) audio.volume = volume;
    try { localStorage.setItem(VOL_KEY, String(volume)); } catch { /* 无痕模式之类 */ }
    set({ volume });
  },
  setMuted(muted: boolean): void {
    if (audio) audio.muted = muted;
    set({ muted });
  },
  clearError(): void { set({ error: null }); },
};

export function useMusic(): MusicUi {
  return useSyncExternalStore((l) => { subs.add(l); return () => subs.delete(l); }, () => ui);
}

// 关页面：告诉玩家别等了
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { if (local) music.stop(); });
