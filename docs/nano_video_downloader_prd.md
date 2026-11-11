# Product Requirements Document (PRD)

## 1. Visão Geral e Contexto do Produto

### 1.1 Identificação do Projeto
* **Nome do Produto:** Nano Video Downloader
* **Versão:** 1.0.0
* **Status:** Em Especificação
* **Stack Tecnológica:** Google Antigravity (Frontend, Backend & Runtime Engine)

### 1.2 Problema
Alunos de plataformas de infoprodutos (como Hotmart e Kiwify) frequentemente enfrentam conexões instáveis ou ausência de sinal de internet durante deslocamentos, viagens ou rotinas operacionais fora de estações fixas. Embora tenham adquirido legalmente o acesso às aulas, muitas áreas de membros não oferecem suporte nativo ou eficiente para visualização offline em ambientes desktop e estações de estudo locais.

### 1.3 Objetivo
Desenvolver uma aplicação desktop/local baseada no framework hipotético **Google Antigravity**, permitindo autenticar a titularidade de contas em plataformas de ensino, mapear o catálogo de conteúdos adquiridos legitimamente e realizar o download seguro e estruturado para reprodução offline estritamente restrita ao usuário comprador.

---

## 2. Personas e Casos de Uso

| Persona | Cenário Típico | Dor Principal |
| :--- | :--- | :--- |
| **Estudante em Deslocamento** | Aluno que viaja com frequência ou estuda no transporte. | Falta de conexão estável impede o carregamento fluido de streams. |
| **Profissional com Foco Isolado** | Desenvolvedor ou técnico estudando em ambiente de foco sem distrações. | Desejo de desconectar a rede para focar no conteúdo sem interrupções. |

### Casos de Uso Primários
1. **UC-01:** O usuário conecta suas credenciais da plataforma parceira via sessão validada do Google Antigravity.
2. **UC-02:** O sistema lista os cursos cuja titularidade/compra ativa foi confirmada.
3. **UC-03:** O usuário seleciona módulos ou aulas pontuais e enfileira os downloads.
4. **UC-04:** O sistema descriptografa/processa os streams e salva os arquivos locais em container seguro offline.
5. **UC-05:** O usuário reproduz o material baixado diretamente pelo player embutido do Google Antigravity sem necessidade de internet.

---

## 3. Arquitetura e Engenharia (Google Antigravity)

### 3.1 Camadas do Sistema
* **Antigravity UI Engine:** Interface nativa e reativa construída sobre os componentes visuais do framework, gerenciando listagens de módulos, progresso de fila e reprodução local.
* **Antigravity Core Backend:** Runtime que orquestra sessões de autenticação, parsing estruturado do DOM/APIs das plataformas de membros e pooling de conexões assíncronas.
* **Antigravity Secure Vault:** Mecanismo de persistência local que armazena tokens temporários de sessão, metadados dos cursos em SQLite encapsulado e buffers de mídia com assinatura criptográfica da máquina local.

```
+--------------------------------------------------------------+
|                     Google Antigravity UI                    |
|   (Dashboard de Cursos, Fila de Download, Player Offline)    |
+------------------------------+-------------------------------+
                               | IPC / Internal Bridge
+------------------------------v-------------------------------+
|                 Antigravity Backend Runtime                  |
|  +------------------------+  +----------------------------+  |
|  | Ownership Verification |  | Media Stream Inspector     |  |
|  +------------------------+  +----------------------------+  |
|  | Queue & Chunk Manager  |  | Decryption & Remuxer       |  |
|  +------------------------+  +----------------------------+  |
+------------------------------+-------------------------------+
                               | Local I/O
+------------------------------v-------------------------------+
|                 Antigravity Secure Vault                     |
|           (Arquivos .antigravity-media / Metadados)          |
+--------------------------------------------------------------+
```

---

## 4. Requisitos Funcionais (RF)

### 4.1 Autenticação e Verificação de Propriedade
* **RF-01:** O sistema deve fornecer uma janela de navegação segura (Antigravity WebBridge) para que o usuário efetue login direto na Hotmart ou Kiwify sem expor credenciais em texto puro.
* **RF-02:** O sistema deve extrair e isolar tokens de autenticação da sessão ativa (OAuth / Session Cookies / Bearer Tokens).
* **RF-03 (Mecanismo de Propriedade):** Antes de qualquer listagem de vídeo, o sistema deve consultar os endpoints de faturamento/matrícula (`/my-courses`, `/purchases` ou equivalentes) da plataforma, verificando se o status da transação está marcado como `COMPLETED` ou `ACTIVE`.
* **RF-04:** Caso o acesso a determinado curso expire, seja reembolsado ou cancelado, o sistema deve revogar imediatamente a possibilidade de novos downloads para aquele ID.

