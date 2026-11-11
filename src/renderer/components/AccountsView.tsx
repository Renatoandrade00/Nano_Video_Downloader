import React, { useState } from 'react';
import { FolderOpen, Link2, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { AccountRecord, AppSettings, PlatformId } from '../../shared/types';

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
    desc: 'Autenticação direta via Antigravity WebBridge e verificação em /my-courses.',
  },
  {
    id: 'kiwify',
    name: 'Kiwify / Kiwify Members',
    desc: 'Autenticação direta via Antigravity WebBridge e verificação em /purchases.',
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

  const handleConnect = async (platform: PlatformId) => {
    setBusyPlatform(platform);
    setFeedback(null);
    try {
      await window.antigravity.auth.connect(platform);
      await onRefreshAccounts();
      setFeedback(`Conta ${platform.toUpperCase()} conectada e protegida com AES-256.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Falha ao conectar conta.');
    } finally {
      setBusyPlatform(null);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    await window.antigravity.auth.disconnect(accountId);
    await onRefreshAccounts();
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Contas & Cofre Seguro</h1>
          <p className="page-desc">
            Conecte suas credenciais sem exposição em texto puro. Todos os tokens são cifrados em
            AES-256 no cofre nativo do sistema operacional.
          </p>
        </div>
      </div>

      {feedback && (
        <div className="card" style={{ borderColor: 'rgba(99,102,241,0.5)' }}>
          {feedback}
        </div>
      )}

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
                  {busyPlatform === plat.id ? 'Aguardando WebBridge...' : `Conectar ${plat.id}`}
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

      <div className="card">
        <div className="row-between">
          <div>
            <strong>Pasta da Biblioteca Offline (RF-11)</strong>
            <p className="page-desc">
              Estrutura automática: {'/{Nome_Curso}/{Modulo_XX}/{Aula_YY - Titulo}.mp4'}
            </p>
            <code style={{ fontSize: 12, color: '#a5b4fc' }}>
              {settings?.libraryRootDir ?? 'Carregando...'}
            </code>
          </div>
          <button className="btn" onClick={() => void handlePickDir()}>
            <FolderOpen size={15} />
            Alterar Pasta
          </button>
        </div>
      </div>
    </div>
  );
};

