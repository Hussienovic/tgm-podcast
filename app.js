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
  };

  // ---------- helpers ----------
  const PEER_PREFIX = "tgmpod-";
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O/1/I
  const genCode = () =>
    "TGM-" + Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  const codeToPeerId = (code) => PEER_PREFIX + code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const randId = () => PEER_PREFIX + Math.random().toString(36).slice(2, 10);

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
  function makePeer(id) {
    const opts = { config: { iceServers: CFG.iceServers, sdpSemantics: "unified-plan" }, debug: 1 };
    if (CFG.peerServer && CFG.peerServer.host) Object.assign(opts, CFG.peerServer);
    return new Peer(id, opts);
  }

  async function startLocalMedia() {
    try {
      S.localStream = await getMic();
    } catch (e) {
      throw new Error("Microphone blocked. Allow mic access in your browser or phone settings, then try again.");
    }
  }

  async function hostRoom() {
    setErr("");
    S.name = ($("nameInput").value || "").trim() || "Host";
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
    S.name = ($("nameInput").value || "").trim() || "Friend";
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
        conn.send({ t: "hello", name: S.name });
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
  }

  // ---------- data channel protocol ----------
  // t: hello {name} | roster {list:[{id,name}]} | chat {text} | mute {muted} | share {on, streamId} | full
  function registerConn(conn, peerId, name) {
    let rec = S.peers.get(peerId) || {};
    rec.conn = conn;
    if (name) rec.name = name;
    S.peers.set(peerId, rec);

    conn.off && conn.off("data");
    conn.on("data", (m) => onData(peerId, m));
    conn.on("close", () => onPeerGone(peerId));
    conn.on("error", () => {});

    // Host: tell newcomer who else is here, tell everyone else about newcomer
    if (S.isHost && S.peers.size) {
      const roster = [...S.peers.entries()]
        .filter(([id]) => id !== peerId)
        .map(([id, r]) => ({ id, name: r.name || "Friend" }));
      conn.send({ t: "roster", list: roster });
      S.peers.forEach((r, id) => {
        if (id !== peerId && r.conn && r.conn.open) r.conn.send({ t: "newpeer", id: peerId, name: rec.name || "Friend" });
      });
    }
    // Call them with my mic
    if (!rec.call && shouldICall(peerId)) callPeer(peerId);
    ensureTile(peerId);
    // introduce myself and share my current state (both sides do this)
    conn.send({ t: "hello", name: S.name });
    conn.send({ t: "mute", muted: !S.micOn });
    if (S.sharing && S.screenStream) conn.send({ t: "share", on: true, streamId: S.screenStream.id });
  }

  // Deterministic: the peer with the smaller id places the call (avoids double calls)
  const shouldICall = (otherId) => S.myId < otherId;

  function onData(peerId, m) {
    const rec = S.peers.get(peerId);
    if (!rec || !m) return;
    switch (m.t) {
      case "hello":
        rec.name = m.name; updateTileName(peerId); break;
      case "roster":
        // connect to everyone already in the room
        m.list.forEach((p) => connectToMember(p.id, p.name));
        break;
      case "newpeer":
        // host says someone new arrived; they will connect to us, nothing to do but expect them
        break;
      case "chat":
        addChat(rec.name || "Friend", m.text, false); break;
      case "mute":
        setTileMuted(peerId, m.muted); break;
      case "share":
        rec.screenStreamId = m.on ? m.streamId : null;
        if (!m.on) removeShareTile(peerId);
        refreshLayout();
        break;
      case "recall":
        if (shouldICall(peerId)) {
          try { rec.call && rec.call.close(); } catch (e) {}
          rec.call = null; callPeer(peerId);
          if (S.sharing && S.screenStream) callScreen(peerId);
        }
        break;
      case "full":
        toast("Room is full (max " + CFG.maxPeople + ")."); leave(); break;
    }
  }

  function connectToMember(id, name) {
    if (id === S.myId || S.peers.get(id)?.conn) return;
    const conn = S.peer.connect(id, { reliable: true, metadata: { name: S.name } });
    conn.on("open", () => {
      registerConn(conn, id, name);
      conn.send({ t: "hello", name: S.name });
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
      <div class="avatar"></div>
      <video autoplay playsinline ${self ? "muted" : ""}></video>
      <div class="label"><span class="muted-ic">🔇</span><span class="nm"></span></div>
      <div class="peer-status">reconnecting…</div>
      ${self ? "" : '<input class="vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">'}
    `;
    t.querySelector(".nm").textContent = name + (self && !isShare ? " (you)" : "");
    t.querySelector(".avatar").textContent = (name[0] || "?").toUpperCase();
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
    setupSpeakingDetector("self", S.localStream);
    refreshLayout();
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
    rec.tile.querySelector(".avatar").textContent = (rec.name[0] || "?").toUpperCase();
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
    const someoneSharing = !!grid.querySelector(".tile.sharing");
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

  async function toggleCam() {
    if (!S.camOn) {
      try {
        const c = CFG.camera;
        const cs = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: c.width }, height: { ideal: c.height }, frameRate: { ideal: c.frameRate } },
        });
        const track = cs.getVideoTracks()[0];
        track.contentHint = "detail";
        S.camTrack = track;
        S.localStream.addTrack(track);
        S.peers.forEach((rec) => addTrackToCall(rec, track, S.localStream));
        S.camOn = true;
        S.selfTile.classList.add("has-video");
        S.selfTile.querySelector("video").srcObject = S.localStream;
      } catch (e) { return toast("Camera blocked or not available."); }
    } else {
      S.camTrack.stop();
      S.localStream.removeTrack(S.camTrack);
      S.peers.forEach((rec) => removeTrackFromCall(rec, S.camTrack));
      S.camTrack = null; S.camOn = false;
      S.selfTile.classList.remove("has-video");
    }
    $("camBtn").classList.toggle("on", S.camOn);
    // renegotiation happens via re-call (PeerJS has no native renegotiation)
    S.peers.forEach((rec, id) => recallPeer(id));
  }

  function addTrackToCall(rec, track, stream) { /* handled by recallPeer, kept for clarity */ }
  function removeTrackFromCall(rec, track) { /* handled by recallPeer */ }

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
    S.peers.forEach((rec) => { try { rec.screenCall && rec.screenCall.close(); } catch (e) {} rec.screenCall = null; });
    broadcast({ t: "share", on: false });
    $("shareBtn").classList.remove("on");
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
    cleanupPeer();
    clearInterval(S.statsTimer);
    $("grid").innerHTML = "";
    S.camOn = false; S.micOn = true; S.isHost = false; S.leaving = false;
    ["micBtn"].forEach((i) => $(i).classList.add("on"));
    ["camBtn", "shareBtn"].forEach((i) => $(i).classList.remove("on"));
    $("micBtn").classList.remove("off-warn");
    $("chatLog").innerHTML = "";
    showScreen("lobby");
  }

  // ---------- UI wiring ----------
  window.addEventListener("DOMContentLoaded", () => {
    $("nameInput").value = localStorage.getItem("tgm_name") || "";
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

    // Leave cleanly if the tab/app closes
    window.addEventListener("beforeunload", () => { try { S.peer && S.peer.destroy(); } catch (e) {} });
  });

})();
