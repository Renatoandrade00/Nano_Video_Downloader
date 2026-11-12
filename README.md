# Nano Video Downloader

Aplicação desktop offline-first construída com arquitetura **Google Antigravity** (**Electron + TypeScript + React + SQLite + FFmpeg**) para autenticação legítima em plataformas de ensino (Hotmart e Kiwify), validação de titularidade, download segmentado resiliente e reprodução offline em player nativo embutido.

---

> [!WARNING]
> ## ⚖️ AVISO LEGAL E TERMO DE RESPONSABILIDADE (DISCLAIMER)
>
> 1. **Finalidade Estritamente Pessoal e Educacional:** O **Nano Video Downloader** foi desenvolvido como uma ferramenta de utilidade estritamente pessoal para arquivamento, consulta e estudo offline de cursos e materiais educacionais que o **próprio usuário adquiriu de forma legítima** junto às respectivas plataformas de ensino.
> 2. **Infração de Direitos Autorais e Pirataria:** É expressamente vedado o uso deste software para copiar, reproduzir, distribuir, redistribuir, vender, revender, alugar, compartilhar publicamente (via torrent, Google Drive, Telegram, Mega ou qualquer outro meio) materiais de terceiros sem autorização prévia e expressa do titular dos direitos patrimoniais e autorais. A violação de direitos autorais constitui infração civil e **CRIME tipificado no Art. 184 do Código Penal Brasileiro** (Pena: detenção ou reclusão de até 4 anos e multa), bem como tratados e convenções internacionais de proteção aos direitos autorais (Convenção de Berna e DMCA).
> 3. **Responsabilidade Exclusiva do Usuário:** O usuário assume **total, única e exclusiva responsabilidade cível, criminal e regulatória** por todas as suas ações, omissões e usos praticados através do software. Os desenvolvedores, colaboradores e mantenedores do projeto **NÃO** incentivam, apoiam ou compactuam com práticas de pirataria e **NÃO** se responsabilizam por eventuais penalidades, bloqueios de contas pelas plataformas terceiras ou ações judiciais movidas contra usuários que violem os termos de serviço ou a legislação aplicável.

---

## 🚀 Métodos de Instalação e Execução

O **Nano Video Downloader** pode ser instalado e executado de duas maneiras:

### Opção 1: Instalador Oficial para Windows (Recomendado para Usuários)

Esta é a opção mais simples e rápida. **Não requer** a instalação de Node.js, Antigravity, Git ou ferramentas de linha de comando.

1. **Baixar o Instalador:**
   - Faça o download do arquivo executável disponível na pasta [`release/`](./release/) do repositório:
     - 📥 **`Nano Video Downloader Setup 1.0.0.exe`**
2. **Executar a Instalação:**
   - Dê um duplo clique no executável `Nano Video Downloader Setup 1.0.0.exe`.
   - Caso o Windows SmartScreen exiba um aviso de segurança por ser um executável recente, clique em **"Mais informações"** e em seguida em **"Executar assim mesmo"**.
   - O assistente de instalação (NSIS) configurará o aplicativo automaticamente.
3. **Pronto para Usar:**
   - Um atalho **"Nano Video Downloader"** será criado na sua **Área de Trabalho** e no **Menu Iniciar**.
   - O binário do **FFmpeg já vem embutido** no instalador, portanto você não precisa instalar codecs nem dependências adicionais.

---

### Opção 2: Modo Desenvolvedor / Linha de Comando (Código-Fonte)

Indicado para desenvolvedores que desejam inspecionar o código, executar testes automatizados ou compilar novas versões.

#### Pré-requisitos
- **Node.js** `>= 22` (recomendado v22 ou superior)
- **pnpm** (gerenciador de pacotes)
- **Git** e **Git LFS** instalados no sistema
- **FFmpeg / FFprobe** disponíveis no `PATH` do sistema ou na pasta `bin/`

#### Passos para Execução:

1. **Clonar o Repositório:**
   ```bash
   git clone https://github.com/Renatoandrade00/Nano_Video_Downloader.git
   cd "Nano_Video_Downloader"
   ```

2. **Instalar as Dependências:**
   ```bash
   pnpm install
   ```

