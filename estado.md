# Estado do Projeto — Nano Video Downloader
*Documento vivo de arquitetura, histórico de melhorias, decisões técnicas e memória de contexto.*

---

## 1. Visão Geral do Sistema

O **Nano Video Downloader** é uma aplicação desktop offline-first desenvolvida em **Electron + React 19 + TypeScript + Vite**, baseada nos princípios de conformidade estrita da arquitetura Google Antigravity. A ferramenta destina-se a estudantes e profissionais que adquiriram cursos legitimamente em plataformas como **Hotmart** e **Kiwify**, permitindo o estudo offline com organização automática de vídeos e materiais complementares em PDF.

### Premissas e Diretrizes Fundamentais
- **Legitimidade & DRM:** O software **nunca** burla nem quebra sistemas de criptografia Widevine/FairPlay/PlayReady (DRM). Ele consome streams e arquivos acessíveis ao usuário com titularidade ativa e verificada.
- **Segurança de Credenciais:** As credenciais nunca são gravadas em texto puro; tokens e sessões são cifrados com AES-256-GCM via DPAPI nativa do Windows (`safeStorage`).
- **Marca D'Água Forense:** Vídeos remuxados recebem carimbo de auditoria forense invisível/visível vinculado ao ID do usuário para desencorajar pirataria e vazamentos.

---

## 2. Arquitetura Técnica

```
┌────────────────────────────────────────────────────────┐
│               Renderer Process (React 19)              │
│  - CatalogView (Módulos, Aulas, Materiais PDF)         │
│  - OfflineLibrary (Player offline e progresso)          │
│  - QueueView (Fila sequencial de downloads)             │
│  - AccountsView (WebBridge login & cofre seguro)       │
└───────────────────────────▲────────────────────────────┘
                            │ IPC Bridge (contextBridge)
┌───────────────────────────▼────────────────────────────┐
│                  Main Process (Electron)                │
│  ├─ AuthManager & WebBridge (Sessão isolada Chromium)   │
│  ├─ VaultDatabase (SQLite nativo via node:sqlite)       │
│  ├─ OwnershipVerifier (Validação de licenças ativas)    │
│  ├─ Live Session Adapters (Hotmart & Kiwify)            │
│  ├─ QueueAndChunkManager (Downloads e Token Bucket)     │
│  └─ DecryptionAndRemuxer (FFmpeg integrado)             │
└────────────────────────────────────────────────────────┘
```

---

## 3. Histórico de Mudanças e Melhorias

### Fase 1: Fundação do MVP e Engine de Download de Vídeo
- **Banco de Dados Local (`library.db`):** Criação do schema inicial SQLite (`accounts`, `courses`, `modules`, `lessons`, `download_jobs`, `segment_checkpoints`, `audit_watermarks`, `playback_progress`).
- **Motor de Download HLS/DASH:** Download segmentado com retomada inteligente de checkpoints, token bucket para limitação de banda e remuxing final via FFmpeg.
- **Player Offline Integrado:** Protocolo customizado `antigravity-media://` para streaming local seguro com suporte a busca de posição (HTTP 206 Partial Content).

### Fase 2: Conectividade Live Session Hotmart Club
- **WebBridge Isolado:** Captura de credenciais diretamente do fluxo web sem que o app acesse dados sensíveis de pagamento.
- **Mapeamento de Clubes:** Resolução automática de URLs numéricas de cursos (ex. produto `8792144`) para seus respectivos domínios no Hotmart Club (ex. `mike-school`).
- **Tratamento de Redirecionamentos OIDC:** Tolerância a redirects `ERR_ABORTED (-3)` que ocorrem durante o handshake de autenticação da Hotmart.
- **Status Localizados:** Suporte a termos em português e espanhol (*Aprovado*, *Ativo*, *Pago*) no verificador de titularidade.

### Fase 3: Empacotamento e Distribuição
- **Instalador Standalone NSIS:** Configuração do `electron-builder` para gerar executáveis portáteis e instaladores com atalhos na Área de Trabalho e Menu Iniciar.
- **FFmpeg Bundled:** Inclusão nativa do binário `ffmpeg.exe` dentro do instalador, eliminando a dependência de instalações externas pelo usuário.
- **Licenciamento:** Licença não-comercial gratuita atribuída a Renato Andrade — Nano S Tecnologia.

### Fase 4: Suporte Completo a Materiais Complementares (.PDF)
*Esta fase adicionou o suporte ao download e gerenciamento de arquivos de apoio disponibilizados pelos instrutores.*

#### 4.1. Banco de Dados e Armazenamento Estruturado
- Adição da tabela `lesson_attachments` ao SQLite nativo:
  - Campos: `id`, `lesson_id`, `external_attachment_id`, `file_name`, `file_url`, `file_type`, `file_size`, `local_file_path`.
- Criação dos métodos `upsertLessonAttachment`, `getLessonAttachments`, `getAttachment` e `updateAttachmentLocalPath`.
- Estruturação automática de diretórios:
  - Caminho: `/{Nome_Curso}/{Modulo_XX}/Materiais/Aula_YY - {Nome_Arquivo}.pdf`.
  - Sanitização de caracteres proibidos em sistemas Windows/Linux.

