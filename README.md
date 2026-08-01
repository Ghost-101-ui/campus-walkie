# 📻 Campus Walkie

> **Zero-Trust, End-to-End Encrypted, Peer-to-Peer Voice & Text Walkie-Talkie for the Web.**

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev/)
[![WebRTC](https://img.shields.io/badge/WebRTC-333333?style=for-the-badge&logo=webrtc&logoColor=white)](https://webrtc.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

**Campus Walkie** is a high-performance, browser-based Push-To-Talk (PTT) walkie-talkie and secure chat application. Designed with a Neo-Brutalist + Engineering Notebook aesthetic, it enables instant, encrypted, low-latency communication over P2P WebRTC mesh networks without central database persistence.

---

## ✨ Features

- 🎙️ **Physical Push-To-Talk (PTT)**: Low-latency voice streaming over WebAudio & WebRTC with real-time canvas waveform visualizer, half-duplex locks, and active talker indicator.
- 🔒 **End-to-End Encryption (E2EE)**: Zero-knowledge architecture using Web Crypto API, PBKDF2-SHA256 key derivation (100,000 iterations), and AES-256-GCM ciphers. Private keys never touch any server.
- 💬 **Smart Timeline Chat**: Linear/Slack-style messaging with file attachment transfer over chunked P2P DataChannels.
- 📱 **Responsive Neo-Brutalist UI**: 
  - **Desktop**: 3-column layout (Left: Peer List, Center: Hero PTT & Timeline, Right: Security & Relays).
  - **Mobile View**: 3-tab switcher (`PTT` | `CHAT` | `PEERS`) with zero-interruption in-place DOM node persistence.
- 🛡️ **Hybrid Secure Invite System**:
  - **📷 Instant-Join QR Code**: Camera-scannable QR code containing temporary key for fast in-person pairing.
  - **🔒 Safe Share Link**: Excludes secret key for safe texting/emailing (prompts recipient for passcode upon joining).
- 🚨 **Panic & Security Controls**:
  - **Panic Button**: Instant wipe of local state, session storage, and active WebRTC mesh keys.
  - **Safety Word Grid**: Out-of-band key verification matrix.
- ⚡ **Serverless P2P Signaling**: Lightweight Cloudflare Worker signaling relay for peer discovery with zero data logging.

---

## 🛠️ Technology Stack

| Component | Technology |
| :--- | :--- |
| **Language** | TypeScript (Strict mode) |
| **Build System** | Vite |
| **Realtime Mesh** | WebRTC (`RTCPeerConnection`, `RTCDataChannel`) |
| **Audio Processing** | Web Audio API (`AudioContext`, `MediaStream`, Canvas visualizer) |
| **Cryptography** | Web Crypto API (AES-256-GCM), PBKDF2 Web Worker KDF |
| **Signaling Relay** | Cloudflare Workers (`signaling/src/index.ts`) |
| **Styling** | Vanilla CSS3 (Custom Brutalist Design Tokens) |

---

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+ recommended)
- `npm` or `pnpm`

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Ghost-101-ui/campus-walkie.git
   cd campus-walkie
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start local development server:**
   ```bash
   npm run dev
   ```
   Open your browser at `http://localhost:5173`.

4. **Build for production:**
   ```bash
   npm run build
   ```

5. **Typecheck codebase:**
   ```bash
   npm run typecheck
   ```

---

## 📁 Repository Structure

```
campus-walkie/
├── public/                # Static assets & icons (group.png, voice-chat.png, etc.)
├── signaling/             # Cloudflare Workers Signaling Backend
│   ├── src/index.ts       # WebSocket signaling relay server
│   └── wrangler.jsonc     # Cloudflare deployment configuration
├── src/
│   ├── audio/             # Mic capture, playback queue & canvas meter
│   │   ├── ptt.ts
│   │   └── playback.ts
│   ├── components/        # Reusable UI widgets
│   ├── crypto/            # Key derivation & Web Worker encryption
│   │   ├── kdf.ts
│   │   └── identity.ts
│   ├── net/               # WebRTC Mesh & Signaling Client
│   │   ├── mesh.ts
│   │   ├── signaling.ts
│   │   └── datachannel.ts
│   ├── ui/                # Brutalist UI Views & Modals
│   │   ├── join.ts        # State 1: Join Screen
│   │   ├── channel.ts     # State 2: Channel Grid & Mobile Views
│   │   ├── chat.ts        # Smart Chat Timeline
│   │   ├── qr.ts          # Canvas QR Code Generator
│   │   └── dom.ts         # Lightweight DOM helper utilities
│   ├── main.ts            # Application Entry & State Manager
│   └── index.css          # Core Brutalist Design System & Media Queries
└── index.html             # Main HTML Template
```

---

## 🔐 Security Architecture

1. **Zero-Knowledge Keys**: Passphrases and room names are processed locally using PBKDF2-SHA256 inside a background Web Worker.
2. **Ephemeral Identity**: Every session generates a non-extractable CryptoKey pair (`ECDSA` / `P-256`) stored only in volatile memory.
3. **URL Hash Protection**: Encryption keys in URLs are stored in the location hash (`#key=...`), ensuring they are **never sent over HTTP headers** to any web server or proxy logs.
4. **Panic Evacuation**: Clicking Panic immediately clears `sessionStorage`, resets state maps, closes WebSockets, and destroys active MediaStreams.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/Ghost-101-ui/campus-walkie/issues).

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.
