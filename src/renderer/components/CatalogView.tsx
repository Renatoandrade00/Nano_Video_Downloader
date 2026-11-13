import React, { useState } from 'react';
import { CheckSquare, Download, FileText, Lock, RefreshCw, Square } from 'lucide-react';
import {
  CourseRecord,
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
    try {
      const details = await window.antigravity.catalog.getCourseDetails(course.id, forceRemote);
      setSelectedCourse(details);
      setSelectedLessonIds(new Set());
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Erro ao carregar módulos do curso.');
    } finally {
      setLoadingCourseId(null);
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
    setStatusMsg(null);
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
  };

  const isLessonSelectable = (lesson: {
    hasVideo: boolean;
    availabilityStatus: string;
    attachments?: unknown[];
  }) => {
    if (lesson.availabilityStatus !== 'AVAILABLE') return false;
    return downloadVideos || downloadAttachments;
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
            <div className="row-gap">
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

          {selectedCourse.modules.map((mod) => {
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
                  <div className="row-gap">
                    <button
                      className="btn"
                      style={{ padding: '4px 8px' }}
                      disabled={selectableIds.length === 0}
                      onClick={() => toggleModule(selectableIds)}
                    >
                      {allModSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                      Módulo {String(mod.orderIndex).padStart(2, '0')} — {mod.title}
                    </button>
                  </div>
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

                {mod.lessons.map((lesson) => {
                  const canSelect = isLessonSelectable(lesson);
                  const checked = selectedLessonIds.has(lesson.id);
                  const attCount = lesson.attachments?.length ?? 0;
                  return (
                    <div key={lesson.id} className="lesson-row">
                      <div className="row-gap">
                        <input
                          type="checkbox"
                          disabled={!canSelect}
                          checked={checked}
                          onChange={() => toggleLesson(lesson.id)}
                        />
                        <span style={{ fontSize: 13 }}>
                          Aula {String(lesson.orderIndex).padStart(2, '0')} — {lesson.title}
                        </span>
                        {attCount > 0 && (
                          <span
                            className="badge"
                            title={`${attCount} arquivo(s) disponível(is)`}
                            style={{
                              backgroundColor: 'rgba(99,102,241,0.15)',
                              color: '#818cf8',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              fontSize: 11,
                              padding: '2px 6px',
                            }}
                          >
                            <FileText size={11} />
                            {attCount} {attCount === 1 ? 'PDF/anexo' : 'PDFs/anexos'}
                          </span>
                        )}
                      </div>
                      <div className="row-gap">
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

