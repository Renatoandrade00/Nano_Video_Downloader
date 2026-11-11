import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  DownloadCloud,
  HardDrive,
  UserCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  AccountRecord,
  AppSettings,
  CourseRecord,
  CourseTreeDetails,
  DownloadJobRecord,
  JobProgressEvent,
  ModuleProgressEvent,
  OwnershipRevokedEvent,
} from '../shared/types';
import { AccountsView } from './components/AccountsView';
import { CatalogView } from './components/CatalogView';
import { OfflineLibraryView } from './components/OfflineLibraryView';
import { QueueView } from './components/QueueView';

type TabId = 'offline' | 'catalog' | 'queue' | 'accounts';

export const App: React.FC = () => {
  const [tab, setTab] = useState<TabId>('offline');
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [courses, setCourses] = useState<CourseRecord[]>([]);
  const [offlineCourses, setOfflineCourses] = useState<CourseTreeDetails[]>([]);
  const [jobs, setJobs] = useState<DownloadJobRecord[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [progressByJob, setProgressByJob] = useState<Record<string, JobProgressEvent>>({});
  const [moduleProgress, setModuleProgress] = useState<Record<string, ModuleProgressEvent>>({});
  const [revocationBanner, setRevocationBanner] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const [accs, off, jbs, cfg] = await Promise.all([
      window.antigravity.auth.listAccounts(),
      window.antigravity.catalog.getOffline(),
      window.antigravity.queue.listJobs(),
      window.antigravity.settings.get(),
    ]);
    setAccounts(accs);
    setOfflineCourses(off);
    setJobs(jbs);
    setSettings(cfg);
    if (off.length === 0 && accs.filter((a) => a.status === 'CONNECTED').length === 0) {
      setTab('accounts');
    }
  }, []);

  const syncAllConnectedCourses = useCallback(async () => {
    const accs = await window.antigravity.auth.listAccounts();
    setAccounts(accs);
    const connected = accs.filter((a) => a.status === 'CONNECTED');
    const collected: CourseRecord[] = [];
    for (const acc of connected) {
      try {
        const list = await window.antigravity.catalog.sync(acc.id);
        collected.push(...list);
      } catch {
        // Offline or expired session; keep offline catalog accessible
      }
    }
    setCourses(collected);
  }, []);

  useEffect(() => {
    void loadAll().then(() => {
      if (navigator.onLine) {
        void syncAllConnectedCourses();
      }
    });

    const unsubs = [
      window.antigravity.events.onNetworkStatus((e) => setOnline(e.online)),
      window.antigravity.events.onJobProgress((e) => {
        setProgressByJob((prev) => ({ ...prev, [e.jobId]: e }));
      }),
      window.antigravity.events.onModuleProgress((e) => {
        setModuleProgress((prev) => ({ ...prev, [e.moduleId]: e }));
      }),
      window.antigravity.events.onJobCompleted(() => {
        void window.antigravity.queue.listJobs().then(setJobs);
        void window.antigravity.catalog.getOffline().then(setOfflineCourses);
      }),
      window.antigravity.events.onOwnershipRevoked((e: OwnershipRevokedEvent) => {
        setRevocationBanner(
          `Acesso revogado para o curso ${e.courseId} (${e.reason}). ${e.affectedJobIds.length} download(s) bloqueado(s).`,
        );
        void window.antigravity.queue.listJobs().then(setJobs);
      }),
    ];

    const onBrowserOnline = () => setOnline(true);
    const onBrowserOffline = () => setOnline(false);
    window.addEventListener('online', onBrowserOnline);
    window.addEventListener('offline', onBrowserOffline);

    return () => {
      unsubs.forEach((u) => u());
      window.removeEventListener('online', onBrowserOnline);
      window.removeEventListener('offline', onBrowserOffline);
    };
  }, [loadAll, syncAllConnectedCourses]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">Nano Video Downloader</div>
          <div className="brand-sub">Google Antigravity • v1.0.0</div>
        </div>

        <nav className="nav-list">
          <button
            className={`nav-btn ${tab === 'offline' ? 'active' : ''}`}
            onClick={() => {
              setTab('offline');
              void window.antigravity.catalog.getOffline().then(setOfflineCourses);
            }}
          >
            <HardDrive size={17} />
            Biblioteca Offline
          </button>

          <button
            className={`nav-btn ${tab === 'catalog' ? 'active' : ''}`}
            onClick={() => setTab('catalog')}
          >
            <BookOpen size={17} />
            Catálogo Online
          </button>

          <button
            className={`nav-btn ${tab === 'queue' ? 'active' : ''}`}
            onClick={() => {
              setTab('queue');
              void window.antigravity.queue.listJobs().then(setJobs);
            }}
          >
            <DownloadCloud size={17} />
            Fila ({jobs.filter((j) => j.state === 'DOWNLOADING' || j.state === 'QUEUED').length})
          </button>

          <button
            className={`nav-btn ${tab === 'accounts' ? 'active' : ''}`}
            onClick={() => setTab('accounts')}
          >
            <UserCheck size={17} />
            Contas & Cofre
          </button>
        </nav>

        <div className={`network-pill ${online ? 'online' : 'offline'}`}>
          {online ? <Wifi size={15} /> : <WifiOff size={15} />}
          <span>{online ? 'Online' : 'Modo Offline'}</span>
        </div>
      </aside>

      <main className="main-content">
        {revocationBanner && (
          <div className="banner-alert row-between">
            <span>{revocationBanner}</span>
            <button className="btn" onClick={() => setRevocationBanner(null)}>
              Fechar
            </button>
          </div>
        )}

        {tab === 'offline' && (
          <OfflineLibraryView
            offlineCourses={offlineCourses}
            onRefreshOffline={async () => {
              const off = await window.antigravity.catalog.getOffline();
              setOfflineCourses(off);
            }}
          />
        )}

        {tab === 'catalog' && (
          <CatalogView
            courses={courses}
            online={online}
            onEnqueued={() => {
              void window.antigravity.queue.listJobs().then(setJobs);
              setTab('queue');
            }}
          />
        )}

        {tab === 'queue' && (
          <QueueView
            jobs={jobs}
            progressByJob={progressByJob}
            moduleProgress={moduleProgress}
            settings={settings}
            onRefreshJobs={async () => {
              setJobs(await window.antigravity.queue.listJobs());
            }}
            onSettingsChanged={setSettings}
          />
        )}

        {tab === 'accounts' && (
          <AccountsView
            accounts={accounts}
            settings={settings}
            online={online}
            onRefreshAccounts={async () => {
              setAccounts(await window.antigravity.auth.listAccounts());
            }}
            onSyncedCourses={syncAllConnectedCourses}
            onSettingsChanged={setSettings}
          />
        )}
      </main>
    </div>
  );
};

