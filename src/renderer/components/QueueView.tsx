import React, { useState } from 'react';
import { Pause, Play, Trash2 } from 'lucide-react';
import {
  AppSettings,
  DownloadJobRecord,
  JobProgressEvent,
  ModuleProgressEvent,
} from '../../shared/types';

interface QueueViewProps {
  jobs: DownloadJobRecord[];
  progressByJob: Record<string, JobProgressEvent>;
  moduleProgress: Record<string, ModuleProgressEvent>;
  settings: AppSettings | null;
  onRefreshJobs: () => Promise<void>;
  onSettingsChanged: (settings: AppSettings) => void;
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 KB/s';
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
  }
  return `${Math.round(bytesPerSec / 1024)} KB/s`;
}

export const QueueView: React.FC<QueueViewProps> = ({
  jobs,
  progressByJob,
  moduleProgress,
  settings,
  onRefreshJobs,
  onSettingsChanged,
}) => {
  const [limitInputKb, setLimitInputKb] = useState<string>(
    settings?.bandwidthLimitBytesPerSec
      ? String(Math.round(settings.bandwidthLimitBytesPerSec / 1024))
      : '',
  );

  const [clearFeedback, setClearFeedback] = useState<string | null>(null);

  const handleControl = async (action: 'pause' | 'resume' | 'cancel', jobId?: string) => {
    await window.antigravity.queue.control(action, jobId);
    await onRefreshJobs();
  };

  const handleClearFailed = async () => {
    setClearFeedback(null);
    try {
      const res = await window.antigravity.queue.clearFailed();
      await onRefreshJobs();
      setClearFeedback(`${res.deletedCount} registro(s) com erro/cancelado(s) removido(s).`);
    } catch (err) {
      setClearFeedback(err instanceof Error ? err.message : 'Falha ao limpar erros.');
    }
  };

  // Deixa na tela da Fila apenas jobs na fila, em download/remux, pausados ou com erro (concluídos vão para Biblioteca Offline)
  const visibleJobs = jobs.filter((j) => {
    const liveState = progressByJob[j.id]?.state ?? j.state;
    return liveState !== 'COMPLETED';
  });

  const errorJobsCount = visibleJobs.filter((j) => {
    const liveState = progressByJob[j.id]?.state ?? j.state;
    return liveState === 'FAILED' || liveState === 'REVOKED' || liveState === 'CANCELED';
  }).length;

  const applyBandwidthLimit = async (kbPerSec: number | null) => {
    const bytesPerSec = kbPerSec && kbPerSec > 0 ? kbPerSec * 1024 : null;
    await window.antigravity.queue.setBandwidthLimit(bytesPerSec);
    const updated = await window.antigravity.settings.get();
    onSettingsChanged(updated);
    setLimitInputKb(bytesPerSec ? String(Math.round(bytesPerSec / 1024)) : '');
  };

  const moduleList = Object.values(moduleProgress);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Fila de Downloads & Remux</h1>
          <p className="page-desc">
            Checkpointing por segmento com retomada exata e controle de banda em tempo real.
          </p>
        </div>

        <div className="row-gap">
          <button className="btn" onClick={() => void handleControl('pause')}>
            <Pause size={14} /> Pausar Tudo
          </button>
          <button className="btn" onClick={() => void handleControl('resume')}>
            <Play size={14} /> Retomar Tudo
          </button>
          <button
            className="btn btn-danger"
            disabled={errorJobsCount === 0}
            onClick={() => void handleClearFailed()}
          >
            <Trash2 size={14} /> Limpar Erros ({errorJobsCount})
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row-between">
          <div>
            <strong>Controle de Banda (RF-10)</strong>
            <p className="page-desc">
              Limite atual:{' '}
              {settings?.bandwidthLimitBytesPerSec
                ? formatRate(settings.bandwidthLimitBytesPerSec)
                : 'Ilimitado'}
            </p>
          </div>
          <div className="row-gap">
            <input
              type="number"
              min={0}
              placeholder="KB/s (vazio = ilimitado)"
              className="text-input"
              value={limitInputKb}
              onChange={(e) => setLimitInputKb(e.target.value)}
            />
            <button
              className="btn btn-primary"
              onClick={() =>
                void applyBandwidthLimit(limitInputKb ? Number(limitInputKb) : null)
              }
            >
              Aplicar
            </button>
            <button className="btn" onClick={() => void applyBandwidthLimit(null)}>
              Ilimitado
            </button>
          </div>
        </div>
      </div>

      {clearFeedback && (
        <div className="card" style={{ padding: '10px 14px', fontSize: 13 }}>
          {clearFeedback}
        </div>
      )}

      {moduleList.length > 0 && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <strong>Progresso por Módulo</strong>
          {moduleList.map((mp) => (
            <div key={mp.moduleId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div className="row-between" style={{ fontSize: 12 }}>
                <span>Módulo {mp.moduleId}</span>
                <span>
                  {mp.completedLessons}/{mp.totalLessons} aulas ({mp.overallPercent}%)
                </span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${mp.overallPercent}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {visibleJobs.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--muted)' }}>
            Nenhum download pendente ou em andamento na fila. Os vídeos concluídos estão na Biblioteca Offline.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visibleJobs.map((job) => {
            const live = progressByJob[job.id];
            const state = live?.state ?? job.state;
            const totalSegs = live?.totalSegments ?? job.totalSegments;
            const doneSegs = live?.completedSegments ?? job.completedSegments;
            const percent =
              state === 'COMPLETED'
                ? 100
                : live?.percent ??
                  (totalSegs > 0 ? Math.min(99, Math.round((doneSegs / totalSegs) * 100)) : 0);

            return (
              <div key={job.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="row-between">
                  <div className="row-gap">
                    <strong>Job {job.id}</strong>
                    <span className="badge badge-info">{job.targetResolution}</span>
                    {job.streamType && <span className="badge">{job.streamType}</span>}
                    <span
                      className={`badge ${
                        state === 'COMPLETED'
                          ? 'badge-success'
                          : state === 'REVOKED' || state === 'FAILED'
                            ? 'badge-danger'
                            : state === 'PAUSED'
                              ? 'badge-warning'
                              : 'badge-info'
                      }`}
                    >
                      {state}
                    </span>
                  </div>

                  <div className="row-gap">
                    {(state === 'DOWNLOADING' || state === 'QUEUED') && (
                      <button
                        className="btn"
                        onClick={() => void handleControl('pause', job.id)}
                      >
                        <Pause size={13} /> Pausar
                      </button>
                    )}
                    {(state === 'PAUSED' || state === 'FAILED') && (
                      <button
                        className="btn btn-primary"
                        onClick={() => void handleControl('resume', job.id)}
                      >
                        <Play size={13} /> Retomar
                      </button>
                    )}
                    {state !== 'COMPLETED' && state !== 'CANCELED' && (
                      <button
                        className="btn btn-danger"
                        onClick={() => void handleControl('cancel', job.id)}
                      >
                        <Trash2 size={13} /> Cancelar
                      </button>
                    )}
                  </div>
                </div>

                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${percent}%` }} />
                </div>

                <div className="row-between" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  <span>
                    Segmentos: {doneSegs}/{totalSegs} ({percent}%)
                  </span>
                  <span>
                    {live?.bytesPerSec ? formatRate(live.bytesPerSec) : ''}
                    {job.errorCode ? ` • ${job.errorCode}` : ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

