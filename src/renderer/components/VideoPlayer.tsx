import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Maximize,
  Pause,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { PlayerOpenResult } from '../../shared/types';

interface VideoPlayerProps {
  lessonId: string;
  hasNextLesson: boolean;
  onNextLesson: () => void;
  onWatchedChanged: () => void;
}

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  lessonId,
  hasNextLesson,
  onNextLesson,
  onWatchedChanged,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [session, setSession] = useState<PlayerOpenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1.0);
  const [isWatched, setIsWatched] = useState(false);

  const persistProgress = useCallback(
    async (pos: number, spd: number, forceWatched?: boolean) => {
      try {
        const res = await window.antigravity.player.saveProgress(
          lessonId,
          pos,
          spd,
          forceWatched,
        );
        if (res.isWatched !== isWatched) {
          setIsWatched(res.isWatched);
          onWatchedChanged();
        }
      } catch {
        // Ignore transient save errors
      }
    },
    [lessonId, isWatched, onWatchedChanged],
  );

  useEffect(() => {
    let active = true;
    setError(null);
    setSession(null);

    window.antigravity.player
      .openLesson(lessonId)
      .then((res) => {
        if (!active) return;
        setSession(res);
        setSpeed(res.progress.playbackSpeed || 1.0);
        setIsWatched(res.progress.isWatched);
        setCurrentTime(res.progress.lastPositionSec || 0);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Erro ao abrir arquivo local.');
      });

    return () => {
      active = false;
      const vid = videoRef.current;
      if (vid) {
        void window.antigravity.player.saveProgress(
          lessonId,
          vid.currentTime,
          vid.playbackRate,
        );
      }
    };
  }, [lessonId]);

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      const vid = videoRef.current;
      if (vid && !vid.paused) {
        void persistProgress(vid.currentTime, vid.playbackRate);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [session, persistProgress]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const vid = videoRef.current;
      if (!vid || (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === ' ' || key === 'k') {
        e.preventDefault();
        if (vid.paused) void vid.play();
        else vid.pause();
      } else if (key === 'arrowleft' || key === 'j') {
        e.preventDefault();
        vid.currentTime = Math.max(0, vid.currentTime - 10);
      } else if (key === 'arrowright' || key === 'l') {
        e.preventDefault();
        vid.currentTime = Math.min(vid.duration || vid.currentTime + 10, vid.currentTime + 10);
      } else if (key === 'arrowup') {
        e.preventDefault();
        vid.volume = Math.min(1, vid.volume + 0.1);
      } else if (key === 'arrowdown') {
        e.preventDefault();
        vid.volume = Math.max(0, vid.volume - 0.1);
      } else if (key === 'm') {
        e.preventDefault();
        vid.muted = !vid.muted;
        setMuted(vid.muted);
      } else if (key === 'f') {
        e.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen();
        else void containerRef.current?.requestFullscreen();
      } else if (key === '[' || key === '<') {
        e.preventDefault();
        const idx = SPEEDS.indexOf(vid.playbackRate);
        const next = SPEEDS[Math.max(0, (idx === -1 ? 2 : idx) - 1)];
        vid.playbackRate = next;
        setSpeed(next);
      } else if (key === ']' || key === '>') {
        e.preventDefault();
        const idx = SPEEDS.indexOf(vid.playbackRate);
        const next = SPEEDS[Math.min(SPEEDS.length - 1, (idx === -1 ? 2 : idx) + 1)];
        vid.playbackRate = next;
        setSpeed(next);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (error) {
    return <div className="banner-alert">{error}</div>;
  }
  if (!session) {
    return <div className="card">Carregando vídeo local do Vault...</div>;
  }

  return (
    <div ref={containerRef} className="player-container">
      <video
        ref={videoRef}
        src={session.fileUrl}
        className="player-video"
        onLoadedMetadata={(e) => {
          const vid = e.currentTarget;
          setDuration(vid.duration || session.lesson.durationSec);
          vid.playbackRate = speed;
          if (session.progress.lastPositionSec > 0 && session.progress.lastPositionSec < vid.duration) {
            vid.currentTime = session.progress.lastPositionSec;
          }
        }}
        onPlay={() => setPlaying(true)}
        onPause={(e) => {
          setPlaying(false);
          void persistProgress(e.currentTarget.currentTime, e.currentTarget.playbackRate);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onEnded={(e) => {
          setPlaying(false);
          void persistProgress(
            e.currentTarget.duration || currentTime,
            e.currentTarget.playbackRate,
            true,
          );
        }}
        onClick={() => {
          const vid = videoRef.current;
          if (!vid) return;
          if (vid.paused) void vid.play();
          else vid.pause();
        }}
      />

      <div className="player-controls">
        <input
          type="range"
          min={0}
          max={duration || 100}
          value={currentTime}
          onChange={(e) => {
            const val = Number(e.target.value);
            setCurrentTime(val);
            if (videoRef.current) videoRef.current.currentTime = val;
          }}
        />

        <div className="row-between">
          <div className="row-gap">
            <button
              className="btn btn-primary"
              onClick={() => {
                const vid = videoRef.current;
                if (!vid) return;
                if (vid.paused) void vid.play();
                else vid.pause();
              }}
            >
              {playing ? <Pause size={15} /> : <Play size={15} />}
              {playing ? 'Pausar' : 'Reproduzir'}
            </button>

            <button
              className="btn"
              onClick={() => {
                const vid = videoRef.current;
                if (!vid) return;
                vid.muted = !vid.muted;
                setMuted(vid.muted);
              }}
            >
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>

            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="row-gap">
            <select
              className="select-input"
              value={speed}
              onChange={(e) => {
                const next = Number(e.target.value);
                setSpeed(next);
                if (videoRef.current) videoRef.current.playbackRate = next;
              }}
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>

            <button
              className={`btn ${isWatched ? 'badge-success' : ''}`}
              onClick={() => void persistProgress(currentTime, speed, !isWatched)}
            >
              <CheckCircle2 size={14} />
              {isWatched ? 'Assistida' : 'Marcar Assistida'}
            </button>

            {hasNextLesson && (
              <button className="btn" onClick={onNextLesson}>
                <SkipForward size={14} /> Próxima
              </button>
            )}

            <button
              className="btn"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else void containerRef.current?.requestFullscreen();
              }}
            >
              <Maximize size={14} />
            </button>
          </div>
        </div>

        <div className="row-between" style={{ fontSize: 11, color: 'var(--muted)' }}>
          <span>
            Atalhos: Espaço/K (Play) • J/L ou Setas (-10s/+10s) • M (Mudo) • F (Tela Cheia) • [ / ] (Velocidade)
          </span>
          {session.watermark && (
            <span>Licença: {session.watermark.watermarkId.slice(0, 8)}</span>
          )}
        </div>
      </div>
    </div>
  );
};

