# Terminal Agent CLI (`npx`) — Dedicated Architecture & Build Plan

> **Why Keep the CLI Separate?**
> Mixing the Website/Server code and the Host Terminal Agent into one project is messy because they run on completely different machines:
> * **Your Central Server** runs in the cloud (manages the website, database, wallets, and API routing).
> * **The Terminal Agent CLI** runs on the **GPU Host's PC / Mini-Datacenter** (downloaded via `npx sublet-cli` to control their GPU, `llama.cpp`, and model files).
>
> Keeping the CLI as its own clean, standalone package makes it easy to publish to `npm`, easy to update, and rock-solid for 8-hour overnight jobs.

---

## 1. Folder Structure for the Standalone CLI (`agent-cli/`)

```text
agent-cli/
├── package.json              # Configured with "bin" so `npx sublet-cli` works out of the box
├── tsconfig.json
└── src/
    ├── index.ts              # CLI entry point (parses commands: login, start, host, jobs, doctor)
    ├── config.ts             # Manages ~/.sublet/config.json (saved Host Key, cache paths)
    ├── hardware/
    │   ├── gpuMonitor.ts     # Runs nvidia-smi / GPU checks (VRAM, temp, wattage, load %)
    │   └── sleepGuard.ts     # Prevents Windows/Linux/Mac from sleeping during 8-hour jobs
    ├── engine/
    │   ├── binaryManager.ts  # Auto-downloads official llama-server binary (CUDA / Vulkan / Metal)
    │   ├── modelManager.ts   # Downloads HuggingFace .gguf with progress bar + SHA-256 & header check
    │   └── llamaRunner.ts    # Spawns & locks llama-server on hidden localhost port + auto-restart
    ├── network/
    │   ├── tunnelClient.ts   # Persistent WebSocket to central server + auto-reconnect on Wi-Fi blip
    │   └── streamProxy.ts    # Pipes stream=true tokens from local llama-server -> central server
    └── ui/
        └── terminalDashboard.ts # Clean live terminal display (earnings ticker, timer, GPU stats)
```

All files downloaded on the Host's PC stay neatly inside one folder (`~/.sublet/`):
* `~/.sublet/config.json` — Host authentication key & settings
* `~/.sublet/bin/` — The `llama-server` executable & CUDA/Vulkan DLLs
* `~/.sublet/models/` — Cached HuggingFace `.gguf` models (so hosts never download the same model twice)

---

## 2. All CLI Commands (What the GPU Host Types)

| Command | What It Does |
| :--- | :--- |
| `npx sublet-cli login` | Asks for the Host's token from your website, verifies it, and saves it locally. |
| `npx sublet-cli doctor` | Scans the machine: prints GPU model, Total/Free VRAM, OS, internet speed, and downloads `llama-server` if missing. |
| `npx sublet-cli start` | **Main Mode (Web-Synced Standby):** Connects to your website and waits. When the host clicks **"Run Request"** on your website (e.g., an 8-hour overnight job), this terminal automatically downloads the `.gguf` and starts running it! |
| `npx sublet-cli jobs` | Lets mini-datacenter / Linux SSH hosts browse and accept 8-hour Buyer Requests **directly inside the terminal** without needing a browser. |
| `npx sublet-cli host <hf-url> --price 0.25` | Starts **Public Pay-Per-Token Mode** directly from the terminal with a chosen `.gguf` model and price per 1M tokens. |

---

## 3. The 6 Core Modules Inside the CLI Agent

### Module 1: Hardware & GPU Monitor (`gpuMonitor.ts`)
* **Before starting a job:** Checks `nvidia-smi` (or AMD/Apple Metal info) to verify the GPU actually has enough **Free VRAM** to fit the `.gguf` model + context window. If a request needs `18 GB VRAM` and the host only has a `12 GB` card, the CLI blocks them from claiming it so they don't fail and ruin their reliability score.
* **During a job (Every 5 Seconds):** Polls GPU Utilization %, Free VRAM, Temperature (°C), and Power Draw (Watts), sending heartbeats to your central server.
* **Background Game/App Detection:** If another process on the host's PC suddenly eats up VRAM while a job is active, the terminal flashes a warning so their `tok/s` speed doesn't drop.

### Module 2: Overnight Anti-Sleep Guard (`sleepGuard.ts`)
* Essential for the **"Sleep & Earn 8-Hour Request"** use case.
* As soon as the CLI starts a job, it engages an OS-level wake-lock:
  * **Windows:** Calls `SetThreadExecutionState` (via lightweight PowerShell/native call) so Windows never enters Sleep/Hibernate while the terminal is open.
  * **macOS / Linux:** Uses `caffeinate` / `systemd-inhibitor`.
* Releases the wake-lock automatically as soon as the 8-hour job finishes.

### Module 3: Automatic `llama.cpp` Engine Installer (`binaryManager.ts`)
* Normal GPU owners don't know how to compile `llama.cpp` or install CUDA toolkits.
* On first run, the CLI checks the host's GPU type and automatically downloads the matching pre-compiled `llama-server` release binary into `~/.sublet/bin/`:
  * **NVIDIA GPU:** CUDA build
  * **AMD / Intel GPU:** Vulkan build
  * **Apple Silicon (M1/M2/M3/M4):** Metal build
* Verifies the binary's SHA-256 checksum before running it so the host knows it wasn't tampered with.