3. **Verificar Tipagem e Compilar:**
   ```bash
   pnpm run typecheck
   pnpm run build
   ```

4. **Executar a Aplicação:**
   ```bash
   pnpm start
   ```
   *No Windows, você também pode simplesmente dar duplo clique no script auxiliar [`Abrir Nano Video Downloader.bat`](./Abrir%20Nano%20Video%20Downloader.bat).*

5. **Executar a Suíte de Testes Automatizados:**
   ```bash
   pnpm test
   ```

6. **Gerar um Novo Instalador do Windows (`.exe`):**
   ```bash
   pnpm run dist
   ```
   O instalador gerado será salvo no diretório `release/`.

---

## 🌟 Principais Funcionalidades

- **Autenticação Segura em Plataformas de Ensino:** Suporte a Hotmart (incluindo Hotmart Club OIDC) e Kiwify, com isolamento de sessão em janelas dedicadas (`WebBridge`).
- **Validação de Titularidade (Ownership):** Verificação prévia de status ativo/aprovado (`COMPLETED`, `ACTIVE`, `APROVADO`, `PAGO`).
- **Fila Sequencial com Proteção Anti-Bloqueio:** Downloads executados estritamente **1 vídeo por vez** (com limite de 3 conexões paralelas por vídeo), evitando sobrecarga de conexões e bloqueios de IP pela plataforma.
- **Limpeza Rápida de Erros:** Botão dedicado **"Limpar Erros"** na aba de Fila para descartar jobs falhos com um clique, mantendo apenas downloads ativos e pendentes.
- **Reconciliação Automática de Biblioteca:** Ao reiniciar ou abrir o aplicativo, o catálogo online detecta e reconcilia automaticamente no disco os vídeos já baixados em sessões anteriores, marcando-os em verde como `Baixada`.
- **Remuxing Otimizado & Metadados de Auditoria:** Remuxing local de HLS/DASH para MP4 com `faststart` (moov atom no início), prioridade de CPU balanceada e metadados de auditoria.
- **Player Offline Nativo Integrado:** Reprodução imediata sem internet, com seletor de velocidade (`0.5x` a `2.5x`), atalhos de teclado (espaço, setas, F para tela cheia) e marcação automática como "Assistida" ao atingir 90% da aula.
- **Cofre Seguro Criptografado (Vault):** Armazenamento local SQLite com `node:sqlite` em modo WAL e segredos cifrados via `AES-256-GCM` com a API nativa do sistema operacional (`safeStorage`).

---

## 📁 Estrutura do Repositório

```text
├── docs/                             # PRD, SPEC, SDD e TASKS
├── release/                          # Instalador executável oficial do Windows (.exe) e metadados
├── src/
│   ├── shared/                       # Tipos compartilhados e sanitizador de caminhos de arquivos
│   ├── main/                         # Backend Electron, SQLite Vault, WebBridge, Queue e Remuxer
│   └── renderer/                     # Interface React, abas Catálogo, Fila, Contas e Player Nativo
├── tests/                            # Testes automatizados (unitários, integração e E2E)
├── Abrir Nano Video Downloader.bat   # Script rápido para inicialização em ambiente dev
├── electron-builder.json             # Configuração de empacotamento NSIS
└── package.json
```

---

## 📖 Documentação Completa

- [PRD — Product Requirements Document](./docs/nano_video_downloader_prd.md)
- [SPEC — Especificação Técnica do Sistema](./docs/nano_video_downloader_spec.md)
- [SDD — Software Design Document](./docs/nano_video_downloader_sdd.md)
- [TASKS — Roadmap e Lista de Tarefas](./docs/TASKS.md)

---

## 📄 Licença

Este projeto é disponibilizado sob a **Licença de Uso Pessoal, Educacional e Não Comercial**, desenvolvida por **Renato Andrade — Nano S Tecnologia** ([nanostecnologia.com.br](https://nanostecnologia.com.br)).

É permitida a utilização, estudo, modificação e redistribuição **estritamente gratuita**. É terminantemente **proibida qualquer comercialização, venda de cópias ou cobrança de acesso** pelo software ou por obras derivadas.

Consulte o arquivo [`LICENSE`](./LICENSE) para visualizar os termos completos.
