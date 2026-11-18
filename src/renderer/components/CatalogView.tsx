import React, { useState } from 'react';
import {
  CheckCircle2,
  CheckSquare,
  Cloud,
  Download,
  FileText,
  FolderOpen,
  HardDrive,
  Lock,
  RefreshCw,
  Search,
  Square,
  Unlock,
} from 'lucide-react';
import {
  CourseRecord,
  CourseSyncAuditResult,
  CourseTreeDetails,
  ResolutionOption,
} from '../../shared/types';

interface CatalogViewProps {
  courses: CourseRecord[];
  online: boolean;
  onEnqueued: () => void;
  onSync?: () => Promise<void>;
}

const RESOLUTIONS: ResolutionOption[] = ['1080p', '720p', '480p', '360p'];

function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const CatalogView: React.FC<CatalogViewProps> = ({
  courses,
  online,
  onEnqueued,
  onSync,
}) => {
  const [selectedCourse, setSelectedCourse] = useState<CourseTreeDetails | null>(null);
  const [selectedLessonIds, setSelectedLessonIds] = useState<Set<string>>(new Set());
  const [resolution, setResolution] = useState<ResolutionOption>('1080p');
  const [downloadVideos, setDownloadVideos] = useState<boolean>(true);
  const [downloadAttachments, setDownloadAttachments] = useState<boolean>(true);
  const [loadingCourseId, setLoadingCourseId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [scanningModuleId, setScanningModuleId] = useState<string | null>(null);
  const [scanningLessonId, setScanningLessonId] = useState<string | null>(null);
  const [downloadingAttId, setDownloadingAttId] = useState<string | null>(null);
  const [downloadingModulePdfsId, setDownloadingModulePdfsId] = useState<string | null>(null);
  const [auditResult, setAuditResult] = useState<CourseSyncAuditResult | null>(null);
  const [isAuditing, setIsAuditing] = useState<boolean>(false);
  const [isDownloadingPending, setIsDownloadingPending] = useState<boolean>(false);
  const [isUnlocking, setIsUnlocking] = useState<boolean>(false);

  const handleAuditCourse = async (courseId?: string) => {
    const id = courseId || selectedCourse?.course.id;
    if (!id) return;
    setIsAuditing(true);
    try {
      const result = await window.antigravity.catalog.auditCourseSync(id);
      setAuditResult(result);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Erro ao auditar sincronização do curso.');
    } finally {
      setIsAuditing(false);
    }
  };

  const handleDownloadPending = async () => {
    if (!selectedCourse) return;
    setIsDownloadingPending(true);
    setStatusMsg('Enfileirando itens pendentes para download e sincronização...');
    try {
      const res = await window.antigravity.catalog.downloadPending(
        selectedCourse.course.id,
        resolution,
        {
          downloadVideos,
          downloadAttachments,
        },
      );
      setStatusMsg(
        `✓ Sincronização iniciada: ${res.enqueuedLessons} aula(s) e ${res.enqueuedAttachments} PDF(s) pendentes foram adicionados à fila!`,
      );
      onEnqueued();
      void handleAuditCourse(selectedCourse.course.id);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Erro ao iniciar download dos pendentes.');
    } finally {
      setIsDownloadingPending(false);
    }
  };

  const handleSyncCatalog = async () => {
    if (!onSync || isSyncing) return;
    setIsSyncing(true);
    setStatusMsg('Sincronizando catálogo com as plataformas...');
    try {
      await onSync();
      setStatusMsg('Catálogo sincronizado com sucesso.');
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Falha ao sincronizar catálogo.');
    } finally {
      setIsSyncing(false);
    }
  };

  const openCourse = async (course: CourseRecord, forceRemote = false) => {
    setLoadingCourseId(course.id);
    setStatusMsg(null);
    setAuditResult(null);
    try {
      if (course.licenseStatus === 'AUTHORIZED') {
        try {
          await window.antigravity.catalog.unlockCourseLessons(course.id);
        } catch {
          // ignore
        }
      }
      const details = await window.antigravity.catalog.getCourseDetails(course.id, forceRemote);
      setSelectedCourse(details);
      setSelectedLessonIds(new Set());
      void handleAuditCourse(course.id);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Erro ao carregar módulos do curso.');
    } finally {
      setLoadingCourseId(null);
    }
  };

  const handleUnlockCourse = async () => {
    if (!selectedCourse) return;
    setIsUnlocking(true);
    setStatusMsg('Liberando aulas programadas / bloqueadas deste curso...');
    try {
      const res = await window.antigravity.catalog.unlockCourseLessons(selectedCourse.course.id);
      const details = await window.antigravity.catalog.getCourseDetails(selectedCourse.course.id, false);
      setSelectedCourse(details);
      setStatusMsg(
        res.unlockedCount > 0
          ? `Sucesso! ${res.unlockedCount} aula(s) liberada(s) para download!`
          : 'Todas as aulas deste curso já estão liberadas para download.',
      );
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Erro ao liberar aulas do curso.');
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleScanModule = async (moduleId: string) => {
    if (!selectedCourse) return;
    setScanningModuleId(moduleId);
    setStatusMsg('Buscando PDFs e materiais nas páginas das aulas deste módulo...');
    try {
      const res = await window.antigravity.catalog.scanModuleAttachments(
        selectedCourse.course.id,
        moduleId,
      );
      setStatusMsg(
        res.totalFound > 0
          ? `Busca concluída! ${res.totalFound} arquivo(s) de apoio / PDF(s) encontrado(s).`
          : 'Nenhum material novo encontrado neste módulo.',
      );
      const refreshed = await window.antigravity.catalog.getCourseDetails(
        selectedCourse.course.id,
        false,
      );
      setSelectedCourse(refreshed);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Falha ao buscar materiais do módulo.');
    } finally {
      setScanningModuleId(null);
    }
  };

  const handleDownloadModulePdfs = async (moduleId: string) => {
    if (!selectedCourse) return;
    setDownloadingModulePdfsId(moduleId);
    setStatusMsg('Verificando PDFs e materiais do módulo...');
    try {
      const mod = selectedCourse.modules.find((m) => m.id === moduleId);
      const existingAttCount =
        mod?.lessons.reduce((acc, l) => acc + (l.attachments?.length ?? 0), 0) ?? 0;
      if (existingAttCount === 0) {
        setStatusMsg('Buscando PDFs das aulas do módulo na plataforma...');
        await window.antigravity.catalog.scanModuleAttachments(selectedCourse.course.id, moduleId);
      }

      setStatusMsg('Baixando todos os PDFs do módulo...');
      const res = await window.antigravity.attachments.downloadModuleAttachments(moduleId);
      if (res.ok) {
        setStatusMsg(
          res.total > 0
            ? `${res.downloaded} de ${res.total} PDF(s) do módulo baixado(s) com sucesso!`
            : 'Nenhum material em PDF encontrado neste módulo.',
        );
        const refreshed = await window.antigravity.catalog.getCourseDetails(
          selectedCourse.course.id,
          false,
        );
        setSelectedCourse(refreshed);
      } else {
        setStatusMsg(`Falha ao baixar PDFs do módulo: ${res.error ?? 'Erro desconhecido'}`);
      }
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Falha ao baixar PDFs do módulo.');
    } finally {
      setDownloadingModulePdfsId(null);
    }
  };

  const handleScanLesson = async (lessonId: string) => {
    if (!selectedCourse) return;
    setScanningLessonId(lessonId);
    setStatusMsg('Buscando PDFs e materiais da aula na plataforma...');
    try {
      const atts = await window.antigravity.catalog.scanLessonAttachments(
        selectedCourse.course.id,
        lessonId,
      );
      setStatusMsg(
        atts.length > 0
          ? `${atts.length} arquivo(s) encontrado(s) na aula!`
          : 'Nenhum material de apoio anexado a esta aula.',
      );
      const refreshed = await window.antigravity.catalog.getCourseDetails(
        selectedCourse.course.id,
        false,
      );
      setSelectedCourse(refreshed);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Falha ao buscar materiais da aula.');
    } finally {
      setScanningLessonId(null);
    }
  };

  const handleDownloadAttachment = async (attachmentId: string) => {
    if (!selectedCourse) return;
    setDownloadingAttId(attachmentId);
    try {
      const res = await window.antigravity.attachments.downloadAttachment(attachmentId);
      if (res.ok) {
        setStatusMsg('Arquivo baixado com sucesso!');
        const refreshed = await window.antigravity.catalog.getCourseDetails(
          selectedCourse.course.id,
          false,
        );
        setSelectedCourse(refreshed);
      } else {
        setStatusMsg(`Falha ao baixar arquivo: ${res.error ?? 'Erro desconhecido'}`);
      }
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Erro ao baixar arquivo.');
    } finally {
      setDownloadingAttId(null);
    }
  };

  const handleOpenAttachment = async (attachmentId: string) => {
    try {
      const res = await window.antigravity.attachments.openAttachment(attachmentId);
      if (!res.ok) {
        setStatusMsg(`Erro ao abrir arquivo: ${res.error}`);
      }
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Erro ao abrir arquivo.');
    }
  };

  const toggleLesson = (lessonId: string) => {
    setSelectedLessonIds((prev) => {
      const next = new Set(prev);
      if (next.has(lessonId)) next.delete(lessonId);
      else next.add(lessonId);
      return next;
    });
  };

  const toggleModule = (lessonIds: string[]) => {
    setSelectedLessonIds((prev) => {
      const next = new Set(prev);
      const allSelected = lessonIds.every((id) => next.has(id));
      for (const id of lessonIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const enqueueIds = async (lessonIds: string[]) => {
    if (lessonIds.length === 0) return;
    if (!downloadVideos && !downloadAttachments) {
      setStatusMsg('Selecione ao menos uma opção: Vídeos ou Arquivos/PDFs.');
      return;
    }
    setStatusMsg('Enfileirando itens para download...');
    try {
      const res = await window.antigravity.queue.enqueue(lessonIds, resolution, {
        downloadVideos,
        downloadAttachments,
      });
      const parts: string[] = [];
      if (res.enqueuedJobIds.length > 0) {
        parts.push(`${res.enqueuedJobIds.length} vídeo(s)`);
      }
      if ((res.enqueuedAttachmentCount ?? 0) > 0) {
        parts.push(`${res.enqueuedAttachmentCount} arquivo(s) de apoio`);
      }
      if (parts.length > 0) {
        setStatusMsg(
          `${parts.join(' e ')} enfileirado(s).${res.rejected.length > 0 ? ` (${res.rejected.length} rejeitada(s))` : ''}`,
        );
        setSelectedLessonIds(new Set());
        onEnqueued();
      } else if (res.rejected.length > 0) {
        setStatusMsg(`Nenhum item enfileirado: ${res.rejected[0].reason}`);
      }
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Falha ao enfileirar selecionadas.');
    }
  };

  const isLessonSelectable = (lesson: {
    hasVideo: boolean;
    availabilityStatus: string;
    attachments?: unknown[];
  }) => {
    if (lesson.availabilityStatus === 'DRM_UNSUPPORTED') return false;
    const canVideo = downloadVideos && lesson.hasVideo;
    const canAttachment = downloadAttachments;
    return canVideo || canAttachment;
  };

  const allAvailableLessonIds =
    selectedCourse?.modules.flatMap((m) =>
      m.lessons.filter(isLessonSelectable).map((l) => l.id),
    ) ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Catálogo de Cursos</h1>
          <p className="page-desc">
            Apenas cursos com titularidade ativa (COMPLETED / ACTIVE) são liberados para download.
          </p>
        </div>

        <div className="row-gap" style={{ flexWrap: 'wrap' }}>
          {onSync && (
            <button
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              disabled={isSyncing}
              onClick={handleSyncCatalog}
            >
              <RefreshCw size={14} className={isSyncing ? 'spin' : ''} />
              {isSyncing ? 'Sincronizando...' : 'Sincronizar'}
            </button>
          )}

          <div
            className="row-gap"
            style={{
              fontSize: 13,
              background: 'var(--surface-variant, rgba(255,255,255,0.05))',
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid var(--border)',
            }}
          >
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={downloadVideos}
                onChange={(e) => setDownloadVideos(e.target.checked)}
              />
              <span>Vídeos</span>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={downloadAttachments}
                onChange={(e) => setDownloadAttachments(e.target.checked)}
              />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <FileText size={13} /> Arquivos (.pdf)
              </span>
            </label>
          </div>

          <label style={{ fontSize: 13, color: 'var(--muted)' }}>Resolução:</label>
          <select
            className="select-input"
            value={resolution}
            disabled={!downloadVideos}
            onChange={(e) => setResolution(e.target.value as ResolutionOption)}
          >
            {RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </div>

      {statusMsg && (
        <div className="card" style={{ borderColor: 'rgba(99,102,241,0.45)' }}>
          {statusMsg}
        </div>
      )}

      {courses.length === 0 ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <p style={{ margin: 0, color: 'var(--muted)' }}>
            Nenhum curso sincronizado ainda. Conecte uma conta na aba Contas ou clique em Sincronizar.
          </p>
          {onSync && (
            <button
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              disabled={isSyncing}
              onClick={handleSyncCatalog}
            >
              <RefreshCw size={14} className={isSyncing ? 'spin' : ''} />
              {isSyncing ? 'Sincronizando...' : 'Sincronizar Cursos Agora'}
            </button>
          )}
        </div>
      ) : (
        <div className="grid-2">
          {courses.map((course) => (
            <div key={course.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="row-between">
                <strong style={{ fontSize: 15 }}>{course.title}</strong>
                <span
                  className={`badge ${
                    course.licenseStatus === 'AUTHORIZED' ? 'badge-success' : 'badge-danger'
                  }`}
                >
                  {course.licenseStatus}
                </span>
              </div>
              <div className="row-between">
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Verificado em {new Date(course.licenseCheckedAt).toLocaleString('pt-BR')}
                </span>
                <div className="row-gap">
                  <button
                    className="btn"
                    disabled={course.licenseStatus !== 'AUTHORIZED' || loadingCourseId === course.id}
                    onClick={() => void openCourse(course, false)}
                  >
                    {loadingCourseId === course.id ? 'Carregando...' : 'Abrir Módulos'}
                  </button>
                  {online && (
                    <button
                      className="btn"
                      title="Atualizar árvore remota"
                      disabled={course.licenseStatus !== 'AUTHORIZED' || loadingCourseId === course.id}
                      onClick={() => void openCourse(course, true)}
                    >
                      <RefreshCw size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedCourse && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="row-between">
            <div>
              <strong style={{ fontSize: 16 }}>{selectedCourse.course.title}</strong>
              <p className="page-desc">
                Selecione aulas ou módulos inteiros para enfileirar em lote. Ao marcar "Arquivos (.pdf)",
                os materiais disponíveis na aba "Materiais" de cada aula serão baixados automaticamente para a pasta Materiais.
              </p>
            </div>
            <div className="row-gap" style={{ flexWrap: 'wrap' }}>
              <button
                className="btn"
                style={{ fontSize: 13 }}
                disabled={isUnlocking}
                onClick={() => void handleUnlockCourse()}
                title="Libera todas as aulas programadas / bloqueadas deste curso para download imediato"
              >
                <Unlock size={14} className={isUnlocking ? 'spin' : ''} />
                {isUnlocking ? 'Liberando...' : 'Liberar Todas as Aulas'}
              </button>
              <button
                className="btn"
                disabled={!online || allAvailableLessonIds.length === 0}
                onClick={() => void enqueueIds(allAvailableLessonIds)}
              >
                <Download size={14} />
                Baixar Curso Completo ({allAvailableLessonIds.length})
              </button>
              <button
                className="btn btn-primary"
                disabled={!online || selectedLessonIds.size === 0}
                onClick={() => void enqueueIds([...selectedLessonIds])}
              >
                <Download size={14} />
                Enfileirar Selecionadas ({selectedLessonIds.size})
              </button>
            </div>
          </div>

          {/* PAINEL DE AUDITORIA E SINCRONIZAÇÃO INTELIGENTE (1 CLIQUE) */}
          <div
            style={{
              padding: 16,
              borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(16,185,129,0.08))',
              border: '1px solid rgba(99,102,241,0.3)',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Cloud size={20} color="#6366f1" />
                <div>
                  <strong style={{ fontSize: 15 }}>Sincronização & Comparação com a Pasta (Drive / Local)</strong>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    Compara em 1 clique quais aulas e PDFs do curso já estão na sua pasta física e Google Drive e baixa tudo que falta.
                  </div>
                </div>
              </div>

              <div className="row-gap">
                <button
                  className="btn"
                  style={{ fontSize: 12, padding: '6px 12px' }}
                  disabled={isAuditing}
                  onClick={() => void handleAuditCourse()}
                  title="Ler novamente os arquivos da pasta e atualizar o comparativo"
                >
                  <RefreshCw size={13} className={isAuditing ? 'spin' : ''} />
                  {isAuditing ? 'Auditando Pasta...' : 'Auditar & Comparar Pasta'}
                </button>

                {auditResult && (auditResult.pendingLessons > 0 || auditResult.pendingAttachments > 0) && (
                  <button
                    className="btn btn-primary"
                    style={{
                      fontSize: 13,
                      padding: '7px 16px',
                      background: '#10b981',
                      borderColor: '#10b981',
                      color: '#fff',
                      fontWeight: 700,
                    }}
                    disabled={isDownloadingPending || !online}
                    onClick={() => void handleDownloadPending()}
                  >
                    <Download size={15} />
                    {isDownloadingPending
                      ? 'Enfileirando...'
                      : `Baixar Tudo Pendente (${auditResult.pendingLessons} aulas, ${auditResult.pendingAttachments} PDFs)`}
                  </button>
                )}
              </div>
            </div>

            {auditResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ fontWeight: 600 }}>
                    Cobertura da Pasta: {auditResult.overallPercent}% Sincronizado
                  </span>
                  <span style={{ color: 'var(--muted)' }}>
                    {auditResult.syncedLessons + auditResult.syncedAttachments} de{' '}
                    {auditResult.totalLessons + auditResult.totalAttachments} itens salvos
                  </span>
                </div>

                <div
                  style={{
                    width: '100%',
                    height: 8,
                    background: 'rgba(255,255,255,0.1)',
                    borderRadius: 4,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${auditResult.overallPercent}%`,
                      height: '100%',
                      background:
                        auditResult.overallPercent === 100
                          ? 'var(--success)'
                          : 'linear-gradient(90deg, #6366f1, #10b981)',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>

                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, marginTop: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="badge badge-success">
                      ✓ {auditResult.syncedLessons} / {auditResult.totalLessons} Aulas Salvas
                    </span>
                    {auditResult.pendingLessons > 0 && (
                      <span
                        className="badge"
                        style={{
                          background: 'rgba(245,158,11,0.15)',
                          color: '#fbbf24',
                          border: '1px solid rgba(245,158,11,0.3)',
                        }}
                      >
                        ⚠️ {auditResult.pendingLessons} Aulas Pendentes
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="badge badge-success">
                      ✓ {auditResult.syncedAttachments} / {auditResult.totalAttachments} PDFs Salvos
                    </span>
                    {auditResult.pendingAttachments > 0 && (
                      <span
                        className="badge"
                        style={{
                          background: 'rgba(245,158,11,0.15)',
                          color: '#fbbf24',
                          border: '1px solid rgba(245,158,11,0.3)',
                        }}
                      >
                        ⚠️ {auditResult.pendingAttachments} PDFs Pendentes
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <HardDrive size={12} />
                    <span>{auditResult.storagePath}</span>
                  </div>
                </div>

                {auditResult.pendingLessons === 0 && auditResult.pendingAttachments === 0 && (
                  <div
                    style={{
                      padding: '8px 12px',
                      borderRadius: 6,
                      background: 'rgba(16,185,129,0.15)',
                      color: '#6ee7b7',
                      fontSize: 12,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <CheckCircle2 size={15} />
                    <strong>Parabéns! Este curso está 100% sincronizado com a sua pasta física e Google Drive.</strong>
                  </div>
                )}
              </div>
            )}
          </div>

          {selectedCourse.modules.map((mod) => {
            const modAudit = auditResult?.modules.find((m) => m.moduleId === mod.id);
            const selectableIds = mod.lessons
              .filter(isLessonSelectable)
              .map((l) => l.id);
            const allModSelected =
              selectableIds.length > 0 && selectableIds.every((id) => selectedLessonIds.has(id));

            return (
              <div
                key={mod.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div className="row-between">
                  <div className="row-gap" style={{ alignItems: 'center' }}>
                    <button
                      className="btn"
                      style={{ padding: '4px 8px' }}
                      disabled={selectableIds.length === 0}
                      onClick={() => toggleModule(selectableIds)}
                    >
                      {allModSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                      Módulo {String(mod.orderIndex).padStart(2, '0')} — {mod.title}
                    </button>

                    {modAudit && (
                      <span
                        className={modAudit.isFullySynced ? 'badge badge-success' : 'badge'}
                        style={{
                          fontSize: 11,
                          background: modAudit.isFullySynced ? undefined : 'rgba(245,158,11,0.15)',
                          color: modAudit.isFullySynced ? undefined : '#fbbf24',
                          border: modAudit.isFullySynced ? undefined : '1px solid rgba(245,158,11,0.3)',
                        }}
                      >
                        {modAudit.isFullySynced
                          ? '✓ Salvo na Pasta'
                          : `${modAudit.pendingLessons} aula(s) ${
                              modAudit.pendingAttachments > 0 ? `+ ${modAudit.pendingAttachments} PDF(s)` : ''
                            } pendente(s)`}
                      </span>
                    )}
                  </div>
                  <div className="row-gap">
                    {modAudit && !modAudit.isFullySynced && modAudit.pendingLessons > 0 && (
                      <button
                        className="btn btn-primary"
                        style={{
                          padding: '4px 10px',
                          fontSize: 12,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          background: '#10b981',
                          borderColor: '#10b981',
                        }}
                        disabled={!online}
                        onClick={() => {
                          const pendingInMod = mod.lessons
                            .filter((l) => !l.localFilePath)
                            .map((l) => l.id);
                          if (pendingInMod.length > 0) void enqueueIds(pendingInMod);
                        }}
                        title="Baixar apenas as aulas deste módulo que ainda não foram salvas na pasta"
                      >
                        <Download size={13} />
                        Baixar Pendentes ({modAudit.pendingLessons})
                      </button>
                    )}
                    <button
                      className="btn"
                      style={{
                        padding: '4px 10px',
                        fontSize: 12,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                      }}
                      disabled={!online || scanningModuleId === mod.id}
                      onClick={() => void handleScanModule(mod.id)}
                      title="Buscar e listar todos os PDFs e arquivos de apoio das aulas deste módulo"
                    >
                      <FileText size={13} className={scanningModuleId === mod.id ? 'spin' : ''} />
                      {scanningModuleId === mod.id ? 'Buscando PDFs...' : 'Buscar PDFs do Módulo'}
                    </button>
                    <button
                      className="btn"
                      style={{
                        padding: '4px 10px',
                        fontSize: 12,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                      }}
                      disabled={!online || downloadingModulePdfsId === mod.id}
                      onClick={() => void handleDownloadModulePdfs(mod.id)}
                      title="Baixar todos os arquivos PDF de apoio deste módulo diretamente"
                    >
                      <Download size={13} className={downloadingModulePdfsId === mod.id ? 'spin' : ''} />
                      {downloadingModulePdfsId === mod.id ? 'Baixando PDFs...' : 'Baixar PDFs do Módulo'}
                    </button>
                    <button
                      className="btn"
                      style={{ padding: '4px 10px', fontSize: 12 }}
                      disabled={!online || selectableIds.length === 0}
                      onClick={() => void enqueueIds(selectableIds)}
                    >
                      <Download size={13} />
                      Baixar Módulo
                    </button>
                  </div>
                </div>

                {mod.lessons.map((lesson) => {
                  const canSelect = isLessonSelectable(lesson);
                  const checked = selectedLessonIds.has(lesson.id);
                  const attCount = lesson.attachments?.length ?? 0;
                  const isScanningThisLesson = scanningLessonId === lesson.id;

                  return (
                    <div
                      key={lesson.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        background: 'var(--surface-variant, rgba(255,255,255,0.02))',
                        borderRadius: 8,
                        padding: '6px 10px',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <div
                        className="lesson-row"
                        style={{ padding: 0, border: 'none', background: 'transparent' }}
                      >
                        <div className="row-gap" style={{ flex: 1, minWidth: 0 }}>
                          <input
                            type="checkbox"
                            disabled={!canSelect}
                            checked={checked}
                            onChange={() => toggleLesson(lesson.id)}
                          />
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            Aula {String(lesson.orderIndex).padStart(2, '0')} — {lesson.title}
                          </span>
                          {attCount > 0 && (
                            <span
                              className="badge"
                              title={`${attCount} arquivo(s) de apoio nesta aula`}
                              style={{
                                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                                color: '#f87171',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                fontSize: 11,
                                padding: '2px 6px',
                                flexShrink: 0,
                              }}
                            >
                              <FileText size={11} />
                              {attCount} {attCount === 1 ? 'PDF disponível' : 'PDFs disponíveis'}
                            </span>
                          )}
                        </div>

                        <div className="row-gap" style={{ flexShrink: 0 }}>
                          {attCount === 0 && online && (
                            <button
                              className="btn"
                              style={{
                                padding: '2px 8px',
                                fontSize: 11,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                              }}
                              disabled={isScanningThisLesson}
                              onClick={() => void handleScanLesson(lesson.id)}
                              title="Buscar arquivos e PDFs na aba de materiais desta aula"
                            >
                              <Search size={11} className={isScanningThisLesson ? 'spin' : ''} />
                              {isScanningThisLesson ? 'Buscando...' : 'Buscar Material'}
                            </button>
                          )}
                          {lesson.localFilePath && (
                            <span className="badge badge-success">Vídeo Baixado</span>
                          )}
                          {lesson.attachments &&
                            lesson.attachments.some((a) => Boolean(a.localFilePath)) && (
                              <span
                                className="badge badge-success"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                              >
                                <FileText size={11} /> Material Salvo
                              </span>
                            )}
                          {!canSelect && (
                            <span className="badge badge-warning">
                              <Lock size={11} style={{ marginRight: 4 }} />
                              {lesson.availabilityStatus}
                            </span>
                          )}
                        </div>
                      </div>

                      {attCount > 0 && (
                        <div
                          style={{
                            marginLeft: 26,
                            marginTop: 4,
                            padding: '8px 12px',
                            background: 'rgba(0, 0, 0, 0.25)',
                            borderLeft: '3px solid #ef4444',
                            borderRadius: '0 6px 6px 0',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                          }}
                        >
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: 'var(--muted)',
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                            }}
                          >
                            Materiais e PDFs da Aula ({attCount})
                          </div>
                          {lesson.attachments!.map((att) => {
                            const isDownloading = downloadingAttId === att.id;
                            const isDownloaded = Boolean(att.localFilePath);

                            return (
                              <div
                                key={att.id}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 12,
                                  fontSize: 12,
                                  padding: '4px 6px',
                                  background: 'rgba(255, 255, 255, 0.03)',
                                  borderRadius: 4,
                                }}
                              >
                                <div
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    minWidth: 0,
                                  }}
                                >
                                  <FileText size={14} style={{ color: '#ef4444', flexShrink: 0 }} />
                                  <span style={{ fontWeight: 500, wordBreak: 'break-all' }}>
                                    {att.fileName}
                                  </span>
                                  {att.fileSize && (
                                    <span
                                      style={{
                                        fontSize: 11,
                                        color: 'var(--muted)',
                                        flexShrink: 0,
                                      }}
                                    >
                                      ({formatBytes(att.fileSize)})
                                    </span>
                                  )}
                                </div>

                                <div
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    flexShrink: 0,
                                  }}
                                >
                                  {isDownloaded ? (
                                    <button
                                      className="btn"
                                      style={{
                                        padding: '3px 8px',
                                        fontSize: 11,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        background: 'rgba(16, 185, 129, 0.15)',
                                        borderColor: 'rgba(16, 185, 129, 0.4)',
                                        color: '#34d399',
                                      }}
                                      onClick={() => void handleOpenAttachment(att.id)}
                                      title={`Abrir ${att.fileName}`}
                                    >
                                      <FolderOpen size={12} />
                                      Abrir PDF
                                    </button>
                                  ) : (
                                    <button
                                      className="btn btn-primary"
                                      style={{
                                        padding: '3px 8px',
                                        fontSize: 11,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4,
                                      }}
                                      disabled={!online || isDownloading}
                                      onClick={() => void handleDownloadAttachment(att.id)}
                                      title={`Baixar ${att.fileName}`}
                                    >
                                      <Download size={12} className={isDownloading ? 'spin' : ''} />
                                      {isDownloading ? 'Baixando...' : 'Baixar PDF'}
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

