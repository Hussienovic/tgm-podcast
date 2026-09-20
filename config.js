// =====================================================
//  TGM Podcast - settings you can edit
// =====================================================

window.TGM_CONFIG = {

  // ---- ICE servers: how friends find each other across networks ----
  // STUN is free and enough for most connections.
  // If a friend can't connect, add a TURN server below (relay fallback).
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },

    // ---- TURN RELAY: needed for friends on strict networks (this fixed "far friend can't connect") ----
    // 1) Make a free account at https://www.metered.ca/tools/openrelay/  (no credit card, 20 GB/month free)
    // 2) In the dashboard open your TURN credentials and copy the username + credential
    // 3) Delete the two "//" at the start of each line below and paste your values.
    // Everyone who opens YOUR hosted link gets this automatically, so friends do nothing.
    //
    // {
    //   urls: [
    //     "turn:standard.relay.metered.ca:80",
    //     "turn:standard.relay.metered.ca:80?transport=tcp",
    //     "turn:standard.relay.metered.ca:443",
    //     "turns:standard.relay.metered.ca:443?transport=tcp"
    //   ],
    //   username: "PASTE_YOUR_USERNAME",
    //   credential: "PASTE_YOUR_CREDENTIAL"
    // },
  ],

  // ---- PeerJS signaling broker (free public one by default) ----
  // To self-host later, set host/port/path/secure here.
  peerServer: {
    // host: "your-broker.onrender.com",
    // port: 443,
    // path: "/",
    // secure: true,
  },

  // ---- Voice settings ----
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000,
    opusMaxBitrate: 96000,   // bits per second
  },

  // ---- Camera settings ----
  camera: {
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 1500000,     // 1.5 Mbps per viewer
  },

  // ---- Screen share defaults (changeable in the Quality menu) ----
  screen: {
    height: 1080,
    frameRate: 60,
    maxBitrateMbps: 8,
    contentHint: "motion",   // "motion" for games, "detail" for code/text
  },

  maxPeople: 4,
};
