# Transcriber：本機 AI 語音轉錄與知識管理

上傳會議、課程、訪談錄音後，系統會在本機 GPU 上依序完成以下處理：

- 語音偵測（Silero VAD）
- 語音辨識（Qwen3-ASR-1.7B）
- 字詞時間對齊（Qwen3-ForcedAligner-0.6B）
- 講者分離（Nemotron-3-Diarization）
- 跨錄音講者辨認（TitaNet-Large）

需要時，再透過本機已登入的 Claude Code CLI 或 Codex CLI 產生會議紀錄或上課筆記，最後歸檔到 Obsidian vault。

**錄音只在這台主機處理**，不會上傳到任何外部服務。筆記生成時，只有逐字稿文字會交給 CLI，CLI 可能使用它自己設定的遠端模型。

- 服務網址：<https://whisper.elvismao.com>（只能經 Cloudflare WARP 內網連線，DNS 指向 emfox 的 WARP IP `100.96.0.25`）
- 部署主機：`emfox`（Ubuntu 24.04、RTX 5060 8 GB、RTX 3050 6 GB、12 cores、39 GB RAM）
- 專案路徑：`/home/em/transcriber`；開發副本在 Mac 的 `/Users/em/transcriber`

## 架構

```
Browser (React SPA)
  │ HTTPS (Caddy, Let's Encrypt via Cloudflare DNS-01) — LAN / WARP only
  ▼
Fastify API (Node 22, 127.0.0.1:8000) ── SQLite (WAL) ── data/recordings/<id>/…
  │  REST + SSE                         uploads / jobs / stages / transcripts / speakers / notes
  │
  ├─ Scheduler (GPU-aware lanes, leases, checkpoints, pause/resume/cancel)
  │     ├─ lane gpu-asr  → Python worker  CUDA_VISIBLE_DEVICES=<RTX 5060 UUID>  ASR + Forced Alignment
  │     ├─ lane gpu-diar → Python worker  CUDA_VISIBLE_DEVICES=<RTX 3050 UUID>  Nemotron diarization
  │     ├─ lane cpu      → Python worker  (no GPU)                               Silero VAD, TitaNet
  │     ├─ lane ffmpeg   → ffmpeg/ffprobe (decode, 16 kHz, speechnorm, waveform peaks)
  │     └─ lane llm      → claude -p / codex exec (tools disabled, sandboxed)
  │
  └─ Obsidian service ─ LiveSync MCP (obsidian-sync-mcp → CouchDB) 或本機 filesystem
                        + obsidian-kb 語意搜尋（唯讀，歸檔參考）
```

每筆轉錄任務的階段如下。總進度是各階段進度的加權平均，權重可以在設定中調整：

| 階段 | Lane | 進度依據 |
| --- | --- | --- |
| Uploading | 瀏覽器 | 伺服器確認收到的 bytes |
| Validating / Preparing Audio | ffmpeg | ffmpeg `out_time`（兩次轉碼） |
| VAD | cpu | Silero 已處理的音訊 frames |
| ASR | gpu-asr | 已辨識語音秒數 ÷ 總語音秒數（區段 checkpoint） |
| Forced Alignment | gpu-asr | 已對齊區段數 |
| Speaker Diarization | gpu-diar | 已串流處理的原始音訊秒數 |
| Speaker Identification | cpu | 已完成聲紋片段數 |
| Merging Results / Saving Transcript | server | 步驟 |
| AI Note Generation | llm | 無法量化，顯示為不確定進度（indeterminate） |
| Obsidian Export | server | 已寫入的檔案數 |

diarization 只依賴音訊前處理，所以會和 VAD、ASR、Alignment 在另一張 GPU 上平行執行。同一張 GPU 一次只跑一個重型階段，多個檔案會排隊。

### 時間軸與講者歸屬

- 所有時間都以原始錄音的毫秒數為準。ASR 區段（VAD 依停頓切出，上限 28 秒，超過時在最安靜處切開）只是送進模型的單位，和 HTTP 上傳 chunk 是兩個完全無關的概念。
- Diarization 用 Nemotron 官方的 Arrival-Order Speaker Cache，把整份錄音串流跑完（offline 設定：chunk 340 + right context 40，共 30.4 秒），所以 ASR 怎麼切段都不會讓講者重新編號。
- 每個字詞的講者，是用字詞時間和 diarization 區間的**實際重疊長度**決定的，不是看片段的起始時間。句子內講者真的換人時會拆開。重疊發言標成「重疊發言」；沒有任何區間覆蓋時標成「講者未確定」，不會硬塞給某個人。

## 目錄結構

