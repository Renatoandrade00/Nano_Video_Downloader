# Nano Video Downloader

Aplicação desktop offline-first construída sobre a arquitetura **Google Antigravity** (materializada em **Electron + TypeScript + React + SQLite + FFmpeg**) para autenticação legítima em plataformas de ensino (Hotmart e Kiwify), validação prévia de titularidade, download segmentado resiliente e reprodução offline.

---

## Documentação do Projeto

- [PRD — Product Requirements Document](./docs/nano_video_downloader_prd.md)
- [SPEC — Especificação Técnica do Sistema](./docs/nano_video_downloader_spec.md)
- [SDD — Software Design Document](./docs/nano_video_downloader_sdd.md)
- [TASKS — Plano de Implementação e Roadmap](./docs/TASKS.md)

---

## Arquitetura Implementada

- **Antigravity UI Engine (`src/renderer`):** Interface React + TypeScript com abas de **Biblioteca Offline**, **Catálogo Online**, **Fila de Downloads** e **Contas & Cofre**, além do player nativo embutido (`0.5x`–`2.5x`, atalhos de teclado e marcação automática `"Assistida"` em `>= 90%`).
- **IPC / Internal Bridge (`src/main/preload.ts`, `src/main/ipc/handlers.ts`):** Comunicação tipada Request/Response e eventos reativos (`queue:jobProgress`, `queue:moduleProgress`, `queue:jobCompleted`, `ownership:revoked`, `network:statusChanged`) + protocolo `antigravity-media://` com suporte HTTP `206` Byte-Range para seek offline.
- **Antigravity Backend Runtime (`src/main`):**
  - `WebBridge` & `AuthManager`: login isolado em `BrowserWindow` dedicada por conta/partition, sem persistir senhas em texto plano.
  - `OwnershipVerifier` & `IPlatformAdapter` (`HotmartAdapter`, `KiwifyAdapter`): valida `COMPLETED`/`ACTIVE` antes de listar ou baixar e revoga imediatamente (`REVOKED`) acessos expirados ou reembolsados.
  - `MediaStreamInspector`: parsers `.m3u8` (HLS), `.mpd` (DASH) e CDN direta com seleção de resolução (`1080p`, `720p`, `480p`, `360p`).
  - `QueueAndChunkManager` & `BandwidthLimiter`: downloads concorrentes com Token Bucket global, retry com backoff exponencial e checkpointing por segmento.
  - `DecryptionAndRemuxer`: decifração AES-128 autorizada, remuxing via `ffmpeg` (`-c copy -movflags +faststart -threads 1`) com prioridade reduzida (`PRIORITY_BELOW_NORMAL`), marca d'água de titularidade nos metadados MP4 e promoção atômica para `/{Nome_Curso}/{Modulo_XX}/{Aula_YY - Titulo}.mp4`.
- **Antigravity Secure Vault (`src/main/vault`):** Banco SQLite (`node:sqlite` em modo `WAL`) e armazenamento de segredos `AES-256-GCM` protegido pelo cofre nativo do SO (`safeStorage`) com assinatura HMAC-SHA256 vinculada à máquina local.

---

## Pré-requisitos

- **Node.js** `>= 22` (testado com `v24.18.0`)
- **pnpm** (testado com `11.18.0`)
- **FFmpeg / FFprobe** disponíveis no `PATH` do sistema operacional (testado com `ffmpeg 9.0.2`)

---

## Comandos

```bash
# Instalar dependências
pnpm install

# Verificar tipagem (main + renderer)
pnpm run typecheck

# Compilar build de produção (dist/main e dist/renderer)
pnpm run build

# Executar aplicação desktop Electron (ou use "Abrir Nano Video Downloader.bat" no Windows)
pnpm start

# Executar suíte completa de testes automatizados (unitários, integração, benchmark e E2E offline)
pnpm test
```

---

## Estrutura de Pastas

```text
├── docs/                  # PRD, SPEC, SDD e TASKS
├── src/
│   ├── shared/            # Tipos compartilhados e sanitizador de caminhos (RF-11)
│   ├── main/              # Runtime Electron, Vault SQLite, WebBridge, Adaptadores, Queue e Remuxer
│   └── renderer/          # Interface React e Player Offline Nativo
├── tests/                 # Suíte Vitest (unitários, queda no seg. 145/300, benchmark 15m 1080p e E2E Electron)
└── package.json
```

