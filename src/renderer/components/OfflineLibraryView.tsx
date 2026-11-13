import React, { useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, FileText, PlayCircle } from 'lucide-react';
import { CourseTreeDetails } from '../../shared/types';
import { VideoPlayer } from './VideoPlayer';

interface OfflineLibraryViewProps {
  offlineCourses: CourseTreeDetails[];
  onRefreshOffline: () => Promise<void>;
}

export const OfflineLibraryView: React.FC<OfflineLibraryViewProps> = ({
  offlineCourses,
  onRefreshOffline,
}) => {
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);

  const orderedLessonIds = useMemo(
    () =>
      offlineCourses.flatMap((c) =>
        c.modules.flatMap((m) =>
          m.lessons.filter((l) => Boolean(l.localFilePath)).map((l) => l.id),
        ),
      ),
    [offlineCourses],
  );

  const currentIdx = activeLessonId ? orderedLessonIds.indexOf(activeLessonId) : -1;
  const hasNextLesson = currentIdx >= 0 && currentIdx < orderedLessonIds.length - 1;

  const handleOpenAttachment = async (attachmentId: string) => {
    try {
      const res = await window.antigravity.attachments.openAttachment(attachmentId);
      if (!res.ok) {
        alert(res.error ?? 'Não foi possível abrir o arquivo.');
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro ao abrir anexo.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Biblioteca Offline & Player</h1>
          <p className="page-desc">
            Carregada integralmente do Vault local. Funciona sem conexão com a internet.
          </p>
        </div>
      </div>

      {activeLessonId && (
        <VideoPlayer
          lessonId={activeLessonId}
          hasNextLesson={hasNextLesson}
          onNextLesson={() => {
            if (hasNextLesson) {
              setActiveLessonId(orderedLessonIds[currentIdx + 1]);
            }
          }}
          onWatchedChanged={() => void onRefreshOffline()}
        />
      )}

      {offlineCourses.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--muted)' }}>
            Nenhum conteúdo baixado ainda. Após concluir o download de aulas ou arquivos/PDFs,
            eles aparecerão aqui para acesso offline.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {offlineCourses.map((tree) => (
            <div
              key={tree.course.id}
              className="card"
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <strong style={{ fontSize: 16 }}>{tree.course.title}</strong>

              {tree.modules.map((mod) => (
                <div key={mod.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>
                    Módulo {String(mod.orderIndex).padStart(2, '0')} — {mod.title}
                  </div>
                  {mod.lessons.map((lesson) => {
                    const isPlaying = activeLessonId === lesson.id;
                    const watched = lesson.progress?.isWatched ?? false;
                    const hasVideo = Boolean(lesson.localFilePath);
                    const downloadedAtts = (lesson.attachments ?? []).filter((a) =>
                      Boolean(a.localFilePath),
                    );

                    return (
                      <div
                        key={lesson.id}
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: '8px 12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          backgroundColor: isPlaying
                            ? 'rgba(99,102,241,0.06)'
                            : undefined,
                          borderColor: isPlaying ? 'var(--accent)' : undefined,
                        }}
                      >
                        <div className="row-between">
                          <div className="row-gap">
                            {hasVideo ? (
                              <PlayCircle size={16} color={isPlaying ? '#818cf8' : '#94a3b8'} />
                            ) : (
                              <FileText size={16} color="#818cf8" />
                            )}
                            <span style={{ fontSize: 13, fontWeight: 500 }}>
                              Aula {String(lesson.orderIndex).padStart(2, '0')} — {lesson.title}
                            </span>
                          </div>
                          <div className="row-gap">
                            {watched && (
                              <span className="badge badge-success">
                                <CheckCircle2 size={11} style={{ marginRight: 4 }} />
                                Assistida
                              </span>
                            )}
                            {hasVideo && (
                              <button
                                className="btn btn-primary"
                                onClick={() => setActiveLessonId(lesson.id)}
                              >
                                {isPlaying ? 'Reproduzindo' : 'Assistir'}
                              </button>
                            )}
                          </div>
                        </div>

                        {downloadedAtts.length > 0 && (
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: 8,
                              paddingTop: 6,
                              borderTop: '1px solid var(--border)',
                              marginTop: 4,
                            }}
                          >
                            <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}>
                              Materiais Offline:
                            </span>
                            {downloadedAtts.map((att) => (
                              <button
                                key={att.id}
                                className="btn"
                                style={{
                                  padding: '3px 8px',
                                  fontSize: 12,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                }}
                                onClick={() => void handleOpenAttachment(att.id)}
                                title={att.fileName}
                              >
                                <FileText size={12} color="#818cf8" />
                                <span>{att.fileName}</span>
                                <ExternalLink size={10} color="var(--muted)" />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