```
transcriber/
├── server/                 Fastify + TypeScript API、scheduler、stages、adapters
│   ├── src/
│   │   ├── app.ts          組裝（auth、CORS/CSP、LAN-only、SSE、靜態檔）
│   │   ├── db/             schema migrations（SQLite WAL、FK、busy_timeout）
│   │   ├── uploads/        分塊續傳上傳
│   │   ├── queue/          jobs 與 scheduler（lane、lease、retry、pause/resume/cancel）
│   │   ├── stages/         prepare / vad / asr / align / diarize / identify / merge / save / notes / export
│   │   ├── workers/        Python worker pool、mock worker、nvidia-smi
│   │   ├── transcript/     合併、講者歸屬、聲紋比對、匯出（TXT/MD/JSON/SRT/VTT）
│   │   ├── speakers/       講者、聲紋、合併
│   │   ├── llm/            Claude Code / Codex CLI adapter、prompt、JSON schema
│   │   └── obsidian/       vault 後端（filesystem / LiveSync MCP）、路徑安全、Markdown
│   └── test/               vitest：上傳、佇列、筆記與 Obsidian、單元測試（mock worker）
├── worker/                 Python AI worker（uv venv、torch cu132）
│   ├── transcriber_worker/ protocol / vad / asr / align / diarize / speaker / checkpoint
│   └── tests/              pytest
├── web/                    React 19 + Vite 7 + Tailwind 4 SPA（由 Fastify 提供靜態檔）
├── deploy/                 install.sh、systemd unit、Caddy 安裝腳本與設定片段
├── scripts/                dev.sh、acceptance.mjs（真實模型驗收）、worker_e2e.py、download_models.py
├── docs/TEST_REPORT.md     測試與驗收報告
└── data/                   （不進 git）SQLite、錄音、中間結果、logs
```

## 實際採用的版本（2026-10-19 於 emfox 驗證）

| 元件 | 版本 |
| --- | --- |
| NVIDIA driver / CUDA | 595.99.02 / 13.2 |
| PyTorch | 2.12.0+cu132（arch list 含 sm_86、sm_120） |
| Transformers | 5.20.1（Qwen3-ASR、Qwen3-ForcedAligner、Nemotron3Diarization 原生支援） |
| NeMo toolkit | 3.0.0（只用於 TitaNet） |
| silero-vad / onnxruntime | 6.2.3 / 1.31.0 |
| OpenCC | opencc-python-reimplemented 0.1.7（`s2twp`） |
| Python / uv | 3.12.3 / 0.9.28 |
| Node.js / pnpm | 22.23.1 / 10.33.0 |
| Fastify / better-sqlite3 / zod | 5.x / 12.x / 4.x |
| React / Vite / Tailwind | 19.2 / 7.3 / 4.1 |
| Claude Code CLI | 2.1.299（已登入，team） |
| Codex CLI | 0.163.0（已安裝，**未登入**） |
| Caddy | 2.11 官方建置 + `caddy-dns/cloudflare`（`/usr/local/bin/caddy-cloudflare`） |

模型都從 Hugging Face 下載，全部公開、不需要 token：`Qwen/Qwen3-ASR-1.7B-hf`、`Qwen/Qwen3-ForcedAligner-0.6B-hf`、`nvidia/Nemotron-3-Diarization`、`nvidia/speakerverification_en_titanet_large`。Silero VAD 的 ONNX 檔隨 pip 套件附帶。

### 關於 Nemotron 的推論路徑

PyPI 上的 `nemo-toolkit 3.0.0` 還不支援這個模型用的 `rope` 位置編碼，載入時會失敗。模型卡同時列出 Transformers 原生支援，而 transformers 5.20.1 已內建 `nemotron3_diarization`，所以這裡用 Transformers 實作。串流時沿用官方的 speaker cache，chunk 設定採用模型卡的 offline preset，模型本身沒有換。

## GPU 配置

| 用途 | 裝置 | 實測 |
| --- | --- | --- |
| ASR + Forced Alignment | RTX 5060 `GPU-913df724-9287-14b3-153e-002538fa1e75`（sm_120） | 兩個模型同時常駐約 5.7 GB；設定 `coResident=auto`，遇到 OOM 時改成依序載入並重試 |
| Speaker Diarization | RTX 3050 `GPU-25f465d6-bbf9-8a88-007a-016334a5f12f`（sm_86） | 峰值約 0.4 GB；53 分鐘錄音約 15 秒（RTFx 約 210） |
| VAD、TitaNet、ffmpeg、API | CPU | |

- 裝置一律以 **GPU UUID** 指定。每個 worker 用 `CUDA_VISIBLE_DEVICES=<UUID>` 啟動，在行程內永遠是 `cuda:0`，兩張卡的 VRAM 不會合併使用。
- 第一次啟動時會依 GPU 名稱自動對應，之後可以在「設定 → GPU Device Mapping」修改。
- Diarization 的 GPU 若遇到 OOM（重試後仍失敗）或架構不支援，會依設定改用 CPU，並在 UI 標示「在 CPU 執行，速度會明顯較慢」；也可以設定成直接失敗並顯示診斷。
- 模型閒置 15 分鐘後自動卸載，釋放 VRAM。

