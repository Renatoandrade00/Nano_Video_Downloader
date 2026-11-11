# Especificação Técnica do Sistema (SPEC) — Nano Video Downloader

**Documento de Origem:** [nano_video_downloader_prd.md](./nano_video_downloader_prd.md)  
**Produto:** Nano Video Downloader  
**Versão:** 1.0.0  
**Status:** Especificação Aprovada para Design e Implementação  
**Stack Base:** Google Antigravity (Frontend, Backend & Runtime Engine)

---

## 1. Introdução e Escopo

### 1.1 Propósito
Este documento estabelece a especificação funcional, técnica, operacional e de verificação do **Nano Video Downloader**, uma aplicação desktop local construída sobre o framework **Google Antigravity**. O objetivo do sistema é permitir que alunos legítimos de plataformas de infoprodutos (inicialmente **Hotmart** e **Kiwify**) autentiquem sua titularidade, sincronizem o catálogo de cursos adquiridos e realizem o download estruturado para reprodução estritamente offline.

### 1.2 Premissas de Escopo e Limites
* **Uso Estritamente Pessoal e Legítimo:** O sistema opera exclusivamente mediante sessão autenticada do usuário comprador e validação prévia de compra ativa/concluída na plataforma de origem.
* **Proibição de Evasão de Licenças:** O software não implementa mecanismos de quebra de proteção para conteúdo não adquirido ou de terceiros (RNF-02).
* **Execução Local:** Todo o processamento (inspeção de manifestos, download de segmentos, remuxing e persistência) ocorre localmente na máquina do usuário, sem servidor intermediário na nuvem.

### 1.3 Glossário
| Termo | Definição |
| :--- | :--- |
| **Google Antigravity** | Framework hipotético full-stack desktop responsável pela UI Engine, Backend Runtime, WebBridge e Secure Vault. |
| **Antigravity WebBridge** | Componente de navegação embarcada isolada para autenticação direta nas plataformas parceiras sem captura de senha em texto plano. |
| **Antigravity Media Inspector** | Módulo responsável por analisar manifestos de vídeo (HLS/m3u8, DASH/mpd) ou URLs diretas de CDN e extrair trilhas de vídeo e áudio. |
| **Antigravity Chunk Manager** | Orquestrador de downloads paralelos de segmentos com suporte a pausa, retomada por índice de segmento, retry e limitação de banda. |
| **Antigravity Secure Vault** | Camada de persistência local composta por SQLite encapsulado, armazenamento seguro do SO e buffers `.antigravity-media` assinados localmente. |
| **Remuxing** | Empacotamento de fluxos elementares de áudio e vídeo baixados em um único container `.mp4` sem recodificação destrutiva. |

---

## 2. Especificação de Requisitos Funcionais (RF)

### 2.1 Autenticação e Verificação de Propriedade

#### RF-01 — Autenticação Isolada via Antigravity WebBridge
* **Casos de Uso Associados:** UC-01
* **Descrição:** O sistema deve abrir uma janela de navegação segura (`Antigravity WebBridge`) apontando diretamente para o portal oficial de login da plataforma selecionada (Hotmart ou Kiwify).
* **Regras de Negócio:**
  * Nenhuma credencial digitada (e-mail, senha, código 2FA) pode ser interceptada, registrada em log ou persistida em texto plano pelo aplicativo.
  * Cada plataforma deve utilizar um contexto de sessão isolado (partition/profile próprio).
* **Critérios de Entrada:** Usuário seleciona "Conectar Plataforma" e escolhe o provedor (`hotmart` ou `kiwify`).
* **Critérios de Saída:** Sessão autenticada estabelecida ou cancelamento explícito pelo usuário.
* **Exceções:** Timeout de login, fechamento manual da janela pelo usuário ou falha de conectividade exibem estado claro sem corromper sessões anteriores.

#### RF-02 — Extração e Isolamento de Tokens de Sessão
* **Casos de Uso Associados:** UC-01
* **Descrição:** Após conclusão do fluxo no WebBridge, o backend deve extrair exclusivamente os tokens necessários à API da plataforma (`OAuth Access/Refresh Tokens`, `Session Cookies` `HttpOnly` ou `Bearer Tokens`).
* **Regras de Negócio:**
  * Os tokens extraídos são imediatamente encaminhados ao cofre seguro do sistema operacional (RNF-01) e mantidos em memória apenas pelo tempo estritamente necessário às requisições.
  * Ao desconectar uma conta ("Logout"), todos os tokens associados devem ser removidos do cofre do SO e invalidados na memória do runtime.

