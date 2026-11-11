import React, { useMemo, useState } from 'react';
import { CheckCircle2, PlayCircle } from 'lucide-react';
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
        c.modules.flatMap((m) => m.lessons.map((l) => l.id)),
      ),
    [offlineCourses],
  );

  const currentIdx = activeLessonId ? orderedLessonIds.indexOf(activeLessonId) : -1;
  const hasNextLesson = currentIdx >= 0 && currentIdx < orderedLessonIds.length - 1;

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
            Nenhum vídeo baixado ainda. Após concluir o download de uma aula, ela aparecerá aqui
            para reprodução offline.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {offlineCourses.map((tree) => (
            <div key={tree.course.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <strong style={{ fontSize: 16 }}>{tree.course.title}</strong>

              {tree.modules.map((mod) => (
                <div key={mod.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>
                    Módulo {String(mod.orderIndex).padStart(2, '0')} — {mod.title}
                  </div>
                  {mod.lessons.map((lesson) => {
                    const isPlaying = activeLessonId === lesson.id;
                    const watched = lesson.progress?.isWatched ?? false;
                    return (
                      <div
                        key={lesson.id}
                        className="lesson-row"
                        style={
                          isPlaying ? { borderColor: 'var(--accent)' } : undefined
                        }
                      >
                        <div className="row-gap">
                          <PlayCircle size={16} color={isPlaying ? '#818cf8' : '#94a3b8'} />
                          <span style={{ fontSize: 13 }}>
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
                          <button
                            className="btn btn-primary"
                            onClick={() => setActiveLessonId(lesson.id)}
                          >
                            {isPlaying ? 'Reproduzindo' : 'Assistir'}
                          </button>
                        </div>
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

