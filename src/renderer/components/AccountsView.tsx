import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  FolderOpen,
  HardDrive,
  HelpCircle,
  Link2,
  LogOut,
  RefreshCw,
  Save,
  ShieldCheck,
  UploadCloud,
  X,
  XCircle,
} from 'lucide-react';
import { AccountRecord, AppSettings, PlatformId, StorageDriver } from '../../shared/types';

interface AccountsViewProps {
  accounts: AccountRecord[];
  settings: AppSettings | null;
  online: boolean;
  onRefreshAccounts: () => Promise<void>;
  onSyncedCourses: () => Promise<void>;
  onSettingsChanged: (settings: AppSettings) => void;
}

const PLATFORMS: Array<{ id: PlatformId; name: string; desc: string }> = [
  {
    id: 'hotmart',
    name: 'Hotmart / Club Hotmart',
    desc: 'Autenticação direta via WebBridge e verificação de titularidade em /my-courses.',
  },
  {
    id: 'kiwify',
    name: 'Kiwify / Kiwify Members',
    desc: 'Autenticação direta via WebBridge e verificação de titularidade em /purchases.',
  },
];

export const AccountsView: React.FC<AccountsViewProps> = ({
  accounts,
  settings,
  online,
  onRefreshAccounts,
  onSyncedCourses,
  onSettingsChanged,
}) => {
  const [busyPlatform, setBusyPlatform] = useState<PlatformId | null>(null);
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Storage and Google Drive state
  const [storageDriver, setStorageDriver] = useState<StorageDriver>(
    settings?.storageDriver ?? 'local',
  );
  const [gdriveUrl, setGdriveUrl] = useState<string>(
    settings?.googleDrive?.folderUrl ?? '',
  );
  const [gdriveEndpoint, setGdriveEndpoint] = useState<string>(
    settings?.googleDrive?.uploadEndpoint ?? '',
  );
  const [mirrorLocal, setMirrorLocal] = useState<boolean>(
    settings?.googleDrive?.mirrorLocal ?? true,
  );
  const [isTestingGDrive, setIsTestingGDrive] = useState<boolean>(false);
  const [gdriveStatus, setGdriveStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [showScriptModal, setShowScriptModal] = useState<boolean>(false);
  const [scriptTemplate, setScriptTemplate] = useState<string>('');
  const [copiedScript, setCopiedScript] = useState<boolean>(false);
  const [savingStorage, setSavingStorage] = useState<boolean>(false);

  const handleConnect = async (platform: PlatformId) => {
    setBusyPlatform(platform);
    setFeedback(null);
    try {
      await window.antigravity.auth.connect(platform);
      await onRefreshAccounts();
      await onSyncedCourses();
      setFeedback(`Conta ${platform.toUpperCase()} conectada, sincronizada e protegida com AES-256.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Falha ao conectar conta.');
    } finally {
      setBusyPlatform(null);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    await window.antigravity.auth.disconnect(accountId);
    await onRefreshAccounts();
    await onSyncedCourses();
    setFeedback('Sessão desconectada e tokens removidos do cofre do sistema.');
  };

  const handleSync = async (accountId: string) => {
    setSyncingAccountId(accountId);
    setFeedback(null);
    try {
      const courses = await window.antigravity.catalog.sync(accountId);
      await onSyncedCourses();
      setFeedback(`${courses.length} curso(s) verificado(s) e sincronizado(s).`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Erro ao sincronizar catálogo.');
    } finally {
      setSyncingAccountId(null);
    }
  };

  const handlePickDir = async () => {
    const picked = await window.antigravity.settings.pickLibraryDir();
    if (picked) {
      const updated = await window.antigravity.settings.setLibraryDir(picked);
      onSettingsChanged(updated);
    }
  };

  const handleTestGDrive = async () => {
    if (!gdriveUrl.trim()) {
      setGdriveStatus({
        ok: false,
        message: 'Por favor, insira o link da pasta compartilhada do Google Drive.',
      });
      return;
    }
    setIsTestingGDrive(true);
    setGdriveStatus(null);
    try {
      const res = await window.antigravity.settings.testGoogleDriveConnection(
        gdriveUrl.trim(),
        gdriveEndpoint.trim() || undefined,
      );
      setGdriveStatus({ ok: res.ok, message: res.message });
    } catch (err) {
      setGdriveStatus({
        ok: false,
        message: err instanceof Error ? err.message : 'Erro ao testar conexão com Google Drive.',
      });
    } finally {
      setIsTestingGDrive(false);
    }
  };

  const handleOpenScriptModal = async () => {
    try {
      const tmpl = await window.antigravity.settings.getGoogleDriveScriptTemplate();
      setScriptTemplate(tmpl);
    } catch {
      // Ignora erro
    }
    setShowScriptModal(true);
  };

  const handleCopyScript = () => {
    if (scriptTemplate) {
      navigator.clipboard.writeText(scriptTemplate);
      setCopiedScript(true);
      setTimeout(() => setCopiedScript(false), 2500);
    }
  };

  const handleSaveStorage = async () => {
    setSavingStorage(true);
    setFeedback(null);
    try {
      let folderId = '';
      if (gdriveUrl.trim()) {
        const testRes = await window.antigravity.settings.testGoogleDriveConnection(
          gdriveUrl.trim(),
          gdriveEndpoint.trim() || undefined,
        );
        folderId = testRes.folderId || '';
      }

      const updated = await window.antigravity.settings.updateStorageConfig({
        storageDriver,
        googleDrive: {
          enabled: storageDriver === 'gdrive' || storageDriver === 'both',
          folderUrl: gdriveUrl.trim(),
          folderId,
          uploadEndpoint: gdriveEndpoint.trim(),
          mirrorLocal,
        },
      });

      onSettingsChanged(updated);
      setFeedback('Configurações de armazenamento da Biblioteca salvas com sucesso!');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Falha ao salvar configurações de armazenamento.');
    } finally {
      setSavingStorage(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Contas & Cofre Seguro</h1>
          <p className="page-desc">
            Conecte suas credenciais sem exposição em texto puro. Todos os tokens são cifrados em
            AES-256 no cofre nativo do sistema operacional pela Nano S Tecnologia.
          </p>
        </div>
      </div>

      {feedback && (
        <div className="card" style={{ borderColor: 'rgba(99,102,241,0.5)', background: 'rgba(99,102,241,0.08)' }}>
          {feedback}
        </div>
      )}

      {/* PLATAFORMAS CONECTADAS */}
      <div className="grid-2">
        {PLATFORMS.map((plat) => {
          const connected = accounts.filter(
            (a) => a.platform === plat.id && a.status !== 'DISCONNECTED',
          );
          return (
            <div key={plat.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="row-between">
                <div>
                  <strong style={{ fontSize: 16 }}>{plat.name}</strong>
                  <p className="page-desc">{plat.desc}</p>
                </div>
                <ShieldCheck size={20} color="#6366f1" />
              </div>

              {connected.length === 0 ? (
                <button
                  className="btn btn-primary"
                  disabled={!online || busyPlatform === plat.id}
                  onClick={() => void handleConnect(plat.id)}
                >
                  <Link2 size={15} />
                  {busyPlatform === plat.id ? 'Aguardando WebBridge...' : `Conectar ${plat.name}`}
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {connected.map((acc) => (
                    <div key={acc.id} className="lesson-row">
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>
                          ID: {acc.externalUserId}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                          Status:{' '}
                          <span className="badge badge-success">{acc.status}</span>
                        </div>
                      </div>
                      <div className="row-gap">
                        <button
                          className="btn"
                          disabled={!online || syncingAccountId === acc.id}
                          onClick={() => void handleSync(acc.id)}
                        >
                          <RefreshCw size={14} />
                          {syncingAccountId === acc.id ? 'Sincronizando...' : 'Sincronizar'}
                        </button>
                        <button
                          className="btn btn-danger"
                          onClick={() => void handleDisconnect(acc.id)}
                        >
                          <LogOut size={14} />
                          Sair
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* SEÇÃO: ARMAZENAMENTO DA BIBLIOTECA (LOCAL & GOOGLE DRIVE) */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="row-between">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <HardDrive size={18} color="#6366f1" />
              <strong style={{ fontSize: 16 }}>Destino da Biblioteca de Downloads</strong>
            </div>
            <p className="page-desc">
              Escolha se a biblioteca será armazenada no disco local do computador, em uma pasta compartilhada do Google Drive, ou em ambos simultaneamente.
            </p>
          </div>
        </div>

        {/* SELETOR DE MODO DE ARMAZENAMENTO */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 14px',
              borderRadius: 8,
              border: `1px solid ${storageDriver === 'local' ? 'var(--accent)' : 'var(--border)'}`,
              background: storageDriver === 'local' ? 'rgba(99,102,241,0.12)' : 'var(--panel-alt)',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="storageDriver"
              checked={storageDriver === 'local'}
              onChange={() => setStorageDriver('local')}
              style={{ cursor: 'pointer' }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>📁 Apenas Local</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Salva no disco físico do PC</div>
            </div>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 14px',
              borderRadius: 8,
              border: `1px solid ${storageDriver === 'both' ? 'var(--accent)' : 'var(--border)'}`,
              background: storageDriver === 'both' ? 'rgba(99,102,241,0.12)' : 'var(--panel-alt)',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="storageDriver"
              checked={storageDriver === 'both'}
              onChange={() => setStorageDriver('both')}
              style={{ cursor: 'pointer' }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>🔄 Híbrido (Local + Drive)</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Salva no PC e espelha no Google Drive</div>
            </div>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 14px',
              borderRadius: 8,
              border: `1px solid ${storageDriver === 'gdrive' ? 'var(--accent)' : 'var(--border)'}`,
              background: storageDriver === 'gdrive' ? 'rgba(99,102,241,0.12)' : 'var(--panel-alt)',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="storageDriver"
              checked={storageDriver === 'gdrive'}
              onChange={() => setStorageDriver('gdrive')}
              style={{ cursor: 'pointer' }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>☁️ Google Drive</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Salva na pasta compartilhada</div>
            </div>
          </label>
        </div>

        {/* CAMINHO FÍSICO LOCAL */}
        {(storageDriver === 'local' || storageDriver === 'both') && (
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 8,
              background: 'var(--panel-alt)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Pasta Física no Computador:</div>
              <code style={{ fontSize: 12, color: '#a5b4fc', wordBreak: 'break-all' }}>
                {settings?.libraryRootDir ?? 'Carregando...'}
              </code>
            </div>
            <button className="btn" onClick={() => void handlePickDir()} style={{ flexShrink: 0 }}>
              <FolderOpen size={14} />
              Alterar Pasta
            </button>
          </div>
        )}

        {/* CONFIGURAÇÃO DO GOOGLE DRIVE */}
        {(storageDriver === 'gdrive' || storageDriver === 'both') && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              padding: '14px',
              borderRadius: 8,
              background: 'rgba(99, 102, 241, 0.05)',
              border: '1px solid rgba(99, 102, 241, 0.25)',
            }}
          >
            <div className="row-between">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Cloud size={16} color="#6366f1" />
                <strong style={{ fontSize: 14 }}>Configuração da Pasta Compartilhada no Google Drive</strong>
              </div>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => void handleOpenScriptModal()}
              >
                <HelpCircle size={13} />
                Como Configurar o Webhook sem Login
              </button>
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                Link da Pasta Compartilhada do Google Drive:
              </label>
              <input
                type="text"
                placeholder="Ex: https://drive.google.com/drive/folders/1abcDeFgHiJkLmNoPqRsTuVwXyZ"
                value={gdriveUrl}
                onChange={(e) => setGdriveUrl(e.target.value)}
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  fontSize: 13,
                }}
              />
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--muted)' }}>
                👉 A pasta deve estar compartilhada como <strong>&quot;Qualquer pessoa com o link pode editar/alterar&quot;</strong>.
              </p>
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                URL da Ponte / Webhook do Google Apps Script (Opcional para upload na nuvem sem login):
              </label>
              <input
                type="text"
                placeholder="Ex: https://script.google.com/macros/s/AKfycbx.../exec"
                value={gdriveEndpoint}
                onChange={(e) => setGdriveEndpoint(e.target.value)}
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  fontSize: 13,
                }}
              />
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--muted)' }}>
                Se você utiliza o <strong>Google Drive para Desktop</strong> no Windows, a detecção local é automática. Para envio direto pela nuvem sem login com conta Google, informe a URL do App da Web.
              </p>
            </div>

            <div className="row-between" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn"
                disabled={isTestingGDrive || !gdriveUrl.trim()}
                onClick={() => void handleTestGDrive()}
              >
                <UploadCloud size={14} />
                {isTestingGDrive ? 'Testando Conectividade...' : 'Testar Conexão com Google Drive'}
              </button>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={mirrorLocal}
                  onChange={(e) => setMirrorLocal(e.target.checked)}
                />
                Manter cópia local física além do Google Drive
              </label>
            </div>

            {gdriveStatus && (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: gdriveStatus.ok ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                  borderColor: gdriveStatus.ok ? 'var(--success)' : 'var(--danger)',
                  border: '1px solid',
                  color: gdriveStatus.ok ? '#6ee7b7' : '#fca5a5',
                }}
              >
                {gdriveStatus.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                <span>{gdriveStatus.message}</span>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            className="btn btn-primary"
            disabled={savingStorage}
            onClick={() => void handleSaveStorage()}
            style={{ padding: '8px 18px' }}
          >
            <Save size={15} />
            {savingStorage ? 'Salvando...' : 'Salvar Configurações de Armazenamento'}
          </button>
        </div>
      </div>

      {/* MODAL: INSTRUÇÕES DO GOOGLE APPS SCRIPT WEBHOOK */}
      {showScriptModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              maxWidth: 720,
              width: '100%',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 25px -5px rgba(0,0,0,0.5)',
            }}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Cloud size={18} color="#6366f1" />
                <strong style={{ fontSize: 16 }}>Ponte do Google Drive (Upload sem Login)</strong>
              </div>
              <button
                className="btn"
                style={{ padding: 4 }}
                onClick={() => setShowScriptModal(false)}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ padding: '18px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                Como o Google exige uma conta autenticada para fazer upload em pastas compartilhadas públicas, você pode criar uma ponte gratuita de 1 minuto em sua conta do Google Drive via <strong>Google Apps Script</strong>:
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                <div style={{ padding: '8px 12px', background: 'var(--panel-alt)', borderRadius: 6 }}>
                  <strong>Passo 1:</strong> Acesse{' '}
                  <a
                    href="https://script.google.com"
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: '#818cf8', textDecoration: 'underline' }}
                  >
                    script.google.com
                  </a>{' '}
                  e clique em <strong>&quot;Novo projeto&quot;</strong>.
                </div>
                <div style={{ padding: '8px 12px', background: 'var(--panel-alt)', borderRadius: 6 }}>
                  <strong>Passo 2:</strong> Apague o conteúdo do editor e cole o script abaixo. Clique em <strong>Salvar</strong> (ícone do disquete).
                </div>
                <div style={{ padding: '8px 12px', background: 'var(--panel-alt)', borderRadius: 6 }}>
                  <strong>Passo 3:</strong> Clique em <strong>Implantar &gt; Nova implantação</strong>. Selecione o tipo <strong>App da Web</strong>, configure <strong>&quot;Executar como: Eu&quot;</strong> e <strong>&quot;Quem pode acessar: Qualquer pessoa&quot;</strong>. Copie o URL da Web gerado e cole no campo acima!
                </div>
              </div>

              <div>
                <div className="row-between" style={{ marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Código do Google Apps Script:</span>
                  <button className="btn" style={{ fontSize: 11, padding: '4px 8px' }} onClick={handleCopyScript}>
                    {copiedScript ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                    {copiedScript ? 'Copiado!' : 'Copiar Código'}
                  </button>
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    background: '#070b14',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 11,
                    maxHeight: 220,
                    overflow: 'auto',
                    color: '#93c5fd',
                    fontFamily: 'monospace',
                  }}
                >
                  {scriptTemplate}
                </pre>
              </div>
            </div>

            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              <button className="btn btn-primary" onClick={() => setShowScriptModal(false)}>
                Entendi, Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