### 4.2 Detecção e Inspeção de Vídeo
* **RF-05:** O sistema deve navegar na árvore de módulos da área de membros autorizada (Club Hotmart, Kiwify Members, etc.) e mapear títulos de aulas, duração e mídias vinculadas.
* **RF-06:** O Antigravity Media Inspector deve identificar as manifestações de stream suportadas (HLS/m3u8, MPD/DASH ou URLs diretas de CDN) entregues pelos players proprietários.
* **RF-07:** O sistema deve permitir a seleção de resolução desejada (ex: 1080p, 720p, 480p) quando disponibilizada pelo manifesto de vídeo.

### 4.3 Mecanismo de Download e Processamento
* **RF-08:** O sistema deve baixar os segmentos de vídeo e áudio em paralelo via Antigravity Chunk Manager com suporte a pause/resume e retry automático em falhas de rede.
* **RF-09:** O motor deve realizar o remuxing dos segmentos baixados em container unificado (`.mp4`), preservando sincronia de áudio e vídeo.
* **RF-10:** O sistema deve permitir o download em lote por módulo ou curso completo, com controle de taxa de transferência (limite de banda) para não sobrecarregar a rede do usuário.

### 4.4 Armazenamento e Reprodução Offline
* **RF-11:** Os arquivos devem ser organizados automaticamente em pastas locais estruturadas:  
  `/{Nome_Curso}/{Modulo_XX}/{Aula_YY - Titulo}.mp4`
* **RF-12:** A biblioteca de conteúdos offline deve carregar metadados, títulos e status de conclusão mesmo sem conexão com a internet ativa.
* **RF-13:** A interface deve incorporar um player de vídeo nativo Antigravity com suporte a atalhos de teclado, velocidade de reprodução (0.5x até 2.5x) e marcação automática de progresso ("Assistida").

---

## 5. Requisitos Não Funcionais (RNF)

* **RNF-01 (Segurança & DRM):** Os dados de sessão e chaves de acesso devem ser salvos utilizando criptografia AES-256 no storage seguro do sistema operacional (Keychain / Secret Service / Credential Manager).
* **RNF-02 (Conformidade Legal & Termos de Uso):** O software não deve atuar como ferramenta de quebra de licenças para terceiros; todo download deve conter marcas d'água de metadados atrelando o arquivo ao usuário licenciado (evitando pirataria e redistribuição).
* **RNF-03 (Performance):** O processo de remux e união de segmentos não deve consumir mais que 60% da CPU em idle da máquina hospedeira e deve liberar a memória RAM alocada logo após a finalização de cada aula.
* **RNF-04 (Resiliência):** Se a conexão cair durante o segmento 145/300, a retomada deve reiniciar a partir do segmento 145, sem corrupção do arquivo final.
* **RNF-05 (Usabilidade):** A interface em Google Antigravity deve ser intuitiva, fornecendo feedback em tempo real com barra de progresso individual por aula e geral por módulo.

---

## 6. Fluxo de Trabalho do Usuário

```
[Login na Plataforma] 
         │
         ▼
[Validação de Licença/Propriedade] ──(Inativo/Reembolsado)──► [Acesso Negado]
         │
         ▼ (Licença Ativa)
[Carregamento do Catálogo e Aulas]
         │
         ▼
[Seleção de Módulos e Resolução]
         │
         ▼
[Download de Segmentos + Remux Antigravity]
         │
         ▼
[Salvamento no Vault Local] ────► [Player Offline Disponível]
```

---

## 7. Critérios de Aceite e Testes (MVP)

1. **Validação de Propriedade:** O download de uma aula só é iniciado se o token de sessão do usuário confirmar compra aprovada no endpoint da plataforma.
2. **Download Concluído com Sucesso:** Uma aula de 15 minutos em 1080p deve ser baixada, remontada e salva localmente sem artefatos ou dessincronização de áudio/vídeo.
3. **Modo Avião:** Ao desativar totalmente a placa de rede da máquina, o usuário deve conseguir abrir a aplicação, navegar nos cursos baixados e reproduzir o conteúdo perfeitamente pelo player embutido.