#### RF-03 — Verificação Obrigatória de Propriedade (Ownership Check)
* **Casos de Uso Associados:** UC-01, UC-02, UC-03
* **Descrição:** Antes de listar conteúdos ou iniciar qualquer download, o sistema deve consultar os endpoints de faturamento/matrícula da plataforma (`/my-courses`, `/purchases` ou equivalentes do adaptador).
* **Regras de Negócio:**
  * Apenas cursos cuja transação/matrícula possua status equivalente a `COMPLETED` ou `ACTIVE` são liberados para listagem de módulos e enfileiramento.
  * A verificação de propriedade deve ser reexecutada: (a) no login/sincronização inicial, (b) ao abrir um curso conectado online e (c) imediatamente antes de iniciar o download de cada aula ou lote.
* **Entradas:** `account_id`, `course_external_id`, token de sessão ativo.
* **Saídas:** Estado booleano de elegibilidade (`AUTHORIZED` | `DENIED`) e status normalizado da licença.

#### RF-04 — Revogação Imediata de Downloads por Expiração ou Reembolso
* **Casos de Uso Associados:** UC-02, UC-03
* **Descrição:** Se a consulta à plataforma retornar status `EXPIRED`, `REFUNDED`, `CANCELED`, `CHARGEBACK` ou ausência de matrícula para um `course_external_id`, o sistema deve bloquear imediatamente qualquer novo download ou retomada online para aquele curso.
* **Regras de Negócio:**
  * Tarefas pendentes ou pausadas na fila pertencentes ao curso revogado devem transicionar automaticamente para o estado `REVOKED` e serem impedidas de retomar tráfego de rede.
  * Arquivos parciais em `.antigravity-media` de um download revogado antes da conclusão devem ser descartados de forma segura.

---

### 2.2 Detecção e Inspeção de Vídeo

#### RF-05 — Mapeamento da Árvore de Módulos e Aulas
* **Casos de Uso Associados:** UC-02
* **Descrição:** Para cursos com titularidade confirmada, o sistema deve navegar na árvore estrutural da área de membros (ex.: Club Hotmart, Kiwify Members) e catalogar módulos, ordem sequencial, títulos, duração estimada e identificadores de mídia.
* **Saídas:** Estrutura hierárquica persistida no SQLite local (`Curso -> Módulos -> Aulas`).
* **Exceções:** Aulas puramente textuais, anexos não-vídeo ou aulas bloqueadas por liberação programada (drip content) devem ser sinalizadas claramente na UI como indisponíveis para download de vídeo (ex.: status `LOCKED_DRIP` ou `NO_VIDEO`).

#### RF-06 — Inspeção de Manifestos de Stream
* **Casos de Uso Associados:** UC-03, UC-04
* **Descrição:** O `Antigravity Media Inspector` deve identificar e parsear as fontes de mídia retornadas pelos players da área de membros:
  * **HLS:** Manifestos `.m3u8` (Master Playlist e Media Playlists, com fluxos muxados ou áudio/vídeo separados via `#EXT-X-MEDIA`).
  * **DASH:** Manifestos `.mpd` (AdaptationSets de vídeo e áudio, SegmentTemplate / SegmentList / BaseURL).
  * **CDN Direta:** URLs HTTP(S) progressivas (`.mp4`, `.webm` com suporte a `Accept-Ranges: bytes`).
* **Regras de Negócio:**
  * URLs assinadas temporárias (Signed URLs) expiradas durante uma fila longa devem ser renovadas automaticamente via nova consulta autenticada da aula antes da retomada do chunk.

#### RF-07 — Seleção de Resolução de Vídeo
* **Casos de Uso Associados:** UC-03
* **Descrição:** O usuário deve poder selecionar a resolução desejada dentre as variações expostas no manifesto (ex.: `1080p`, `720p`, `480p`, `360p`) por aula, por lote ou como preferência padrão global.
* **Regras de Negócio:**
  * Caso a resolução preferida não exista para uma aula específica, o sistema deve aplicar fallback configurável (padrão: maior resolução disponível igual ou inferior à preferida; se não houver inferior, a menor disponível).

---

### 2.3 Mecanismo de Download e Processamento