## 安裝與啟動

### 正式部署（emfox，已完成）

```bash
cd /home/em/transcriber
./deploy/install.sh          # uv venv + torch cu132、模型下載、pnpm build、.env、systemd
./deploy/install-caddy.sh    # 只需一次：含 Cloudflare DNS 模組的 Caddy（apt 的 /usr/bin/caddy 不動）
```

- 服務：`transcriber.service`（systemd，開機自動啟動，`Restart=on-failure`，以 `em` 身分執行）。API、scheduler 和三個 Python worker 都由這個服務管理，不需要另外開 terminal。
- HTTPS：`caddy.service`，設定在 `/etc/caddy/Caddyfile`，修改前的備份在 `/root/caddy-change-20261019T095228Z/`。
- 升級：原始碼的 git repo 在 Mac 的 `/Users/em/transcriber`，emfox 上是部署副本。從 Mac 執行 `rsync -az --exclude node_modules --exclude .venv --exclude data --exclude dist --exclude .git ./ emfox:transcriber/`，再到 emfox 執行 `./deploy/install.sh --no-models`。
- 健康檢查：`curl http://127.0.0.1:8000/api/health`；完整狀態請看 UI 的「設定 → System Diagnostics」或 `GET /api/system/status`。

```bash
systemctl status transcriber caddy
journalctl -u transcriber -f                  # 或 data/logs/service.log
tail -f data/logs/server.log data/logs/worker-gpu-asr.log
```

### 開發

```bash
pnpm install
MOCK_WORKER=1 ./scripts/dev.sh     # 沒有 GPU 也能跑（假 worker），API :8000 + Vite :5173
./scripts/dev.sh                   # 在 emfox 上用真實 worker
pnpm --filter server test          # 44 項整合／單元測試
worker/.venv/bin/python -m pytest worker/tests
node scripts/acceptance.mjs --file a.m4a --template meeting    # 真實模型驗收
```

### 帳號

- 第一次啟動時，會用 `.env` 的 `ADMIN_USER` / `ADMIN_PASSWORD` 建立帳號。`install.sh` 會產生隨機密碼：`grep ADMIN_PASSWORD /home/em/transcriber/.env`
- 改密碼：UI「設定 → System Diagnostics → 變更密碼」，或執行 `echo '新密碼' | node server/dist/cli.js set-password admin`

## Obsidian 整合

- 你的 vault 本體在 Mac 上，emfox 上只有一份唯讀的明文鏡像。因此正式環境的寫入走 **LiveSync MCP**（`obsidian-sync-mcp`，`127.0.0.1:27123`）：直接寫進 CouchDB，再由 LiveSync 同步到所有裝置。每次寫入後都會讀回驗證內容一致。token 從 `/opt/obsidian/.env` 讀進本專案的 `.env`。
- 如果 vault 直接掛載在這台主機上，可以改用 `filesystem` 後端，在設定中填 vault 的絕對路徑；系統會用 realpath 確認任何寫入都不會跑到 vault 外面。
- Obsidian URI 用的 vault 名稱設為 `EM's Brain`。MCP 回報的名稱是 `Obsidian`，和你裝置上的實際名稱不同，所以這個值做成可設定。

### 存放規則

依照 vault 的 `AGENTS.md`：

- 逐字稿：`50 🏳️‍⚧️ Trans/逐字稿/{yymmdd} {標題} 逐字稿.md`，所有逐字稿集中放在這裡。
- 會議紀錄、上課筆記：`50 🏳️‍⚧️ Trans/<專案>/{yymmdd} {標題} 會議記錄.md`（或 `上課筆記.md`）。
- 分類不確定時：先放 `50 🏳️‍⚧️ Trans/待整理/`，UI 會顯示建議路徑，可以一鍵採用或移動。
- 雙向連結：筆記的 frontmatter 和內文都有 `原始逐字稿：[[…]]`；逐字稿有 `相關筆記：[[…]]`。
- 檔名樣板可以在設定中修改。spec 範例的 `2026-10-19_標題.md` 格式改成了 vault 現有的慣例。

### 安全

- 只能寫進 `allowedRoots`，預設只有 `50 🏳️‍⚧️ Trans`。專案掃描是唯讀的，範圍是 Trans 子資料夾、`10 💻 Projects`、`20 🗿 Knowledge/School`，另外可以搭配 obsidian-kb 語意搜尋。
- AI 只能「建議」資料夾。後端只接受候選清單中的既有資料夾，而且要信心達到 0.75 以上；新資料夾名稱一定會先經過清理和路徑驗證，也一定會先進待整理區。
- 同名檔案不會被默默覆蓋。只有在「這是本系統寫的檔案，而且內容 sha 沒變」時才更新；否則另存為 `… v2.md`，或必須在 UI 明確勾選「仍然覆蓋」。
- 刪除系統資料預設不會動 Obsidian 檔案。要刪除 Obsidian 中由本系統建立的檔案，必須在 UI 明確確認，API 也要求帶確認字串。

