import fs from 'fs';
import path from 'path';
import {
  GoogleDriveConfig,
  GoogleDriveSyncEvent,
  GoogleDriveTestResult,
  StorageDriver,
} from '../../shared/types';

export class GoogleDriveService {
  private config: GoogleDriveConfig;
  private onSyncEvent?: (event: GoogleDriveSyncEvent) => void;

  constructor(
    config: GoogleDriveConfig,
    onSyncEvent?: (event: GoogleDriveSyncEvent) => void,
  ) {
    this.config = config;
    this.onSyncEvent = onSyncEvent;
  }

  updateConfig(config: GoogleDriveConfig): void {
    this.config = config;
  }

  /**
   * Extrai o ID da pasta do Google Drive a partir de uma URL ou ID direto
   */
  static extractFolderId(input: string): string | null {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();

    // 1. URL padrão: /drive/folders/{folderId}
    const matchFolder = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/i);
    if (matchFolder) return matchFolder[1];

    // 2. URL de abertura: ?id={folderId}
    const matchId = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/i);
    if (matchId) return matchId[1];

    // 3. ID direto (geralmente entre 15 e 45 caracteres alfanuméricos)
    if (/^[a-zA-Z0-9_-]{15,45}$/.test(trimmed)) {
      return trimmed;
    }

    return null;
  }

  /**
   * Detecta se o Google Drive para Desktop está instalado e mapeado em disco local
   */
  static detectLocalGoogleDrivePath(): string | null {
    try {
      const candidateDrives = ['G:\\', 'H:\\', 'I:\\', 'F:\\'];
      for (const drive of candidateDrives) {
        if (fs.existsSync(drive)) {
          const meuDrive = path.join(drive, 'Meu Drive');
          const myDrive = path.join(drive, 'My Drive');
          const sharedDrives = path.join(drive, 'Drives compartilhados');
          if (fs.existsSync(meuDrive)) return meuDrive;
          if (fs.existsSync(myDrive)) return myDrive;
          if (fs.existsSync(sharedDrives)) return sharedDrives;
          return drive;
        }
      }

      // Pastas no perfil do usuário
      const userProfile = process.env.USERPROFILE || '';
      if (userProfile) {
        const localDrive = path.join(userProfile, 'Google Drive');
        if (fs.existsSync(localDrive)) return localDrive;
      }
    } catch {
      // Ignora erro de acesso a discos
    }
    return null;
  }

  /**
   * Valida a conectividade da pasta informada e o endpoint de upload (se houver)
   */
  async testConnection(
    folderUrl: string,
    uploadEndpoint?: string,
  ): Promise<GoogleDriveTestResult> {
    const folderId = GoogleDriveService.extractFolderId(folderUrl);
    if (!folderId) {
      return {
        ok: false,
        mode: 'public_folder',
        message: 'Link da pasta do Google Drive inválido. Forneça o link completo de compartilhamento.',
      };
    }

    const localDrive = GoogleDriveService.detectLocalGoogleDrivePath();

    // 1. Se foi fornecido o endpoint Webhook do Google Apps Script
    if (uploadEndpoint && uploadEndpoint.startsWith('http')) {
      try {
        const pingRes = await fetch(uploadEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'ping', folderId }),
        });

        if (pingRes.ok) {
          return {
            ok: true,
            folderId,
            mode: 'webhook',
            message: 'Conexão estabelecida com sucesso via Google Apps Script Webhook!',
            localDrivePath: localDrive ?? undefined,
          };
        }
      } catch (err) {
        return {
          ok: false,
          folderId,
          mode: 'webhook',
          message: `Falha ao conectar ao Webhook do Google Drive: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // 2. Se detectar unidade local do Google Drive para Desktop
    if (localDrive) {
      return {
        ok: true,
        folderId,
        mode: 'desktop_sync',
        message: `Google Drive para Desktop detectado em "${localDrive}". Os arquivos serão sincronizados instantaneamente.`,
        localDrivePath: localDrive,
      };
    }

    // 3. Testa acesso público ao link da pasta
    try {
      const res = await fetch(`https://drive.google.com/drive/folders/${folderId}`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (res.status === 200 || res.status === 302) {
        return {
          ok: true,
          folderId,
          mode: 'public_folder',
          message:
            'Pasta compartilhada do Google Drive identificada! Para upload na nuvem sem login com o Google, você pode configurar o Webhook do Google Apps Script ou utilizar o Google Drive para Desktop.',
        };
      }
    } catch {
      // Ignora erro de requisição simples
    }

    return {
      ok: true,
      folderId,
      mode: 'public_folder',
      message: `ID da pasta (${folderId}) reconhecido e pronto para configuração.`,
    };
  }

  /**
   * Sincroniza um arquivo baixado (vídeo ou anexo) para o Google Drive
   */
  async syncFile(params: {
    jobId?: string;
    attachmentId?: string;
    localFilePath: string;
    relativePath: string;
    fileName: string;
    mimeType?: string;
  }): Promise<{ ok: boolean; driveUrl?: string; error?: string }> {
    if (!this.config.enabled) {
      return { ok: false, error: 'GOOGLE_DRIVE_DISABLED' };
    }

    const { jobId, attachmentId, localFilePath, relativePath, fileName } = params;
    const mimeType = params.mimeType || (fileName.endsWith('.pdf') ? 'application/pdf' : 'video/mp4');

    if (!fs.existsSync(localFilePath)) {
      return { ok: false, error: 'LOCAL_FILE_NOT_FOUND' };
    }

    this.emitEvent({
      jobId,
      attachmentId,
      fileName,
      state: 'UPLOADING',
      progressPercent: 0,
    });

    try {
      // Cenário 1: Sincronização via Google Drive para Desktop (localSyncPath ou unidade mapeada)
      const targetDriveDir = this.config.localSyncPath || GoogleDriveService.detectLocalGoogleDrivePath();
      if (targetDriveDir && fs.existsSync(targetDriveDir)) {
        const destFolder = path.join(targetDriveDir, relativePath);
        fs.mkdirSync(destFolder, { recursive: true });
        const destPath = path.join(destFolder, fileName);

        // Copia do local para a pasta monitorada pelo Google Drive
        fs.copyFileSync(localFilePath, destPath);

        const driveUrl = this.config.folderUrl;
        this.emitEvent({
          jobId,
          attachmentId,
          fileName,
          state: 'COMPLETED',
          progressPercent: 100,
          driveUrl,
        });

        return { ok: true, driveUrl };
      }

      // Cenário 2: Upload via Webhook do Google Apps Script (direto na nuvem sem login)
      if (this.config.uploadEndpoint && this.config.uploadEndpoint.startsWith('http')) {
        const fileBuffer = fs.readFileSync(localFilePath);
        const base64Data = fileBuffer.toString('base64');

        this.emitEvent({
          jobId,
          attachmentId,
          fileName,
          state: 'UPLOADING',
          progressPercent: 50,
        });

        const res = await fetch(this.config.uploadEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folderId: this.config.folderId,
            relativePath,
            fileName,
            mimeType,
            base64Data,
          }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} retornado pelo Webhook do Google Drive`);
        }

        const data = (await res.json()) as { ok?: boolean; url?: string; fileId?: string; error?: string };
        if (!data.ok) {
          throw new Error(data.error || 'Erro desconhecido retornado pelo Google Drive Bridge');
        }

        const driveUrl = data.url || `https://drive.google.com/open?id=${data.fileId}`;
        this.emitEvent({
          jobId,
          attachmentId,
          fileName,
          state: 'COMPLETED',
          progressPercent: 100,
          driveUrl,
        });

        return { ok: true, driveUrl };
      }

      // Se nenhum dos métodos diretos estiver configurado, registra aviso amigável
      return {
        ok: false,
        error:
          'Para upload direto no Google Drive, configure o URL do Webhook do Google Apps Script ou instale o Google Drive para Desktop.',
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        jobId,
        attachmentId,
        fileName,
        state: 'FAILED',
        progressPercent: 0,
        error: errMsg,
      });
      return { ok: false, error: errMsg };
    }
  }

  private emitEvent(event: GoogleDriveSyncEvent): void {
    if (this.onSyncEvent) {
      this.onSyncEvent(event);
    }
  }

  /**
   * Retorna o template do Google Apps Script pronto para implantação em 1 clique
   */
  static getScriptTemplate(): string {
    return `// ============================================================================
// NANO S TECNOLOGIA — GOOGLE DRIVE CLOUD BRIDGE
// Permite que o Nano Video Downloader envie arquivos diretamente para sua pasta
// compartilhada do Google Drive, sem necessidade de autenticação OAuth na aplicação.
// ============================================================================

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    
    // Verificação de conectividade (ping)
    if (data.action === 'ping') {
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        message: 'Nano S Tecnologia Google Drive Bridge online e operacional!'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (!data.folderId) {
      throw new Error('Parâmetro folderId ausente.');
    }

    var rootFolder = DriveApp.getFolderById(data.folderId);
    var targetFolder = rootFolder;

    // Cria a estrutura de subpastas automaticamente (/Curso/Modulo)
    if (data.relativePath) {
      var parts = data.relativePath.split(/[\\/\\\\]/).filter(function(p) { return p.length > 0; });
      for (var i = 0; i < parts.length; i++) {
        var subFolders = targetFolder.getFoldersByName(parts[i]);
        if (subFolders.hasNext()) {
          targetFolder = subFolders.next();
        } else {
          targetFolder = targetFolder.createFolder(parts[i]);
        }
      }
    }

    // Decodifica os bytes e grava o arquivo no Google Drive
    var decoded = Utilities.base64Decode(data.base64Data);
    var blob = Utilities.newBlob(decoded, data.mimeType || 'application/octet-stream', data.fileName);

    // Substitui versão antiga caso já exista
    var existingFiles = targetFolder.getFilesByName(data.fileName);
    if (existingFiles.hasNext()) {
      var oldFile = existingFiles.next();
      oldFile.setTrashed(true);
    }

    var createdFile = targetFolder.createFile(blob);

    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      fileId: createdFile.getId(),
      url: createdFile.getUrl()
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
`;
  }
}