#### RF-08 — Download Paralelo de Segmentos com Pausa, Retomada e Retry
* **Casos de Uso Associados:** UC-03, UC-04
* **Descrição:** O `Antigravity Chunk Manager` deve baixar os segmentos de vídeo e áudio de forma concorrente, registrando a conclusão atômica de cada segmento.
* **Regras de Negócio:**
  * Concorrência configurável por tarefa (padrão recomendado: 4 conexões simultâneas por aula, teto máximo de 8).
  * Suporte completo a `Pause`, `Resume` e `Cancel` por aula individual ou fila inteira.
  * Em falhas transitórias de rede (HTTP 429, 5xx, timeout, queda de socket), aplicar retry automático com backoff exponencial + jitter (ex.: 1s, 2s, 4s, 8s, 16s; máximo configurável de 5 tentativas por segmento antes de pausar a tarefa com erro recuperável).

#### RF-09 — Remuxing para Container MP4 Unificado
* **Casos de Uso Associados:** UC-04
* **Descrição:** Após a conclusão de todos os segmentos de vídeo e áudio da aula, o módulo `Decryption & Remuxer` deve montar os fluxos em um arquivo `.mp4` (ISO Base Media File Format) válido e reproduzível.
* **Regras de Negócio:**
  * O remuxing deve preservar os timestamps originais (PTS/DTS) garantindo sincronia labial/áudio-vídeo sem drift.
  * Deve operar preferencialmente por cópia de stream (stream copy / remux puro) sem transcodificação, garantindo fidelidade de qualidade e baixo consumo de CPU (RNF-03).
  * Se o stream possuir encriptação de transporte autorizada pela sessão (ex.: HLS AES-128 com chave acessível via sessão válida do aluno), o processamento ocorre em buffer seguro durante o pipeline antes do remux.

#### RF-10 — Download em Lote e Controle de Banda (Throttling)
* **Casos de Uso Associados:** UC-03
* **Descrição:** O usuário pode enfileirar aulas individuais, módulos inteiros ou um curso completo em uma única ação, bem como definir um limite global de largura de banda (em KB/s ou MB/s, ou `Ilimitado`).
* **Regras de Negócio:**
  * Alterações no limite de banda devem surtir efeito em até 1 segundo sobre os downloads em andamento, sem reiniciar segmentos já iniciados.

---

### 2.4 Armazenamento e Reprodução Offline

#### RF-11 — Organização Estruturada em Pastas Locais
* **Casos de Uso Associados:** UC-04, UC-05
* **Descrição:** Cada aula finalizada deve ser gravada seguindo estritamente o padrão de caminho relativo à biblioteca configurada:
  `/{Nome_Curso}/{Modulo_XX}/{Aula_YY - Titulo}.mp4`
* **Regras de Sanitização e Formatação:**
  * `XX` e `YY` devem possuir zero à esquerda com no mínimo 2 dígitos (`01`, `02`, ..., `99`, `100`).
  * Caracteres inválidos para sistemas de arquivos Windows/macOS/Linux (`< > : " / \ | ? *` e caracteres de controle) devem ser substituídos ou removidos de forma determinística.
  * Espaços múltiplos e pontos finais à direita devem ser normalizados.
  * O comprimento do caminho completo deve respeitar limites seguros de path (truncando `{Titulo}` de forma elegante preservando a extensão `.mp4`, se necessário).

#### RF-12 — Biblioteca Offline Resiliente à Ausência de Rede
* **Casos de Uso Associados:** UC-05
* **Descrição:** Ao iniciar a aplicação sem conexão com a internet (ex.: Modo Avião), a biblioteca deve carregar integralmente a partir do `Antigravity Secure Vault` (SQLite local), exibindo cursos baixados, módulos, títulos das aulas, duração, resolução e status de conclusão.
* **Regras de Negócio:**
  * A ausência de rede não deve bloquear a inicialização da UI nem exibir modais impeditivos; deve apenas sinalizar modo offline discreto e desabilitar ações que exijam sincronização remota ou novos downloads.