## 安全性

- **驗證**：帳號密碼（scrypt）搭配 `HttpOnly; Secure; SameSite=Strict` 的 session cookie。除了 `/api/health` 和登入以外，所有 API 都需要登入。連續 5 次登入失敗會鎖 5 分鐘。
- **CORS / CSRF**：API 只允許同源。會改變狀態的請求如果帶有 Origin，必須是本站或 `ALLOWED_ORIGINS` 列出的來源。另外設定了 CSP、`X-Frame-Options`、`nosniff`。
- **網路**：Fastify 只綁 `127.0.0.1`。Caddy 和 app（`LAN_ONLY=1`）都只接受私有網段與 WARP 的 100.64.0.0/10。DNS 記錄是 DNS-only，指向 WARP 內網 IP，沒有 tunnel 對外，所以公網無法連入。
- **上傳**：
  - 檢查副檔名與 MIME 白名單、大小上限、磁碟空間。
  - 每個 chunk 都做 SHA-256 驗證，大小與 index 都在伺服器端檢查，每個請求都小於 100 MB。
  - 檔名只當作 metadata；實際存放路徑是 `recordings/<uuid>/source.<ext>`。
  - 每個上傳 session 綁定使用者。
- **子程序**：ffmpeg、Python worker、Claude、Codex 一律用 `spawn` 搭配參數陣列，不經 shell；並設有逾時、輸出上限，取消時終止整個 process group。
- **LLM CLI 的最低權限**：
  - Claude：`--tools ""`、`--strict-mcp-config`（空 MCP）、`--safe-mode`（不載入 CLAUDE.md、hooks、plugins）、`--disable-slash-commands`、`--no-session-persistence`、`--permission-mode dontAsk`、`--max-budget-usd`。
  - Codex：`--sandbox read-only`、`--ephemeral`、`--ignore-user-config`、`--ignore-rules`、`approval_policy=never`。
  - 兩者都在每次新建的空目錄中執行，環境變數只保留 HOME、PATH 這類必要項目，伺服器的 token 不會傳進去。另外設有每日呼叫上限。
- **Prompt injection**：逐字稿放在 `<transcript>` 內，系統 prompt 明確說明這是不可信資料。輸出受 JSON Schema 約束，後端還會再驗證與修正。模型輸出的字串會先轉成 inert Markdown（不允許 HTML 或 embed），前端再用 DOMPurify 處理一次。路徑只由後端決定。
- **日誌**：request body、cookie、authorization 都會遮罩。錄音內容、逐字稿和筆記文字不會寫進日誌。

## 資料與刪除

- SQLite 只存 metadata、逐字稿、字詞、講者、聲紋向量（每個 192 維，768 bytes）、任務狀態與筆記。音訊、checkpoint、模型都不存成 BLOB。
- 錄音資料夾 `data/recordings/<id>/` 的內容：
  - `source.*`：原始檔
  - `audio16k.wav`：給 diarization 和聲紋用
  - `work/asr16k.wav`：做過 speechnorm 的副本，給 VAD、ASR、對齊用
  - `work/*.json`：中間結果與 checkpoint
  - `peaks.json`：waveform 資料
  - `transcript.json`：逐字稿快照
- 刪除選項彼此獨立：只刪原始錄音（逐字稿保留）／刪逐字稿與處理紀錄／刪筆記／刪整筆錄音／刪講者或單一聲紋／清理失敗上傳／清理中間結果。磁碟用量與清理設定在「設定 → Storage」。

## 已知限制與待辦

- **Codex CLI 尚未登入**。在 emfox 執行 `codex login` 後就能使用；目前 UI 會明確顯示「未登入」。
- TitaNet 以英文資料訓練，中文聲紋分數的可靠度較低。中文門檻預設 0.78（英文 0.72），而且要求與第二名差距至少 0.10。請在累積幾份人工確認的資料後，用 `GET /api/speakers/calibration` 校準。
- 暫停的粒度：ASR 和對齊會在區段邊界暫停，恢復時從 checkpoint 接續。VAD、diarization（53 分鐘約 15 秒）和 LLM 呼叫中途暫停的話，恢復後會重跑該階段。
- 「重新轉錄」時，如果音訊、VAD 切段、語言與 Vocabulary 都和上次相同，ASR 會直接沿用 checkpoint（解碼是 deterministic）。修改 Vocabulary 或語言後就會重新辨識。
- 這個專案的 `data/` 還沒有加入 Backrest 備份。
