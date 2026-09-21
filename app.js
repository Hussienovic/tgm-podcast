/* =====================================================
   TGM Podcast - core app
   Mesh voice/video/screen-share over WebRTC via PeerJS.
   Host = whoever creates the room code. Others join with it.
   ===================================================== */
(() => {
  const CFG = window.TGM_CONFIG;
  const $ = (id) => document.getElementById(id);

  // ---------- state ----------
  const S = {
    peer: null,            // PeerJS instance
    myId: null,
    name: "",
    isHost: false,
    roomCode: "",
    hostPeerId: "",
    localStream: null,     // mic (+ camera video track when on)
    screenStream: null,
    micOn: true,
    camOn: false,
    sharing: false,
    peers: new Map(),      // peerId -> { name, call, conn, stream, screenStreamId, tile, analyser, ... }
    shareQuality: {
      height: CFG.screen.height,
      fps: CFG.screen.frameRate,
      mbps: CFG.screen.maxBitrateMbps,
      mode: CFG.screen.contentHint,
    },
    audioCtx: null,
    statsTimer: null,
    leaving: false,
    selfShareTile: null,   // local preview while sharing the screen
    camFace: "user",       // "user" (front) or "environment" (back)
    boardCtx: null,        // AudioContext for the soundboard
    profile: null,         // { name, avatarId }
    myAvatarBlob: null,    // my avatar File/Blob (stored in IndexedDB)
    myAvatarId: null,
    myAvatarType: null,
    myAvatarUrl: null,     // object URL for rendering
    avatarCache: new Map(), // avatarId -> object URL (per-session cache)
    avatarParts: new Map(), // receives: avatarId -> { parts, total, got, timer }
    avatarReqs: new Set(),  // avatarIds I have asked for
    avatarTries: new Map(), // avatarId -> request retry count
  };

  // ---------- helpers ----------
  const PEER_PREFIX = "tgmpod-";
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O/1/I
  const genCode = () =>
    "TGM-" + Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  const codeToPeerId = (code) => PEER_PREFIX + code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const rnd = () => Math.random().toString(36).slice(2, 10);
  // deviceId: stable for this tab/window.
  // A person is identified by deviceId, so reconnecting REPLACES their old tile instead of adding one.
  const DEVICE_ID = (() => {
    try {
      // sessionStorage = one id per tab/window: survives reloads and reconnects,
      // but two tabs (or two devices) are never mistaken for the same person.
      let d = sessionStorage.getItem("tgm_device");
      if (!d) { d = rnd() + rnd(); sessionStorage.setItem("tgm_device", d); }
      return d;
    } catch (e) { return rnd() + rnd(); }
  })();
  const randId = () => PEER_PREFIX + rnd();

  function toast(msg, ms = 2600) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), ms);
  }
  const showScreen = (id) => {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $(id).classList.add("active");
  };
  const setErr = (m) => ($("lobbyError").textContent = m || "");
  const setConn = (m) => ($("connState").textContent = m);

  // ---------- profile (name + avatar, edited in the lobby) ----------
  function loadProfile() {
    try { S.profile = JSON.parse(localStorage.getItem("tgm_profile") || "null"); } catch (e) { S.profile = null; }
    return S.profile;
  }
  function persistProfile() {
    const name = ($("nameInput").value || "").trim().slice(0, 20) || "Guest";
    S.profile = { name, avatarId: S.myAvatarId };
    try { localStorage.setItem("tgm_profile", JSON.stringify(S.profile)); localStorage.setItem("tgm_name", name); } catch (e) {}
    renderLobbyAvatar();
  }
  function renderLobbyAvatar() {
    const img = $("lobbyAvatarImg");
    if (S.myAvatarUrl) {
      img.src = S.myAvatarUrl; img.hidden = false;
      $("lobbyAvatarLetter").hidden = true;
      $("avatarClear").classList.remove("hidden");
    } else {
      img.hidden = true; img.removeAttribute("src");
      $("lobbyAvatarLetter").hidden = false;
      $("lobbyAvatarLetter").textContent = ($("nameInput").value || "?").charAt(0).toUpperCase();
      $("avatarClear").classList.add("hidden");
    }
  }
  function setOwnAvatar(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast("Please pick an image file.");
    if (file.size > 8 * 1024 * 1024) return toast("Image too large (max 8 MB).");
    const id = rnd() + rnd();
    S.myAvatarBlob = file;
    S.myAvatarId = id;
    S.myAvatarType = file.type || "image/*";
    S.myAvatarUrl = URL.createObjectURL(file);
    S.avatarCache.set(id, S.myAvatarUrl);
    idbSet("my_avatar", { id, type: S.myAvatarType, blob: file }).catch(() => toast("Could not store avatar on this device."));
    persistProfile();
    if (S.selfTile) applyAvatar(S.selfTile, S.myAvatarUrl);
    broadcast({ t: "hello", name: S.name, device: DEVICE_ID, avatarId: S.myAvatarId });
    // already-connected friends get the new photo immediately
    S.peers.forEach((rec, pid) => {
      if (!rec.conn || !rec.conn.open) return;
      rec.conn.pushedAvatars = rec.conn.pushedAvatars || new Set();
      if (rec.conn.pushedAvatars.has(id)) return;
      rec.conn.pushedAvatars.add(id);
      const bid = id; const b = file;
      sendAvatarTo(rec.conn, bid, S.myAvatarType || "image/*", b).catch(() => rec.conn.pushedAvatars && rec.conn.pushedAvatars.delete(bid));
    });
    toast("Avatar set.");
  }
  function clearOwnAvatar() {
    S.myAvatarBlob = null; S.myAvatarId = null; S.myAvatarType = null; S.myAvatarUrl = null;
    idbDel("my_avatar").catch(() => {});
    persistProfile();
    if (S.selfTile) applyAvatar(S.selfTile, null);
    broadcast({ t: "hello", name: S.name, device: DEVICE_ID, avatarId: null });
  }

  // my avatar lives as a Blob in IndexedDB (so multi-MB animated GIFs are fine) and shows via an object URL
  async function bootProfile() {
    loadProfile();
    const p = S.profile || {};
    $("nameInput").value = p.name || localStorage.getItem("tgm_name") || "";
    try {
      const st = await idbGet("my_avatar");
      if (st && st.id && p.avatarId === st.id && st.blob) {
        S.myAvatarBlob = st.blob; S.myAvatarId = st.id; S.myAvatarType = st.type || "image/*";
        S.myAvatarUrl = URL.createObjectURL(st.blob);
        S.avatarCache.set(st.id, S.myAvatarUrl);
      } else {
        S.myAvatarId = p.avatarId || null;
      }
    } catch (e) { S.myAvatarId = p.avatarId || null; }
    // a saved avatarId with no stored blob is stale: drop it so we don't advertise a broken avatar
    if (S.myAvatarId && !S.myAvatarBlob) {
      S.myAvatarId = null;
      try { localStorage.setItem("tgm_profile", JSON.stringify({ ...p, avatarId: null })); } catch (e) {}
    }
    renderLobbyAvatar();
  }

  // ---------- avatar distribution (chunked, so big GIFs reach everyone) ----------
  const AVATAR_CHUNK = 6 * 1024; // bytes per message; base64≈8KB < PeerJS/Safari 16KB maxMessageSize, so peerjs never re-chunks it
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("tgm", 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("kv")) r.result.createObjectStore("kv"); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function idbGet(key) {
    return idb().then((db) => new Promise((res, rej) => {
      const g = db.transaction("kv", "readonly").objectStore("kv").get(key);
      g.onsuccess = () => res(g.result);
      g.onerror = () => rej(g.error);
    }));
  }
  function idbSet(key, value) {
    return idb().then((db) => new Promise((res, rej) => {
      const s = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
      s.onsuccess = () => res();
      s.onerror = () => rej(s.error);
    }));
  }
  function idbDel(key) {
    return idb().then((db) => new Promise((res, rej) => {
      const d = db.transaction("kv", "readwrite").objectStore("kv").delete(key);
      d.onsuccess = () => res();
      d.onerror = () => rej(d.error);
    }));
  }
  const readArrayBuffer = (blob) =>
    blob.arrayBuffer ? blob.arrayBuffer() : new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => res(rd.result);
      rd.onerror = () => rej(rd.error);
      rd.readAsArrayBuffer(blob);
    });
  async function sendAvatarTo(conn, id, type, blob) {
    const buf = await readArrayBuffer(blob);
    const bytes = new Uint8Array(buf);
    const total = Math.ceil(bytes.length / AVATAR_CHUNK);
    for (let i = 0; i < total; i++) {
      const part = bytes.subarray(i * AVATAR_CHUNK, Math.min(bytes.length, (i + 1) * AVATAR_CHUNK));
      let bin = "";
      for (let j = 0; j < part.length; j += 8192) bin += String.fromCharCode.apply(null, part.subarray(j, j + 8192));
      // yield every few chunks so a huge GIF never blocks the UI thread
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
      conn.send({ t: "avatar", id, part: i, total, type, d: btoa(bin) });
    }
  }
  function handleAvatarReq(peerId, m) {
    if (!m.id || m.id !== S.myAvatarId || !S.myAvatarBlob) return;
    const rec = S.peers.get(peerId);
    const liveConn = rec && rec.conn;
    // already being pushed through this live connection; the request is just a duplicate
    if (liveConn && liveConn.pushedAvatars && liveConn.pushedAvatars.has(m.id)) return;
    if (liveConn && liveConn.open) {
      const id = m.id;
      const blob = S.myAvatarBlob;
      sendAvatarTo(liveConn, id, S.myAvatarType || "image/*", blob)
        .then(() => { liveConn.pushedAvatars = liveConn.pushedAvatars || new Set(); liveConn.pushedAvatars.add(id); })
        .catch(() => {}); // retries (avatar-req) will pick it up later
    }
  }
  function onAvatarChunk(m) {
    let acc = S.avatarParts.get(m.id);
    if (!acc) {
      acc = { parts: new Array(m.total || 1), total: m.total || 1, type: m.type || "image/*", got: 0 };
      acc.timer = setTimeout(() => { S.avatarParts.delete(m.id); S.avatarReqs.delete(m.id); S.avatarTries.delete(m.id); }, 30000);
      S.avatarParts.set(m.id, acc);
    }
    if (m.part < acc.total && acc.parts[m.part] === undefined) { acc.parts[m.part] = m.d; acc.got++; }
    if (acc.got === acc.total) {
      clearTimeout(acc.timer);
      S.avatarParts.delete(m.id);
      try {
        const joined = acc.parts.join("");
        const u8 = new Uint8Array(joined.length);
        for (let i = 0; i < joined.length; i++) u8[i] = joined.charCodeAt(i);
        finishAvatar(m.id, new Blob([u8], { type: acc.type }));
      } catch (e) { S.avatarReqs.delete(m.id); }
    }
  }
  function finishAvatar(id, blob) {
    S.avatarTries.delete(id);
    const url = URL.createObjectURL(blob);
    S.avatarCache.set(id, url);
    if (S.myAvatarId === id) { S.myAvatarUrl = url; applyAvatar(S.selfTile, url); }
    for (const [pid, r] of S.peers) if (r.avatarId === id) applyAvatar(r.tile, url);
  }
  // ask for / apply an avatar by id, with a per-session cache so nobody re-downloads it.
  // Retries a few times in case a request or a chunk is lost along the way.
  function ensureAvatarFor(peerId, id) {
    const rec = S.peers.get(peerId);
    if (!rec) return;
    rec.avatarId = id || null;
    if (!id) { applyAvatar(rec.tile, null); return; }
    if (S.avatarCache.has(id)) { applyAvatar(rec.tile, S.avatarCache.get(id)); return; }
    applyAvatar(rec.tile, null);
    if (!S.avatarReqs.has(id)) {
      S.avatarReqs.add(id);
      askAvatar(id);
    } else {
      maybeAskAgain(id);
    }
  }
  function askAvatar(id) {
    for (const [pid, r] of S.peers) {
      if (r.avatarId === id && r.conn && r.conn.open) r.conn.send({ t: "avatar-req", id });
    }
    setTimeout(() => maybeAskAgain(id), 8000);
  }
  function maybeAskAgain(id) {
    if (S.avatarCache.has(id)) return;
    const tries = (S.avatarTries.get(id) || 0) + 1;
    if (tries > 4) { S.avatarReqs.delete(id); S.avatarTries.delete(id); return; }
    S.avatarTries.set(id, tries);
    askAvatar(id);
  }

  // ---------- tile avatars ----------
  function applyAvatar(tile, src) {
    if (!tile) return;
    const img = tile.querySelector(".avatar-img");
    const letter = tile.querySelector(".avatar-letter");
    if (!img || !letter) return;
    if (src) { img.src = src; img.hidden = false; letter.hidden = true; }
    else { img.hidden = true; img.removeAttribute("src"); letter.hidden = false; }
  }
  // ---------- soundboard ----------
  const SOUNDS = [
    { k: "airhorn", label: "Airhorn", art: "📯" },
    { k: "boom", label: "Boom", art: "💥" },
    { k: "ding", label: "Ding", art: "🔔" },
    { k: "laser", label: "Laser", art: "⚡" },
    { k: "clap", label: "Clap", art: "👏" },
    { k: "riser", label: "Riser", art: "🐉" },
    { k: "whoosh", label: "Whoosh", art: "🌬️" },
    { k: "tada", label: "Ta-da", art: "🎉" },
  ];
  const SOUND_GAIN = { airhorn: .55, boom: .9, ding: .7, laser: .6, clap: .6, riser: .5, whoosh: .6, tada: .7 };
  const SOUND_GEN = {
    // multi-tone horn with vibrato
    airhorn(buf, sr) { for (let i = 0; i < buf.length; i++) { const t = i / sr; const env = Math.min(1, t * 8) * Math.exp(-t * 2.6); const vib = 1 + .02 * Math.sin(Math.PI * 2 * 9 * t);
      let v = 0; for (const f of [150, 187, 225, 300]) { const p = Math.PI * 2 * f * vib * t; v += Math.sin(p) + .35 * Math.sin(2 * p) + .15 * Math.sin(3 * p); } buf[i] = (v / 4) * env; } },
    // sub drop
    boom(buf, sr) { let ph = 0, f = 130; for (let i = 0; i < buf.length; i++) { const t = i / sr; f = 40 + 90 * Math.exp(-t * 6); ph += (Math.PI * 2 * f) / sr; buf[i] = Math.sin(ph) * Math.exp(-t * 3.2) + .25 * Math.sin(ph * 2) * Math.exp(-t * 6); } },
    // bell ping
    ding(buf, sr) { let ph = 0, f = 880; for (let i = 0; i < buf.length; i++) { const t = i / sr; f = 900 + 380 * Math.exp(-t * 4); ph += (Math.PI * 2 * f) / sr; const env = Math.min(1, t * 40) * Math.exp(-t * 2.4); buf[i] = (Math.sin(ph) * .6 + Math.sin(ph * 2) * .18) * env; } },
    // quick pitch sweep
    laser(buf, sr) { let ph = 0; for (let i = 0; i < buf.length; i++) { const t = i / sr; const f = 200 * Math.pow(2, Math.min(t * 3, 3)); ph += (Math.PI * 2 * f) / sr; buf[i] = Math.sin(ph) * Math.exp(-t * 7); } },
    // noise burst
    clap(buf, sr) { for (let i = 0; i < buf.length; i++) { const t = i / sr; const env = Math.exp(-t * 22); buf[i] = (Math.random() * 2 - 1) * env; } },
    // tension sweep up
    riser(buf, sr) { let ph = 0; for (let i = 0; i < buf.length; i++) { const t = i / sr; const f = 110 * Math.pow(2, Math.min(t * 2.6, 3.5)); ph += (Math.PI * 2 * f) / sr; buf[i] = (Math.sin(ph) * .7 + (Math.random() * 2 - 1) * .25 * (t / buf.length)) * Math.pow(t / (buf.length / sr), 1.5); } },
    // filtered noise sweep with a sine whistle on top
    whoosh(buf, sr) { let lp = 0; for (let i = 0; i < buf.length; i++) { const t = i / sr; const d = buf.length / sr; const env = Math.sin(Math.PI * Math.min(t / d, 1)) ** 2; lp = (.88 * lp + .12 * (Math.random() * 2 - 1)) * .95; buf[i] = (lp * 1.6 + Math.sin(Math.PI * 2 * 300 * t) * .1) * env; } },
    // festive two-note riff
    tada(buf, sr) { const seq = [523.25, 659.25, 783.99, 1046.5]; let ph = 0, seg = 0; for (let i = 0; i < buf.length; i++) { const t = i / sr; const s = Math.min(Math.floor(t / .18), 3); if (s !== seg) { seg = s; ph = 0; } const f = seq[s]; ph += (Math.PI * 2 * f) / sr; const st = t - s * .18; const env = Math.min(1, st * 60) * Math.exp(-st * 3.4); buf[i] = (Math.sin(ph) * .55 + .15 * Math.sin(ph * 2)) * env; } },
  };
  function ensureBoardCtx() {
    if (!S.boardCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      S.boardCtx = new Ctx();
    }
    if (S.boardCtx.state === "suspended") S.boardCtx.resume();
    return S.boardCtx;
  }
  function playBoard(k) {
    const ctx = ensureBoardCtx();
    if (!ctx || !SOUND_GEN[k]) return;
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(1, Math.max(1, Math.floor(sr * (k === "airhorn" ? 1.1 : k === "boom" ? 1 : k === "riser" ? 1.3 : k === "tada" ? .85 : k === "whoosh" ? .9 : .5))), sr);
    SOUND_GEN[k](buf.getChannelData(0), sr);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = SOUND_GAIN[k] || .7;
    src.connect(g); g.connect(ctx.destination);
    src.start();
  }
  function boardKey(k) {
    playBoard(k);           // I hear it
    broadcast({ t: "sound", k }); // the room hears it too
  }

  // ---------- clean voice pipeline ----------
  // mic -> highpass (kills rumble) -> RNNoise (AI noise removal) -> noise gate -> gentle compressor -> output
  // If anything fails to load we fall back to the plain (browser-filtered) mic so the call never breaks.
  const P = { ctx: null, node: null, dest: null, rnn: null, gate: null, rawStream: null, ready: false };

  // voice mode: "clean" (AI noise removal, default) or "plain" (browser filters only, if voices ever sound clipped)
  const getVoiceMode = () => { try { return localStorage.getItem("tgm_voice") || "clean"; } catch (e) { return "clean"; } };

  async function buildCleanStream(rawStream) {
    try {
      if (getVoiceMode() === "plain") throw new Error("plain voice selected");
      if (!window.TGMDenoise || !window.AudioWorkletNode) throw new Error("denoise not available");
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: "interactive" });
      await ctx.audioWorklet.addModule("audio/rnnoise-worklet.js");
      await ctx.audioWorklet.addModule("audio/noisegate-worklet.js");
      const wasm = await window.TGMDenoise.loadRnnoise({ url: "audio/rnnoise.wasm", simdUrl: "audio/rnnoise_simd.wasm" });

      const src = ctx.createMediaStreamSource(rawStream);

      const hp = ctx.createBiquadFilter();               // remove low rumble / desk thumps / AC hum
      hp.type = "highpass"; hp.frequency.value = 90; hp.Q.value = 0.7;

      const rnn = new window.TGMDenoise.RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: wasm });

      const gate = new window.TGMDenoise.NoiseGateWorkletNode(ctx, {
        openThreshold: -60, closeThreshold: -68, holdMs: 400, maxChannels: 1,   // dB; very gentle: only cuts true silence, never soft speech
      });

      const comp = ctx.createDynamicsCompressor();       // even out loud/quiet speech
      comp.threshold.value = -24; comp.knee.value = 24; comp.ratio.value = 3;
      comp.attack.value = 0.005; comp.release.value = 0.2;

      const dest = ctx.createMediaStreamDestination();
      src.connect(hp); hp.connect(rnn); rnn.connect(gate); gate.connect(comp); comp.connect(dest);

      if (ctx.state === "suspended") await ctx.resume();
      Object.assign(P, { ctx, dest, rnn, gate, rawStream, ready: true });
      return dest.stream;
    } catch (e) {
      console.warn("Clean-voice pipeline unavailable, using plain mic:", e);
      P.ready = false;
      return null;
    }
  }

  function teardownCleanStream() {
    try { P.rnn && P.rnn.destroy(); } catch (e) {}
    try { P.rawStream && P.rawStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { P.ctx && P.ctx.close(); } catch (e) {}
    Object.assign(P, { ctx: null, node: null, dest: null, rnn: null, gate: null, rawStream: null, ready: false });
  }

  // ---------- media ----------
  async function getMic() {
    const a = CFG.audio;
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: a.echoCancellation,
        noiseSuppression: a.noiseSuppression,
        autoGainControl: a.autoGainControl,
        channelCount: a.channelCount,
        sampleRate: a.sampleRate,
      },
      video: false,
    });
  }

  // Tune Opus in SDP: FEC on, mono, target bitrate, DTX off (cleaner voice)
  function tuneOpus(sdp) {
    const br = CFG.audio.opusMaxBitrate;
    return sdp.replace(/a=fmtp:111 (.*)/g, (m, params) => {
      const kv = {};
      params.split(";").forEach((p) => {
        const [k, v] = p.split("=");
        if (k) kv[k.trim()] = v;
      });
      kv.useinbandfec = "1";
      kv.usedtx = "0";
      kv.stereo = "0";
      kv.maxaveragebitrate = String(br);
      kv.maxplaybackrate = "48000";
      return "a=fmtp:111 " + Object.entries(kv).map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(";");
    });
  }

  // Reorder the video codec list inside the SDP so VP9 (then AV1, H264, VP8) is
  // negotiated first. Must run BEFORE the offer/answer is sent to have any effect.
  function preferVideoCodecsSdp(sdp) {
    const lines = sdp.split("\r\n");
    const mIdx = lines.findIndex((l) => l.startsWith("m=video"));
    if (mIdx < 0) return sdp;
    // map payload type -> codec name, and note RTX payloads that belong to a codec
    const name = {}; const rtxFor = {};
    lines.forEach((l) => {
      let m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
      if (m) name[m[1]] = m[2].toUpperCase();
      m = l.match(/^a=fmtp:(\d+) apt=(\d+)/);
      if (m) rtxFor[m[1]] = m[2];
    });
    const rank = (pt) => {
      const base = rtxFor[pt] ? name[rtxFor[pt]] : name[pt];
      return { VP9: 0, AV1: 1, H264: 2, VP8: 3 }[base] ?? 4;
    };
    const parts = lines[mIdx].split(" ");
    const head = parts.slice(0, 3), pts = parts.slice(3);
    // stable sort keeps each codec next to its RTX partner
    const sorted = pts
      .map((pt, i) => ({ pt, i, r: rank(pt) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.pt);
    lines[mIdx] = head.concat(sorted).join(" ");
    return lines.join("\r\n");
  }
  const tuneSdp = (sdp) => preferVideoCodecsSdp(tuneOpus(sdp));

  // Prefer VP9 (then AV1, then VP8) for video: same quality, less bandwidth
  function preferCodecs(pc) {
    try {
      if (!RTCRtpSender.getCapabilities) return;
      const caps = RTCRtpSender.getCapabilities("video");
      if (!caps) return;
      const rank = (c) => {
        const m = c.mimeType.toLowerCase();
        if (m.includes("vp9")) return 0;
        if (m.includes("av1")) return 1;
        if (m.includes("h264")) return 2;
        if (m.includes("vp8")) return 3;
        return 4;
      };
      const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
      pc.getTransceivers().forEach((t) => {
        if (t.sender && t.sender.track && t.sender.track.kind === "video" && t.setCodecPreferences) {
          t.setCodecPreferences(sorted);
        }
      });
    } catch (e) { /* not fatal */ }
  }

  // Apply bitrate / framerate priorities to a video sender
  async function tuneSender(sender, { maxBitrate, maxFramerate, mode }) {
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = maxBitrate;
      if (maxFramerate) p.encodings[0].maxFramerate = maxFramerate;
      p.encodings[0].networkPriority = "high";
      p.encodings[0].priority = "high";
      p.degradationPreference = mode === "detail" ? "maintain-resolution" : "maintain-framerate";
      await sender.setParameters(p);
    } catch (e) { console.warn("tuneSender", e); }
  }

  // Keep voice prioritized over video
  async function tuneAudioSender(sender) {
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = CFG.audio.opusMaxBitrate;
      p.encodings[0].networkPriority = "high";
      p.encodings[0].priority = "high";
      await sender.setParameters(p);
    } catch (e) { /* not fatal */ }
  }

  // ---------- room: create / join ----------
  // ICE servers = the ones in config.js, plus an optional per-device TURN saved from the app (for quick testing)
  function getIceServers() {
    const list = [...CFG.iceServers];
    try {
      const saved = JSON.parse(localStorage.getItem("tgm_turn") || "null");
      if (saved && saved.urls && saved.username && saved.credential) list.push(saved);
    } catch (e) {}
    return list;
  }
  const hasTurn = () => getIceServers().some((s) => [].concat(s.urls).some((u) => /^turns?:/i.test(u)));

  function makePeer(id) {
    const opts = { config: { iceServers: getIceServers(), sdpSemantics: "unified-plan", iceCandidatePoolSize: 4 }, debug: 1 };
    if (CFG.peerServer && CFG.peerServer.host) Object.assign(opts, CFG.peerServer);
    return new Peer(id, opts);
  }

  async function startLocalMedia() {
    let raw;
    try {
      raw = await getMic();
    } catch (e) {
      throw new Error("Microphone blocked. Allow mic access in your browser or phone settings, then try again.");
    }
    const clean = await buildCleanStream(raw);
    // What we send to friends is the CLEANED track when available, otherwise the plain mic.
    S.localStream = clean || raw;
    S.cleanActive = !!clean;
  }

  async function hostRoom() {
    setErr("");
    S.name = ($("nameInput").value || "").trim() || (S.profile && S.profile.name) || "Host";
    localStorage.setItem("tgm_name", S.name);
    try { await startLocalMedia(); } catch (e) { return setErr(e.message); }

    // Try a few codes in case one is already taken
    for (let i = 0; i < 6; i++) {
      const code = genCode();
      const ok = await tryOpenPeer(codeToPeerId(code));
      if (ok) {
        S.isHost = true;
        S.roomCode = code;
        S.hostPeerId = codeToPeerId(code);
        enterRoom();
        return;
      }
    }
    setErr("Could not create a room. Check your internet and try again.");
  }

  function tryOpenPeer(id) {
    return new Promise((resolve) => {
      const p = makePeer(id);
      const timer = setTimeout(() => { try { p.destroy(); } catch (e) {} resolve(false); }, 8000);
      p.on("open", () => { clearTimeout(timer); S.peer = p; S.myId = id; wirePeer(p); resolve(true); });
      p.on("error", (err) => {
        clearTimeout(timer);
        if (err.type === "unavailable-id") { try { p.destroy(); } catch (e) {} resolve(false); }
        else { try { p.destroy(); } catch (e) {} resolve(false); }
      });
    });
  }

  async function joinRoom() {
    setErr("");
    S.name = ($("nameInput").value || "").trim() || (S.profile && S.profile.name) || "Friend";
    localStorage.setItem("tgm_name", S.name);
    let code = ($("codeInput").value || "").trim().toUpperCase();
    if (!/^TGM-?[A-Z0-9]{4}$/.test(code)) return setErr("That code doesn't look right. It should look like TGM-4K9X.");
    if (!code.includes("-")) code = "TGM-" + code.slice(3);
    try { await startLocalMedia(); } catch (e) { return setErr(e.message); }

    const myId = randId();
    const p = makePeer(myId);
    let opened = false;
    const timer = setTimeout(() => {
      if (!opened) { setErr("Could not reach the signaling service. Check your internet."); try { p.destroy(); } catch (e) {} }
    }, 10000);

    p.on("open", () => {
      opened = true; clearTimeout(timer);
      S.peer = p; S.myId = myId; S.roomCode = code; S.hostPeerId = codeToPeerId(code);
      wirePeer(p);
      // connect data channel to host first
      const conn = p.connect(S.hostPeerId, { reliable: true, metadata: { name: S.name } });
      let connected = false;
      const ct = setTimeout(() => {
        if (!connected) { setErr("Room not found. Check the code, or ask the host if the room is still open."); cleanupPeer(); }
      }, 9000);
      conn.on("open", () => {
        connected = true; clearTimeout(ct);
        enterRoom();
        registerConn(conn, S.hostPeerId, null);
        conn.send({ t: "hello", name: S.name, device: DEVICE_ID, avatarId: S.myAvatarId });
      });
      conn.on("error", () => setErr("Could not connect to the room."));
    });
    p.on("error", (err) => {
      if (!opened) { clearTimeout(timer); setErr("Connection problem: " + err.type); }
    });
  }

  function cleanupPeer() {
    try { S.peer && S.peer.destroy(); } catch (e) {}
    S.peer = null;
    if (S.localStream) { S.localStream.getTracks().forEach((t) => t.stop()); S.localStream = null; }
  }

  // ---------- peer wiring ----------
  function wirePeer(p) {
    // Incoming data connection (someone joined me, or a mesh member connecting)
    p.on("connection", (conn) => {
      if (S.peers.size >= CFG.maxPeople - 1 && !S.peers.has(conn.peer)) {
        conn.on("open", () => { conn.send({ t: "full" }); setTimeout(() => conn.close(), 300); });
        return;
      }
      conn.on("open", () => registerConn(conn, conn.peer, conn.metadata && conn.metadata.name));
    });

    // Incoming media call
    p.on("call", (call) => {
      const isScreen = call.metadata && call.metadata.kind === "screen";
      if (isScreen) {
        // receive-only: never send my mic back on the screen-share link
        call.answer(undefined, { sdpTransform: tuneSdp });
        const peerId = call.peer;
        const rec = S.peers.get(peerId) || {};
        rec.screenIn = call;
        S.peers.set(peerId, rec);
        call.on("stream", (stream) => showShareTile(peerId, stream));
        call.on("close", () => removeShareTile(peerId));
        call.on("error", () => {});
        return;
      }
      call.answer(S.localStream || undefined, { sdpTransform: tuneSdp });
      wireCall(call);
    });

    // Signaling link lost: reconnect it so new joins/reconnects still work
    p.on("disconnected", () => {
      if (S.leaving) return;
      setConn("reconnecting…");
      const retry = () => {
        if (S.leaving || !S.peer || S.peer.destroyed) return;
        if (S.peer.disconnected) { try { S.peer.reconnect(); } catch (e) {} setTimeout(retry, 3000); }
        else setConn("live");
      };
      setTimeout(retry, 1500);
    });
    p.on("open", () => setConn("live"));
    p.on("error", (err) => {
      if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) setConn("network problem, retrying…");
      else if (err.type === "peer-unavailable") { /* a mesh member left; handled by close events */ }
    });
  }

  function enterRoom() {
    showScreen("room");
    $("roomCodeText").textContent = S.roomCode;
    setConn("live");
    addSelfTile();
    startStats();
    if (S.isHost) toast("Room ready. Share the code " + S.roomCode);
    if (!hasTurn()) setTimeout(() => toast("No relay set up: friends on strict networks may not connect. See README > TURN.", 6000), 3500);
  }

  // ---------- data channel protocol ----------
  // t: hello {name} | roster {list:[{id,name}]} | chat {text} | mute {muted} | share {on, streamId} | full
  function registerConn(conn, peerId, name) {
    let rec = S.peers.get(peerId) || {};
    // If we already had a different connection to this exact peer, drop the old one quietly.
    if (rec.conn && rec.conn !== conn) {
      rec.conn._replaced = true;
      try { rec.conn.close(); } catch (e) {}
    }
    rec.conn = conn;
    if (name) rec.name = name;
    S.peers.set(peerId, rec);

    conn.on("data", (m) => onData(peerId, m));
    conn.on("close", () => {
      // a replaced connection closing must NOT remove the person: only the live one counts
      if (conn._replaced || S.peers.get(peerId)?.conn !== conn) return;
      onPeerGone(peerId);
    });
    conn.on("error", () => {});

    // Host: tell newcomer who else is here, tell everyone else about newcomer
    if (S.isHost && S.peers.size) {
      const roster = [...S.peers.entries()]
        .filter(([id]) => id !== peerId)
        .map(([id, r]) => ({ id, name: r.name || "Friend", avatarId: r.avatarId || null }));
      conn.send({ t: "roster", list: roster });
      S.peers.forEach((r, id) => {
        if (id !== peerId && r.conn && r.conn.open) r.conn.send({ t: "newpeer", id: peerId, name: rec.name || "Friend", avatarId: rec.avatarId || null });
      });
    }
    // Call them with my mic
    if (!rec.call && shouldICall(peerId)) callPeer(peerId);
    ensureTile(peerId);
    // introduce myself (with my stable deviceId so duplicates can be detected)
    conn.send({ t: "hello", name: S.name, device: DEVICE_ID, avatarId: S.myAvatarId });
    conn.send({ t: "mute", muted: !S.micOn });
    // eagerly hand my profile photo to the other side: no request round-trip needed
    if (S.myAvatarBlob && S.myAvatarId) {
      const id = S.myAvatarId;
      const blob = S.myAvatarBlob;
      conn.pushedAvatars = conn.pushedAvatars || new Set();
      if (!conn.pushedAvatars.has(id)) {
        conn.pushedAvatars.add(id);
        sendAvatarTo(conn, id, S.myAvatarType || "image/*", blob).catch(() => conn.pushedAvatars && conn.pushedAvatars.delete(id));
      }
    }
    // LATE JOINERS: send them everything that is already live
    if (S.sharing && S.screenStream) {
      conn.send({ t: "share", on: true, streamId: S.screenStream.id });
      if (shouldICall(peerId)) callScreen(peerId);
      else conn.send({ t: "needscreen" });
    }
  }

  // Deterministic: the peer with the smaller id places the call (avoids double calls)
  const shouldICall = (otherId) => S.myId < otherId;

  function onData(peerId, m) {
    const rec = S.peers.get(peerId);
    if (!rec || !m) return;
    switch (m.t) {
      case "hello":
        rec.name = m.name;
        if (m.device) {
          rec.device = m.device;
          dropDuplicatesOf(peerId, m.device);
        }
        updateTileName(peerId);
        ensureAvatarFor(peerId, m.avatarId || null);
        break;
      case "roster":
        m.list.forEach((p) => connectToMember(p.id, p.name, p.avatarId));
        break;
      case "newpeer": {
        const nr = S.peers.get(m.id);
        if (nr) {
          if (m.name) nr.name = m.name;
          updateTileName(m.id);
          ensureAvatarFor(m.id, m.avatarId || null);
        }
        break;
      }
      case "chat":
        addChat(rec.name || "Friend", m.text, false); break;
      case "mute":
        setTileMuted(peerId, m.muted); break;
      case "share":
        rec.screenStreamId = m.on ? m.streamId : null;
        if (!m.on) removeShareTile(peerId);
        refreshLayout();
        break;
      case "needscreen":
        // the other side is the caller for media but I am the one sharing: send it to them
        if (S.sharing && S.screenStream) callScreen(peerId);
        break;
      case "recall":
        if (shouldICall(peerId)) {
          try { rec.call && rec.call.close(); } catch (e) {}
          rec.call = null; callPeer(peerId);
          if (S.sharing && S.screenStream) callScreen(peerId);
        }
        break;
      case "sound":
        playBoard(m.k); break;
      case "avatar-req":
        handleAvatarReq(peerId, m); break;
      case "avatar":
        onAvatarChunk(m); break;
      case "full":
        toast("Room is full (max " + CFG.maxPeople + ")."); leave(); break;
    }
  }

  // Same physical device showing up under a NEW peer id (reload, network switch): keep only the newest.
  function dropDuplicatesOf(newPeerId, device) {
    for (const [id, r] of [...S.peers]) {
      if (id !== newPeerId && r.device === device) {
        r.conn && (r.conn._replaced = true);
        try { r.conn && r.conn.close(); } catch (e) {}
        try { r.call && r.call.close(); } catch (e) {}
        try { r.screenCall && r.screenCall.close(); } catch (e) {}
        try { r.screenIn && r.screenIn.close(); } catch (e) {}
        r.tile && r.tile.remove();
        r.shareTile && r.shareTile.remove();
        S.peers.delete(id);
      }
    }
    refreshLayout();
  }

  function connectToMember(id, name, avatarId) {
    if (id === S.myId || S.peers.get(id)?.conn) return;
    const conn = S.peer.connect(id, { reliable: true, metadata: { name: S.name } });
    conn.on("open", () => {
      registerConn(conn, id, name);
      ensureAvatarFor(id, avatarId || null);
    });
  }

  // ---------- calls ----------
  function callPeer(peerId) {
    const rec = S.peers.get(peerId);
    if (!rec || !S.peer) return;
    const stream = S.localStream;
    const call = S.peer.call(peerId, stream, { sdpTransform: tuneSdp });
    if (call) wireCall(call);
  }

  function wireCall(call) {
    const peerId = call.peer;
    const rec = S.peers.get(peerId) || {};
    rec.call = call;
    S.peers.set(peerId, rec);

    call.on("stream", (stream) => onRemoteStream(peerId, stream));
    call.on("close", () => { /* connection closed: handled by data conn close or ICE restart */ });
    call.on("error", () => {});

    // ICE watchdog: restart on failure instead of dying
    const pc = call.peerConnection;
    if (pc) {
      pc.addEventListener("iceconnectionstatechange", () => {
        const st = pc.iceConnectionState;
        const r = S.peers.get(peerId);
        if (!r) return;
        if (st === "disconnected" || st === "failed") {
          setTileReconnecting(peerId, true);
          clearTimeout(r._restartT);
          r._restartT = setTimeout(() => iceRestart(peerId), st === "failed" ? 300 : 3000);
        } else if (st === "connected" || st === "completed") {
          clearTimeout(r._restartT);
          setTileReconnecting(peerId, false);
          applySenderTuning(pc);
          preferCodecs(pc);
        }
      });
    }
  }

  // Recover a broken link: if I'm the caller, place a fresh call
  function iceRestart(peerId) {
    const rec = S.peers.get(peerId);
    if (!rec || S.leaving) return;
    const pc = rec.call && rec.call.peerConnection;
    if (pc && (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed")) return;
    try { rec.call && rec.call.close(); } catch (e) {}
    rec.call = null;
    if (rec.conn && rec.conn.open) {
      if (shouldICall(peerId)) callPeer(peerId);
      else rec.conn.send({ t: "recall" });
    }
  }

  function applySenderTuning(pc) {
    pc.getSenders().forEach((s) => {
      if (!s.track) return;
      if (s.track.kind === "audio") tuneAudioSender(s);
      else if (s.track.kind === "video") {
        if (s.track.__isScreen) {
          tuneSender(s, { maxBitrate: S.shareQuality.mbps * 1e6, maxFramerate: S.shareQuality.fps, mode: S.shareQuality.mode });
        } else {
          tuneSender(s, { maxBitrate: CFG.camera.maxBitrate, maxFramerate: CFG.camera.frameRate, mode: "detail" });
        }
      }
    });
  }

  // ---------- remote streams -> tiles ----------
  function onRemoteStream(peerId, stream) {
    const rec = S.peers.get(peerId);
    if (!rec) return;
    rec.stream = stream;
    attachStream(peerId, stream);
    watchVideoTracks(peerId, stream);
  }

  function watchVideoTracks(peerId, stream) {
    const upd = () => {
      const tile = S.peers.get(peerId)?.tile;
      if (!tile) return;
      const hasVid = stream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
      tile.classList.toggle("has-video", hasVid);
    };
    stream.addEventListener("addtrack", upd);
    stream.addEventListener("removetrack", upd);
    stream.getVideoTracks().forEach((t) => { t.onmute = upd; t.onunmute = upd; t.onended = upd; });
    upd();
  }

  function attachStream(peerId, stream) {
    const rec = S.peers.get(peerId);
    ensureTile(peerId);
    const v = rec.tile.querySelector("video");
    v.srcObject = stream;
    v.play().catch(() => {});
    setupSpeakingDetector(peerId, stream);
  }

  // ---------- tiles ----------
  function makeTile(id, name, self, isShare) {
    const t = document.createElement("div");
    t.className = "tile";
    t.dataset.id = id;
    t.innerHTML = `
      <div class="avatar"><img class="avatar-img" alt="" hidden><span class="avatar-letter"></span></div>
      <video autoplay playsinline ${self ? "muted" : ""}></video>
      <div class="label"><span class="muted-ic">🔇</span><span class="nm"></span></div>
      <div class="peer-status">reconnecting…</div>
      ${self ? "" : '<input class="vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">'}
    `;
    t.querySelector(".nm").textContent = name + (self && !isShare ? " (you)" : "");
    t.querySelector(".avatar-letter").textContent = (name[0] || "?").toUpperCase();
    const vol = t.querySelector(".vol");
    if (vol) vol.addEventListener("input", () => { t.querySelector("video").volume = parseFloat(vol.value); });
    $("grid").appendChild(t);
    return t;
  }

  function addSelfTile() {
    if (S.selfTile) S.selfTile.remove();
    S.selfTile = makeTile("self", S.name, true);
    const v = S.selfTile.querySelector("video");
    v.srcObject = S.localStream;
    v.muted = true;
    applyAvatar(S.selfTile, S.myAvatarUrl);
    refreshSelfView();
    setupSpeakingDetector("self", S.localStream);
    refreshLayout();
  }

  function refreshSelfView() {
    const t = S.selfTile;
    if (!t) return;
    const v = t.querySelector("video");
    if (v) { v.srcObject = S.localStream; v.play().catch(() => {}); }
    t.classList.toggle("has-video", !!S.camTrack);
  }
  function updateFlipBtn() {
    const fb = $("flipBtn");
    fb.classList.toggle("on", !!S.camOn);
    fb.style.display = S.camOn ? "" : "none";
  }

  function ensureTile(peerId) {
    const rec = S.peers.get(peerId);
    if (rec.tile) return rec.tile;
    rec.tile = makeTile(peerId, rec.name || "Friend", false);
    refreshLayout();
    return rec.tile;
  }
  function updateTileName(peerId) {
    const rec = S.peers.get(peerId);
    if (!rec || !rec.tile) return;
    rec.tile.querySelector(".nm").textContent = rec.name;
    rec.tile.querySelector(".avatar-letter").textContent = (rec.name[0] || "?").toUpperCase();
    applyAvatar(rec.tile, rec.avatarId ? S.avatarCache.get(rec.avatarId) || null : null);
  }
  function setTileMuted(peerId, m) { const r = S.peers.get(peerId); r && r.tile && r.tile.classList.toggle("is-muted", !!m); }
  function setTileReconnecting(peerId, on) { const r = S.peers.get(peerId); r && r.tile && r.tile.classList.toggle("reconnecting", on); }

  function showShareTile(peerId, stream) {
    const rec = S.peers.get(peerId);
    removeShareTile(peerId);
    const t = makeTile(peerId + "-share", (rec.name || "Friend") + "'s screen", false, true);
    t.classList.add("sharing", "has-video");
    const v = t.querySelector("video");
    v.muted = false; v.srcObject = stream; v.play().catch(() => {});
    const fs = document.createElement("button");
    fs.className = "fs-btn"; fs.setAttribute("aria-label", "Fullscreen");
    fs.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    fs.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.());
    t.appendChild(fs);
    rec.shareTile = t;
    stream.getVideoTracks().forEach((tr) => (tr.onended = () => removeShareTile(peerId)));
    refreshLayout();
  }
  function removeShareTile(peerId) {
    const rec = S.peers.get(peerId);
    if (rec && rec.shareTile) { rec.shareTile.remove(); rec.shareTile = null; }
    refreshLayout();
  }

  function refreshLayout() {
    const grid = $("grid");
    const someoneSharing = S.sharing || !!grid.querySelector(".tile.sharing");
    grid.classList.toggle("has-share", someoneSharing);
    // in share mode, show a strip of mini tiles
    grid.querySelectorAll(".strip").forEach((s) => s.remove());
    if (someoneSharing) {
      const strip = document.createElement("div");
      strip.className = "strip";
      grid.querySelectorAll(".tile:not(.sharing)").forEach((t) => {
        const m = document.createElement("div");
        m.className = "mini"; m.dataset.for = t.dataset.id;
        m.textContent = t.querySelector(".nm").textContent;
        if (t.classList.contains("speaking")) m.classList.add("speaking");
        strip.appendChild(m);
      });
      grid.appendChild(strip);
    }
  }

  // ---------- speaking detection ----------
  function setupSpeakingDetector(id, stream) {
    if (!stream.getAudioTracks().length) return;
    S.audioCtx = S.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = S.audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const tile = () => (id === "self" ? S.selfTile : S.peers.get(id)?.tile);
    let last = false;
    const tick = () => {
      const t = tile();
      if (!t || !t.isConnected) return; // tile gone: stop
      an.getByteFrequencyData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
      const level = sum / buf.length;
      const speaking = level > 14 && (id !== "self" || S.micOn);
      if (speaking !== last) {
        last = speaking; t.classList.toggle("speaking", speaking);
        const mini = $("grid").querySelector(`.mini[data-for="${id}"]`);
        mini && mini.classList.toggle("speaking", speaking);
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------- controls ----------
  function toggleMic() {
    S.micOn = !S.micOn;
    S.localStream.getAudioTracks().forEach((t) => (t.enabled = S.micOn));
    $("micBtn").classList.toggle("on", S.micOn);
    $("micBtn").classList.toggle("off-warn", !S.micOn);
    S.selfTile && S.selfTile.classList.toggle("is-muted", !S.micOn);
    broadcast({ t: "mute", muted: !S.micOn });
  }

  async function acquireCam() {
    const c = CFG.camera;
    const cs = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: S.camFace,
        width: { ideal: c.width }, height: { ideal: c.height }, frameRate: { ideal: c.frameRate },
      },
    });
    const track = cs.getVideoTracks()[0];
    track.contentHint = "detail";
    if (S.camTrack) { try { S.camTrack.stop(); } catch (e) {} }
    try { S.localStream.removeTrack(S.camTrack); } catch (e) {}
    S.camTrack = track;
    S.localStream.addTrack(track);
    S.camOn = true;
    refreshSelfView();
    updateFlipBtn();
    $("camBtn").classList.toggle("on", true);
    // renegotiation happens via re-call (PeerJS has no native renegotiation)
    S.peers.forEach((rec, id) => recallPeer(id));
  }

  async function toggleCam() {
    if (!S.camOn) {
      try { await acquireCam(); } catch (e) { return toast("Camera blocked or not available."); }
    } else {
      if (S.camTrack) { try { S.camTrack.stop(); } catch (e) {} try { S.localStream.removeTrack(S.camTrack); } catch (e) {} }
      S.camTrack = null; S.camOn = false;
      refreshSelfView();
      $("camBtn").classList.toggle("on", false);
      S.peers.forEach((rec, id) => recallPeer(id));
    }
    updateFlipBtn();
  }

  async function flipCam() {
    if (!S.camOn) return;
    const prev = S.camFace;
    S.camFace = S.camFace === "user" ? "environment" : "user";
    if (S.camTrack) { try { S.camTrack.stop(); } catch (e) {} try { S.localStream.removeTrack(S.camTrack); } catch (e) {} }
    S.camTrack = null; S.camOn = false;
    refreshSelfView();
    try {
      await acquireCam();
      toast(S.camFace === "user" ? "Front camera" : "Back camera");
    } catch (e) {
      S.camFace = prev;
      toast("Could not switch camera.");
    }
    updateFlipBtn();
  }

  // Re-establish media with the current tracks (simple, reliable renegotiation)
  function recallPeer(peerId) {
    const rec = S.peers.get(peerId);
    if (!rec || !rec.conn || !rec.conn.open) return;
    if (shouldICall(peerId)) {
      try { rec.call && rec.call.close(); } catch (e) {}
      rec.call = null;
      callPeer(peerId);
      if (S.sharing && S.screenStream) callScreen(peerId);
    } else {
      rec.conn.send({ t: "recall" });
    }
  }

  // Screen share is sent as a second call (separate stream) so it never disturbs voice
  function callScreen(peerId) {
    if (!S.screenStream) return;
    const rec = S.peers.get(peerId);
    if (!rec) return;
    try { rec.screenCall && rec.screenCall.close(); } catch (e) {}
    const c = S.peer.call(peerId, S.screenStream, { metadata: { kind: "screen" }, sdpTransform: tuneSdp });
    if (!c) return;
    rec.screenCall = c;
    const pc = c.peerConnection;
    if (pc) {
      preferCodecs(pc);
      setTimeout(() => applySenderTuning(pc), 800);
      pc.addEventListener("iceconnectionstatechange", () => {
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") applySenderTuning(pc);
      });
    }
  }

  async function toggleShare() {
    if (S.sharing) return stopShare();
    const q = S.shareQuality;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          height: { ideal: q.height }, width: { ideal: Math.round(q.height * 16 / 9) },
          frameRate: { ideal: q.fps, max: q.fps },
        },
        audio: true, // system/tab audio where the browser supports it
      });
      const vt = stream.getVideoTracks()[0];
      vt.contentHint = q.mode;
      vt.__isScreen = true;
      vt.addEventListener("ended", stopShare);
      S.screenStream = stream;
      S.sharing = true;
      $("shareBtn").classList.add("on");
      showSelfShare(stream);
      broadcast({ t: "share", on: true, streamId: stream.id });
      S.peers.forEach((rec, id) => { if (rec.conn && rec.conn.open) callScreen(id); });
      toast("Sharing at " + q.height + "p" + q.fps + " (up to " + q.mbps + " Mbps per viewer)");
    } catch (e) {
      if (e && e.name !== "NotAllowedError") toast("Screen share isn't available on this device.");
    }
  }

  function stopShare() {
    if (!S.sharing) return;
    S.sharing = false;
    S.screenStream && S.screenStream.getTracks().forEach((t) => t.stop());
    S.screenStream = null;
    removeSelfShare();
    S.peers.forEach((rec) => { try { rec.screenCall && rec.screenCall.close(); } catch (e) {} rec.screenCall = null; });
    broadcast({ t: "share", on: false });
    $("shareBtn").classList.remove("on");
  }

  // Local preview so the sharer can see that they are live (pinned over the stage, not a grid tile)
  function showSelfShare(stream) {
    removeSelfShare();
    const p = document.createElement("div");
    p.className = "self-share-preview";
    p.innerHTML = `
      <video autoplay playsinline muted></video>
      <span class="ssp-label">Your screen</span>
      <button class="fs-btn" aria-label="Fullscreen"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>`;
    const v = p.querySelector("video");
    v.srcObject = stream;
    v.play().catch(() => {});
    p.querySelector(".fs-btn").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.());
    $("grid").parentElement.appendChild(p);
    S.selfShareTile = p;
    refreshLayout();
  }
  function removeSelfShare() {
    if (S.selfShareTile) { S.selfShareTile.remove(); S.selfShareTile = null; refreshLayout(); }
  }

  function broadcast(msg) {
    S.peers.forEach((rec) => { if (rec.conn && rec.conn.open) rec.conn.send(msg); });
  }

  // ---------- chat ----------
  let unread = 0;
  function addChat(name, text, mine) {
    const d = document.createElement("div");
    d.className = "msg" + (mine ? " me" : "");
    const b = document.createElement("b"); b.textContent = name;
    const s = document.createElement("span"); s.textContent = text;
    d.append(b, s);
    $("chatLog").appendChild(d);
    $("chatLog").scrollTop = 1e9;
    if (!mine && $("chatPanel").classList.contains("closed")) {
      unread++; $("chatBadge").textContent = unread; $("chatBadge").classList.remove("hidden");
    }
  }

  // ---------- stats overlay ----------
  function startStats() {
    clearInterval(S.statsTimer);
    S.statsTimer = setInterval(updateStats, 1500);
  }
  async function updateStats() {
    const panel = $("statsPanel");
    if (panel.classList.contains("hidden")) return;
    let html = "";
    for (const [id, rec] of S.peers) {
      const pcs = [rec.call, rec.screenCall].filter(Boolean).map((c) => c.peerConnection).filter(Boolean);
      let block = `<div class="row"><h4>${escapeHtml(rec.name || "Friend")}</h4>`;
      block += rec.avatarId
        ? (S.avatarCache.has(rec.avatarId) ? '<span class="good">photo ✓</span> ' : `photo… (${S.avatarTries.get(rec.avatarId) || 0}/4) `)
        : "";
      if (!pcs.length) block += "no media link yet";
      for (const pc of pcs) {
        try {
          const stats = await pc.getStats();
          let rtt = null, outV = null, inV = null, loss = null, path = "";
          stats.forEach((s) => {
            if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") rtt = s.currentRoundTripTime;
            if (s.type === "outbound-rtp" && s.kind === "video") outV = s;
            if (s.type === "inbound-rtp" && s.kind === "video") inV = s;
            if (s.type === "remote-inbound-rtp" && s.kind === "video") loss = s.fractionLost;
            if (s.type === "local-candidate" && s.candidateType === "relay") path = " (relayed)";
          });
          if (rtt != null) block += `ping: <span class="${rtt < .08 ? "good" : rtt < .2 ? "warn" : "bad"}">${Math.round(rtt * 1000)} ms</span>${path}<br>`;
          if (outV) block += `sending: ${outV.frameWidth || "?"}x${outV.frameHeight || "?"} @ ${Math.round(outV.framesPerSecond || 0)} fps` +
            (outV.qualityLimitationReason && outV.qualityLimitationReason !== "none" ? ` <span class="warn">(limited: ${outV.qualityLimitationReason})</span>` : "") + "<br>";
          if (inV) block += `receiving: ${inV.frameWidth || "?"}x${inV.frameHeight || "?"} @ ${Math.round(inV.framesPerSecond || 0)} fps<br>`;
          if (loss != null) block += `packet loss: <span class="${loss < .02 ? "good" : loss < .05 ? "warn" : "bad"}">${(loss * 100).toFixed(1)}%</span><br>`;
        } catch (e) {}
      }
      html += block + "</div>";
    }
    panel.innerHTML = html || "No one else is here yet.";
  }
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- peer gone / leave ----------
  function onPeerGone(peerId) {
    const rec = S.peers.get(peerId);
    if (!rec) return;
    try { rec.call && rec.call.close(); } catch (e) {}
    try { rec.screenCall && rec.screenCall.close(); } catch (e) {}
    try { rec.screenIn && rec.screenIn.close(); } catch (e) {}
    rec.tile && rec.tile.remove();
    rec.shareTile && rec.shareTile.remove();
    S.peers.delete(peerId);
    refreshLayout();
    toast((rec.name || "A friend") + " left");
  }

  function leave() {
    S.leaving = true;
    stopShare();
    S.peers.forEach((rec) => {
      try { rec.conn && rec.conn.close(); } catch (e) {}
      try { rec.call && rec.call.close(); } catch (e) {}
    });
    S.peers.clear();
    if (S.camTrack) S.camTrack.stop();
    teardownCleanStream();
    cleanupPeer();
    clearInterval(S.statsTimer);
    $("grid").innerHTML = "";
    S.camOn = false; S.micOn = true; S.isHost = false; S.leaving = false; S.camFace = "user";
    removeSelfShare();
    $("flipBtn").style.display = "none";
    try { S.boardCtx && S.boardCtx.close(); } catch (e) {}
    S.boardCtx = null;
    ["micBtn"].forEach((i) => $(i).classList.add("on"));
    ["camBtn", "shareBtn"].forEach((i) => $(i).classList.remove("on"));
    $("micBtn").classList.remove("off-warn");
    $("chatLog").innerHTML = "";
    showScreen("lobby");
  }

  // ---------- UI wiring ----------
  window.addEventListener("DOMContentLoaded", () => {
    // name prefilled (and avatar blob restored) from the saved profile
    bootProfile();
    // voice mode toggle (saved on this device)
    const applyVoiceUi = () => {
      const m = getVoiceMode();
      $("voiceGroup").querySelectorAll(".opt").forEach((b) => b.classList.toggle("sel", b.dataset.voice === m));
    };
    $("voiceGroup").querySelectorAll(".opt").forEach((b) => {
      b.onclick = () => { try { localStorage.setItem("tgm_voice", b.dataset.voice); } catch (e) {} applyVoiceUi(); };
    });
    applyVoiceUi();
    $("hostBtn").onclick = hostRoom;
    $("joinBtn").onclick = joinRoom;
    $("codeInput").addEventListener("input", (e) => {
      let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (v.startsWith("TGM")) v = v.slice(3);
      e.target.value = v ? "TGM-" + v.slice(0, 4) : "";
    });
    $("codeInput").addEventListener("keydown", (e) => e.key === "Enter" && joinRoom());

    $("micBtn").onclick = toggleMic;
    $("camBtn").onclick = toggleCam;
    $("flipBtn").onclick = flipCam;
    $("shareBtn").onclick = toggleShare;
    $("leaveBtn").onclick = leave;
    $("statsBtn").onclick = () => { $("statsPanel").classList.toggle("hidden"); updateStats(); };

    $("codeChip").onclick = async () => {
      try { await navigator.clipboard.writeText(S.roomCode); toast("Code copied: " + S.roomCode); }
      catch (e) { toast("Room code: " + S.roomCode); }
    };

    $("chatBtn").onclick = () => {
      $("chatPanel").classList.toggle("closed");
      if (!$("chatPanel").classList.contains("closed")) { unread = 0; $("chatBadge").classList.add("hidden"); $("chatInput").focus(); }
    };
    $("chatClose").onclick = () => $("chatPanel").classList.add("closed");
    $("chatForm").onsubmit = (e) => {
      e.preventDefault();
      const v = $("chatInput").value.trim();
      if (!v) return;
      addChat(S.name, v, true);
      broadcast({ t: "chat", text: v });
      $("chatInput").value = "";
    };

    // quality sheet
    $("qualityBtn").onclick = () => $("qualitySheet").classList.toggle("hidden");
    $("qualityClose").onclick = () => $("qualitySheet").classList.add("hidden");
    const pick = (groupId, attr, cb) => {
      $(groupId).querySelectorAll(".opt").forEach((b) => {
        b.onclick = () => {
          $(groupId).querySelectorAll(".opt").forEach((x) => x.classList.remove("sel"));
          b.classList.add("sel"); cb(b.dataset[attr]);
        };
      });
    };
    pick("resGroup", "res", (v) => (S.shareQuality.height = +v));
    pick("fpsGroup", "fps", (v) => (S.shareQuality.fps = +v));
    pick("modeGroup", "mode", (v) => (S.shareQuality.mode = v));
    $("brRange").oninput = (e) => { S.shareQuality.mbps = +e.target.value; $("brLabel").textContent = e.target.value; };

    // profile: name + avatar, edited live in the lobby
    $("nameInput").addEventListener("input", persistProfile);
    $("lobbyAvatar").onclick = () => $("profFile").click();
    $("avatarBtn").onclick = () => $("profFile").click();
    $("avatarClear").onclick = clearOwnAvatar;
    $("profFile").addEventListener("change", (e) => { setOwnAvatar(e.target.files && e.target.files[0]); e.target.value = ""; });

    // soundboard
    $("boardBtn").onclick = () => $("boardSheet").classList.toggle("hidden");
    $("boardClose").onclick = () => $("boardSheet").classList.add("hidden");
    $("boardGrid").innerHTML = SOUNDS.map((s) => `<button type="button" class="pad" data-k="${s.k}"><span class="art">${s.art}</span><b>${s.label}</b></button>`).join("");
    $("boardGrid").addEventListener("click", (e) => {
      const p = e.target.closest(".pad");
      if (p) boardKey(p.dataset.k);
    });

    // unlock audio playback on the first tap (browser autoplay rules)
    document.addEventListener("pointerdown", () => ensureBoardCtx(), { capture: true, passive: true });

    // Leave cleanly if the tab/app closes
    window.addEventListener("beforeunload", () => { try { S.peer && S.peer.destroy(); } catch (e) {} });
  });

})();