#### 4.2. Interface Visual no Catálogo (`CatalogView.tsx`)
- **Seletor de Download:** Checkbox `[x] Vídeos` e `[x] Arquivos (.pdf)` no topo da página.
- **Busca por Módulo:** Botão `[ 📄 Buscar PDFs do Módulo ]` no cabeçalho de cada módulo, com feedback em tempo real.
- **Busca por Aula:** Botão individual `[ 🔍 Buscar Material ]` na linha de aulas sem anexos prévios.
- **Card Visual de Anexos:**
  - Exibição destacada com ícone de PDF, nome completo do arquivo e tamanho formatado (`KB` / `MB`).
  - Botão de Ação Direta: `[ 📥 Baixar PDF ]` (se não baixado) e `[ 📂 Abrir PDF ]` (abre no leitor padrão do Windows via `shell.openPath`).

#### 4.3. Superação dos Desafios Técnicos do Hotmart Club (Next.js)
1. **Resolução de SSR / Hydration (`__NEXT_DATA__`):** O Hotmart Club utiliza Next.js com injeção de estado no HTML inicial. O extrator passou a inspecionar tags `<script id="__NEXT_DATA__">` e scripts JSON embutidos, recuperando anexos sem depender de chamadas XHR redundantes.
2. **Desativação de Background Throttling:** Janelas ocultas do Chromium (`show: false`) suspendiam a execução de timers JavaScript do React. Foi adicionado `backgroundThrottling: false` e `setBackgroundThrottling(false)`, garantindo hidratação instantânea.
3. **Interceptação Nativa de Downloads (`will-download`):** O Electron agora intercepta o evento nativo `webSession.on('will-download')` e cliques em popups (`setWindowOpenHandler`), capturando a URL direta assinada pelo CloudFront/S3 no instante do clique no botão `"Download"`.
4. **Tratamento de Endpoints Assinados:** Se a URL do anexo for um endpoint de metadados (`/download-url`), o motor de download resolve automaticamente a URL assinada final e grava o arquivo com verificação de integridade.
5. **Transparência de Sessão:** O crawler não mascara mais erros de autenticação. Se a sessão SSO da Hotmart expirar, o usuário é notificado diretamente para revalidar a conta em *Contas & Cofre*.

---

## 4. Matriz de Estado dos Componentes

| Componente | Arquivo Principal | Estado | Descrição |
|---|---|---|---|
| **Cofre & Chaves** | `src/main/vault/secretStore.ts` | ✅ Estável | Criptografia DPAPI nativa com chaves de 32 bytes |
| **Banco de Dados** | `src/main/vault/database.ts` | ✅ Estável | SQLite nativo (`node:sqlite`) com reconciliação de disco |
| **Sanitizador de Paths** | `src/shared/pathSanitizer.ts` | ✅ Estável | Formatação de pastas para vídeos e materiais PDF |
| **Fila de Downloads** | `src/main/queue/queueManager.ts` | ✅ Estável | Fila sequencial (1 por vez) para vídeos e PDFs |
| **Live Hotmart Session**| `src/main/adapters/hotmartLiveSession.ts` | ✅ Estável | Mapeamento Club, Next.js hydration, `will-download` |
| **WebBridge Login** | `src/main/auth/webBridge.ts` | ✅ Estável | Janela Chromium isolada com captura de sessão |
| **Catálogo na UI** | `src/renderer/components/CatalogView.tsx` | ✅ Estável | Árvore de cursos com busca e download de PDFs |
| **Player de Mídia** | `src/renderer/components/OfflineLibrary.tsx` | ✅ Estável | Player HTML5 offline com carimbo d'água forense |

---

## 5. Gotchas e Decisões Críticas de Engenharia

> [!IMPORTANT]
> **Janelas Ocultas no Electron e Frameworks Modernos (React/Next.js):**
> Nunca crie janelas com `show: false` sem configurar explicitamente `backgroundThrottling: false`. Do contrário, os timers do React 18/19 entram em estado de espera infinito e o DOM nunca é hidratado.

> [!NOTE]
> **Links de Download Efêmeros da Hotmart:**
> Na Hotmart Club, os botões de download de materiais frequentemente não expõem a URL no atributo `href`. O método mais confiável de captura é ouvir o evento de nível de sistema `webSession.on('will-download')` durante o disparo do clique no botão.

> [!TIP]
> **Aulas sem Vídeo (`NO_VIDEO`):**
> Aulas compostas exclusivamente por texto e materiais em PDF devem ter o status `AVAILABLE` quando houver anexos detectados, permitindo o enfileiramento e download do material mesmo sem mídia audiovisual.

---

## 6. Próximos Passos e Backlog

- [ ] Suporte a download de materiais complementares também para a plataforma Kiwify.
- [ ] Indicador de progresso percentual individual para downloads de arquivos grandes em PDF/ZIP.
- [ ] Exportação de relatórios de aulas assistidas e materiais baixados em formato CSV/Markdown.
- [ ] Opção de auto-sincronização periódica da biblioteca offline ao iniciar a aplicação.