### Module 4: HuggingFace `.gguf` Downloader & Local Verifier (`modelManager.ts`)
* **Resumable Download:** Downloads `.gguf` files from HuggingFace with a clean terminal progress bar (`42% [=====>    ] 8.4 GB / 19.8 GB • 65 MB/s • ETA 2m 55s`). If their internet hiccups during download, it resumes via HTTP `Range` instead of restarting from 0%.
* **On-the-Fly SHA-256 Hashing:** Calculates the file's SHA-256 hash while streaming it to disk. If the finished file hash doesn't match the official hash sent by your central server, it refuses to start.
* **GGUF Header Check:** Reads the first 4KB of the `.gguf` file to confirm the magic bytes (`GGUF`), layer count, and architecture match what `llama-server` expects.

### Module 5: Locked `llama-server` Process Runner (`llamaRunner.ts`)
* Spawns `llama-server` as an invisible child process bound strictly to `127.0.0.1:<random_port>` with locked security & performance flags:
  ```bash
  llama-server \
    --model ~/.sublet/models/model.gguf \
    --host 127.0.0.1 \
    --port <random_free_port> \
    --n-gpu-layers 999 \       # Forces 100% GPU VRAM execution (prevents slow CPU offloading)
    --ctx-size <locked_ctx> \  # Locks the exact context window promised to the buyer
    --parallel <slots> \       # 1 slot for Dedicated Buyer Requests, 4+ slots for Public Per-Token
    --cont-batching \          # Enables continuous batching
    --log-disable              # Zero prompt logging to disk (protects buyer privacy)
  ```
* **Crash Auto-Recovery:** If `llama-server` ever crashes (e.g., an out-of-memory spike), `llamaRunner.ts` automatically restarts it in `< 2 seconds` so the host doesn't fail their 8-hour job or lose their `>= 90%` reliability score.

### Module 6: WebSocket Tunnel & Stream Pipe (`tunnelClient.ts` & `streamProxy.ts`)
* **No Port Forwarding Needed:** Connects *outbound* to `wss://[webname].com/ws/agent`.
* **60-Second Wi-Fi Blip Protection:** If a host's home router resets or Wi-Fi drops for 10 seconds in the middle of the night, the CLI automatically reconnects with exponential backoff (`1s`, `2s`, `5s`) without killing `llama-server` in VRAM—saving the host from getting penalized!
* **Real-Time `stream=true` Piping:**
  1. Receives `{ requestId, payload }` from your central server over WebSocket.
  2. Sends `POST http://127.0.0.1:<port>/v1/chat/completions` with `stream: true`.
  3. Streams every token chunk back over the WebSocket (`{ requestId, chunk }`) with sub-millisecond overhead.
* **Canary Handshake Support:** Right after `llama-server` finishes loading the model into VRAM, the CLI notifies the central server (`READY_FOR_HANDSHAKE`), runs the server's `temp=0` verification prompt, and only starts the Buyer Request timer once the server replies `VERIFIED`.

---

## 4. What the Host Sees in Their Terminal (`terminalDashboard.ts`)

Instead of ugly scrolling logs, the CLI prints a clean, live-updating terminal box so the host can glance at their screen before bed (or when they wake up):

```text
┌──────────────────────────────────────────────────────────────────────┐
│  ⚡ SUBLET GPU TERMINAL AGENT v1.0.0               STATUS: ● ONLINE │
├──────────────────────────────────────────────────────────────────────┤
│  Host Endpoint : https://alex.[webname].com/api/v1                   │
│  Reliability   : 98.5% (SAFE — Auto-ban threshold: < 90.0%)          │
│  GPU Detected  : NVIDIA GeForce RTX 3090 (21.2 GB / 24.0 GB VRAM)    │
│  GPU Temp/Power: 61°C • 185W (Wake-Lock: ACTIVE - Sleep Blocked)     │
├──────────────────────────────────────────────────────────────────────┤
│  CURRENT JOB   : 🔒 Dedicated Buyer Request (#REQ-804)               │
│  Model Loaded  : Llama-3.3-70B-Abliterated-Q4_K_M.gguf (Verified ✓)  │
│  Time Remaining: 06h 14m 32s / 08h 00m 00s                           │
│  Live Speed    : 38.4 tok/s (Min Required: 25.0 tok/s ✓)             │
├──────────────────────────────────────────────────────────────────────┤
│  💰 Session Earnings : $4.68 / $6.00 Guaranteed                      │
│  🏦 Total Wallet     : $42.15 (Press [W] to open withdraw page)      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 5. Build Order for the CLI Agent (`agent-cli/`)

1. **Step 1 — CLI Skeleton & Hardware Scanner (`index.ts`, `config.ts`, `gpuMonitor.ts`, `sleepGuard.ts`):**
   * Get `npx` commands (`login`, `doctor`, `start`) working, detect the real GPU/VRAM on your machine, and engage the OS sleep blocker.
2. **Step 2 — Engine & Model Manager (`binaryManager.ts`, `modelManager.ts`, `llamaRunner.ts`):**
   * Auto-download `llama-server`, download/verify `.gguf` files (SHA-256 + GGUF header), and spawn `llama-server` on localhost with a mock/test fallback flag (`--simulation`) so you can also test fast without waiting on huge downloads.
3. **Step 3 — WebSocket Tunnel & Stream Pipe (`tunnelClient.ts`, `streamProxy.ts`):**
   * Connect to the central server, pass the `temp=0` handshake check, pipe `stream=true` tokens back and forth, and auto-recover from brief network drops.
4. **Step 4 — Live Terminal UI (`terminalDashboard.ts`):**
   * Render the clean live status box showing the 8-hour countdown timer, reliability %, GPU stats, and real-time earnings ticker.
