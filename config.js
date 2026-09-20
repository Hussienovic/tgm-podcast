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

    // ---- TURN (OPTIONAL) ----
    // Uncomment ONE block after you create a free account and get credentials.
    //
    // Metered.ca  (free tier, sign up at metered.ca -> TURN Server -> API keys)
    // {
    //   urls: [
    //     "turn:YOUR_SUBDOMAIN.metered.live:80",
    //     "turn:YOUR_SUBDOMAIN.metered.live:443",
    //     "turns:YOUR_SUBDOMAIN.metered.live:443?transport=tcp"
    //   ],
    //   username: "YOUR_USERNAME",
    //   credential: "YOUR_CREDENTIAL"
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