#### RF-13 — Player de Vídeo Embutido Antigravity
* **Casos de Uso Associados:** UC-05
* **Descrição:** A interface deve disponibilizar player nativo integrado para reprodução direta dos arquivos `.mp4` locais.
* **Funcionalidades Obrigatórias:**
  * Play/Pause, barra de seek com preview de tempo, controle de volume/mudo, tela cheia (Fullscreen).
  * Controle de velocidade de reprodução nas faixas: `0.5x`, `0.75x`, `1.0x`, `1.25x`, `1.5x`, `1.75x`, `2.0x`, `2.5x`.
  * Atalhos de teclado padrão: `Espaço` / `K` (Play/Pause), `Seta Esquerda` / `J` (-5s/-10s), `Seta Direita` / `L` (+5s/+10s), `Seta Cima/Baixo` (Volume), `M` (Mudo), `F` (Tela Cheia), `[` / `]` ou `<` / `>` (Velocidade).
  * Persistência automática da última posição reproduzida (`last_position_sec`) a cada 5 segundos e ao pausar/sair.
  * Marcação automática do status **"Assistida"** quando o progresso atingir `>= 90%` da duração total da aula (ou ao atingir o evento de fim de reprodução), permitindo também alternância manual pelo usuário.

---

## 3. Especificação de Requisitos Não Funcionais (RNF)

| ID | Categoria | Requisito Especificado | Métrica / Critério de Verificação |
| :--- | :--- | :--- | :--- |
| **RNF-01** | Segurança & Armazenamento | Tokens de sessão e chaves criptográficas locais devem ser protegidos com **AES-256** utilizando o cofre nativo do sistema operacional (macOS Keychain, Linux Secret Service / libsecret, Windows Credential Manager). Buffers temporários `.antigravity-media` e banco de metadados devem possuir integridade/assinatura vinculada à máquina local. | Inspeção do disco e logs não revela tokens em texto claro; chaves mestras não residem em arquivos `.json`/`.env` desprotegidos. |
| **RNF-02** | Conformidade Legal & Metadados | Todo arquivo `.mp4` gerado deve receber marca d'água lógica nos metadados do container atrelando o arquivo ao titular licenciado (`account_email_hash`, `user_id`, `platform`, `purchase_ref`, `downloaded_at`), desencorajando redistribuição indevida. | Inspeção de átomos/tags MP4 (`ffprobe` / parser MP4) confirma presença íntegra da assinatura do titular em 100% dos vídeos exportados. |
| **RNF-03** | Performance & Memória | O processo de remuxing e união de segmentos não pode ultrapassar **60% de utilização da CPU** em relação à capacidade ociosa da máquina hospedeira, e a memória RAM alocada para buffers de uma aula deve ser liberada imediatamente após sua conclusão. | Monitoramento durante remux de aula 1080p de 15 min mantém uso <= 60% de CPU idle e retorno da memória RSS ao patamar base (< +50 MB delta residual após fim da tarefa). |
| **RNF-04** | Resiliência & Integridade | Interrupções de rede, queda de energia ou fechamento do app durante o segmento `K/N` (ex.: `145/300`) devem preservar o estado exato em checkpoint persistente, retomando exatamente a partir do segmento `145` sem corromper o container `.mp4` final. | Teste automatizado interrompendo conexão no segmento `145/300`: segmentos `1..144` não são rebaixados e arquivo final passa validação de integridade A/V. |
| **RNF-05** | Usabilidade | Interface responsiva e clara no Google Antigravity, exibindo progresso individual por aula (`%`, velocidade atual, ETA, segmentos `K/N`) e progresso agregado por módulo/fila. | Atualização de progresso em UI a cada <= 500ms durante downloads ativos, sem travamentos da thread de renderização. |

---

## 4. Especificação de Conectores de Plataformas e Estados

### 4.1 Contrato Lógico dos Adaptadores
Cada plataforma suportada (`Hotmart`, `Kiwify`) implementa um adaptador padronizado responsável por:
1. Fornecer URL de login e regras de detecção de sessão concluída no `WebBridge`.
2. Consultar titularidade de compras/assinaturas (`/my-courses`, `/purchases` ou endpoints equivalentes da plataforma).
3. Normalizar o status remoto para o enum interno `LicenseStatus`:
   * `ACTIVE` / `COMPLETED` -> `AUTHORIZED`
   * `EXPIRED` / `REFUNDED` / `CANCELED` / `BLOCKED` -> `REVOKED`
4. Obter árvore de módulos/aulas e extrair o descriptor de mídia da aula solicitada.

### 4.2 Política de Validação de Mídia
* O inspetor aceita apenas streams vinculados à sessão autenticada do usuário.
* Em cenários onde a plataforma entregue conteúdo protegido por DRM comercial externo (ex.: Widevine/FairPlay hardware-backed) que impeça leitura legítima fora de CDM proprietário, o sistema **não** deve tentar contornar ou quebrar o DRM (RNF-02); deve informar ao usuário que aquela aula específica não possui formato elegível para download offline autorizado.

---

## 5. Especificação de Interface de Usuário (UI Engine)

### 5.1 Visões Principais
1. **Conexão de Contas:** Cartões das plataformas (Hotmart, Kiwify) com status (`Conectado`, `Sessão Expirada`, `Desconectado`), botão de abertura do WebBridge e ação de desconexão.
2. **Catálogo de Cursos (Online / Híbrido):** Grade/lista de cursos com titularidade validada, capa, plataforma de origem e indicador de sincronização offline.
3. **Detalhes do Curso e Seleção:** Árvore expansível de módulos com checkboxes por aula/módulo, seletor de resolução (`1080p`, `720p`, `480p`), badge de status (`Disponível`, `Na Fila`, `Baixado`, `Assistida`, `Revogado`, `Indisponível`).
4. **Gerenciador de Fila e Transferências:**
   * Barra de progresso agregada da fila/módulo e barras individuais por aula (exibindo `MB/s`, `Segmento 145/300`, `%`).
   * Controles globais: Pausar Tudo, Retomar Tudo, Limite de Banda (`Ilimitado` ou valor customizado).
   * Controles por item: Pausar, Retomar, Cancelar, Reordenar/Priorizar.
5. **Biblioteca Offline & Player:** Navegação idêntica à árvore do curso funcionando 100% sem rede, abrindo o player embutido com histórico de reprodução e indicador visual de aulas assistidas.

---

## 6. Matriz de Rastreabilidade e Critérios de Aceite (MVP)

### 6.1 Matriz de Rastreabilidade
| Caso de Uso | Requisitos Funcionais | Requisitos Não Funcionais | Critério de Aceite MVP |
| :--- | :--- | :--- | :--- |
| **UC-01** Autenticação | RF-01, RF-02, RF-03 | RNF-01 | MVP-01 |
| **UC-02** Listagem de Cursos | RF-03, RF-04, RF-05 | RNF-05 | MVP-01 |
| **UC-03** Enfileiramento e Seleção | RF-03, RF-06, RF-07, RF-08, RF-10 | RNF-04, RNF-05 | MVP-01, MVP-02 |
| **UC-04** Download, Remux e Vault | RF-08, RF-09, RF-11 | RNF-01, RNF-02, RNF-03, RNF-04 | MVP-02 |
| **UC-05** Reprodução Offline | RF-12, RF-13 | RNF-02, RNF-05 | MVP-03 |

### 6.2 Critérios de Aceite Obrigatórios (MVP)
1. **MVP-01 — Validação Estrita de Propriedade:**
   * **Dado** um usuário autenticado via WebBridge, **quando** tentar listar ou iniciar download de um curso, **então** o sistema consulta o endpoint de faturamento/matrícula e só libera o download se o status for `COMPLETED` ou `ACTIVE`.
   * **Dado** um curso cujo status mude para reembolsado/cancelado, **quando** o sistema revalidar a licença, **então** novos downloads ou retomadas daquele curso são imediatamente bloqueados (`REVOKED`).
2. **MVP-02 — Download, Resiliência e Qualidade de Remux (15 min @ 1080p):**
   * **Dado** uma aula de 15 minutos disponível em 1080p (HLS ou DASH), **quando** o download for concluído (inclusive após simular queda de conexão no segmento `145/300` e retomada automática/manual), **então** os segmentos `0..144` são preservados, o remux é concluído sem exceder 60% da CPU idle, a RAM é liberada ao término e o arquivo final `/{Nome_Curso}/{Modulo_XX}/{Aula_YY - Titulo}.mp4` reproduz sem artefatos, sem perda de sincronia A/V e com marca d'água de titularidade nos metadados.
3. **MVP-03 — Operação Completa em Modo Avião:**
   * **Dado** ao menos um curso baixado localmente, **quando** a placa de rede da máquina for totalmente desativada e o aplicativo for encerrado e reaberto, **então** o usuário navega normalmente na biblioteca offline, visualiza módulos/aulas/progresso e reproduz os vídeos no player embutido com controles de velocidade (`0.5x`–`2.5x`), atalhos de teclado e marcação automática de "Assistida".

