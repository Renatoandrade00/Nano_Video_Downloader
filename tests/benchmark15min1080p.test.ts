import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchLike } from '../src/main/adapters/hotmartAdapter';
import { IPlatformAdapter, PurchaseRecord } from '../src/main/adapters/platformAdapter';
import { AdapterRegistry } from '../src/main/adapters/registry';
import { AuthManager } from '../src/main/auth/authManager';
import { MediaStreamInspector } from '../src/main/media/mediaInspector';
import { DecryptionAndRemuxer } from '../src/main/media/remuxer';
import { OwnershipVerifier } from '../src/main/ownership/ownershipVerifier';
import { QueueAndChunkManager } from '../src/main/queue/queueManager';
import { BandwidthLimiter } from '../src/main/queue/tokenBucket';
import { VaultDatabase } from '../src/main/vault/database';
import { createTestProtector, SecretStore } from '../src/main/vault/secretStore';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleCpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function generate15Min1080pSegments(workDir: string): Buffer[] {
  const base5s = path.join(workDir, 'base_5s_1080p.ts');
  const full15m = path.join(workDir, 'full_15m_1080p.ts');

  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x1e293b:s=1920x1080:r=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      '150k',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-f',
      'mpegts',
      base5s,
    ],
    { stdio: 'pipe' },
  );

  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-stream_loop',
      '179',
      '-i',
      base5s,
      '-c',
      'copy',
      '-t',
      '900',
      '-f',
      'mpegts',
      full15m,
    ],
    { stdio: 'pipe' },
  );

  const raw = fs.readFileSync(full15m);
  fs.unlinkSync(base5s);
  fs.unlinkSync(full15m);

  const packetSize = 188;
  const totalPackets = Math.floor(raw.length / packetSize);
  const segCount = 180;
  const packetsPerSeg = Math.max(1, Math.floor(totalPackets / segCount));
  const segments: Buffer[] = [];

  let offset = 0;
  for (let i = 0; i < segCount; i++) {
    const end =
      i === segCount - 1 ? raw.length : Math.min(raw.length, offset + packetsPerSeg * packetSize);
    segments.push(raw.subarray(offset, end));
    offset = end;
  }
  return segments;
}

describe('Benchmark T5.3 — 15 min @ 1080p Download & Remux (MVP-02, RNF-02, RNF-03)', () => {
  it('downloads and remuxes a 15-minute 1080p lesson within CPU/RAM budgets with A/V sync and watermark', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-bench-15m-'));
    tempDirs.push(dir);

    const segments = generate15Min1080pSegments(dir);
    expect(segments).toHaveLength(180);

    const mediaPlaylist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:5',
      ...segments.map((_, idx) => `#EXTINF:5.0,\nseg_${idx}.ts`),
      '#EXT-X-ENDLIST',
    ].join('\n');

    const mockFetch: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('master.m3u8')) {
        return new Response(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080\n1080p.m3u8\n',
          { status: 200 },
        );
      }
      if (url.endsWith('1080p.m3u8')) {
        return new Response(mediaPlaylist, { status: 200 });
      }
      const segMatch = /seg_(\d+)\.ts$/.exec(url);
      if (segMatch) {
        const idx = Number(segMatch[1]);
        return new Response(new Uint8Array(segments[idx]), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };

    const mockAdapter: IPlatformAdapter = {
      platformId: 'kiwify',
      getLoginConfig: () => ({
        platform: 'kiwify',
        loginUrl: 'https://dashboard.kiwify.com.br/login',
        successUrlPatterns: [/members/],
        cookieDomains: ['kiwify.com.br'],
        bearerStorageKeys: ['token'],
      }),
      async fetchPurchases(): Promise<PurchaseRecord[]> {
        return [
          {
            externalCourseId: 'kw_15m',
            courseTitle: 'Curso Benchmark 1080p',
            purchaseRef: 'KW-BENCH-900',
            rawStatus: 'ACTIVE',
            normalizedStatus: 'AUTHORIZED',
          },
        ];
      },
      async verifyCourseOwnership(_session, id) {
        return {
          externalCourseId: id,
          rawStatus: 'ACTIVE',
          normalizedStatus: 'AUTHORIZED',
          purchaseRef: 'KW-BENCH-900',
          checkedAt: new Date().toISOString(),
        };
      },
      async fetchCourseCatalog() {
        throw new Error('unused');
      },
      async resolveLessonMedia() {
        return {
          kind: 'HLS',
          manifestUrl: 'https://cdn.example.com/15min/master.m3u8',
        };
      },
    };

    const vaultDir = path.join(dir, 'vault');
    const libraryDir = path.join(dir, 'library');
    const db = new VaultDatabase(path.join(vaultDir, 'library.db'));

    try {
      const secrets = new SecretStore(vaultDir, createTestProtector('bench-test'));
      const adapters = new AdapterRegistry([mockAdapter]);
      const auth = new AuthManager(db, secrets, adapters, async () => ({
        bearerToken: 'tok-bench',
        cookies: [],
        email: 'bench@example.com',
        externalUserId: 'bench-user',
      }));

      const account = await auth.connectPlatform('kiwify');
      const now = new Date().toISOString();
      db.upsertCourse({
        id: 'c_bench',
        accountId: account.id,
        externalCourseId: 'kw_15m',
        title: 'Curso Benchmark 1080p',
        sanitizedFolder: 'Curso Benchmark 1080p',
        licenseStatus: 'AUTHORIZED',
        licenseCheckedAt: now,
        coverLocalPath: null,
      });
      db.upsertCourseTree('c_bench', [
        {
          module: {
            id: 'm_bench',
            courseId: 'c_bench',
            externalModuleId: 'ext_m1',
            orderIndex: 1,
            title: 'Módulo Performance',
            sanitizedFolder: 'Modulo_01',
          },
          lessons: [
            {
              id: 'l_bench',
              moduleId: 'm_bench',
              externalLessonId: 'ext_l1',
              orderIndex: 1,
              title: 'Aula 15 Minutos Full HD',
              durationSec: 900,
              hasVideo: true,
              availabilityStatus: 'AVAILABLE',
              localFilePath: null,
            },
          ],
        },
      ]);

      const ownership = new OwnershipVerifier(db, auth, adapters);
      const inspector = new MediaStreamInspector(mockFetch);
      const remuxer = new DecryptionAndRemuxer(secrets, 'ffmpeg');
      const limiter = new BandwidthLimiter(null);

      let remuxStartCpu: { idle: number; total: number } | null = null;
      let remuxEndCpu: { idle: number; total: number } | null = null;

      const queue = new QueueAndChunkManager(
        db,
        auth,
        adapters,
        ownership,
        inspector,
        remuxer,
        secrets,
        limiter,
        {
          stagingRootDir: path.join(vaultDir, 'staging'),
          getLibraryRootDir: () => libraryDir,
          maxConcurrentLessons: 1,
          maxChunksPerLesson: 4,
          fetchFn: mockFetch,
        },
        {
          onJobProgress: (ev) => {
            if (ev.state === 'REMUXING' && !remuxStartCpu) {
              remuxStartCpu = sampleCpuTotals();
            }
            if (ev.state === 'COMPLETED' && remuxStartCpu && !remuxEndCpu) {
              remuxEndCpu = sampleCpuTotals();
            }
          },
        },
      );

      // Measure baseline host CPU load for 300ms before starting download/remux
      const baseSnap1 = sampleCpuTotals();
      await new Promise((r) => setTimeout(r, 300));
      const baseSnap2 = sampleCpuTotals();
      const baseTotal = baseSnap2.total - baseSnap1.total;
      const baseIdle = baseSnap2.idle - baseSnap1.idle;
      const baselineBusyPercent =
        baseTotal > 0 ? ((baseTotal - baseIdle) / baseTotal) * 100 : 0;

      const baselineRssBytes = process.memoryUsage().rss;
      const enq = await queue.enqueueLessons(['l_bench'], '1080p');
      expect(enq.enqueuedJobIds).toHaveLength(1);
      const jobId = enq.enqueuedJobIds[0];

      await queue.waitUntilIdle();

      const doneJob = db.getJob(jobId)!;
      expect(doneJob.state).toBe('COMPLETED');
      expect(doneJob.completedSegments).toBe(180);

      // RNF-03: Incremental CPU consumed by remux/merge <= 60% of host idle CPU
      if (remuxStartCpu && remuxEndCpu) {
        const startSnap = remuxStartCpu as { idle: number; total: number };
        const endSnap = remuxEndCpu as { idle: number; total: number };
        const totalDelta = endSnap.total - startSnap.total;
        const idleDelta = endSnap.idle - startSnap.idle;
        if (totalDelta > 0) {
          const totalBusyDuringRemux = ((totalDelta - idleDelta) / totalDelta) * 100;
          const idleCapacity = Math.max(10, 100 - baselineBusyPercent);
          const remuxIncrementalBusy = Math.max(0, totalBusyDuringRemux - baselineBusyPercent);
          const idleConsumptionRatio = (remuxIncrementalBusy / idleCapacity) * 100;
          expect(idleConsumptionRatio).toBeLessThanOrEqual(60);
        }
      }

      // RNF-03: RSS memory delta after lesson completion (< +50 MB residual)
      const afterRssBytes = process.memoryUsage().rss;
      const rssDeltaMb = (afterRssBytes - baselineRssBytes) / (1024 * 1024);
      expect(rssDeltaMb).toBeLessThan(50);

      const expectedPath = path.join(
        libraryDir,
        'Curso Benchmark 1080p',
        'Modulo_01',
        'Aula_01 - Aula 15 Minutos Full HD.mp4',
      );
      expect(fs.existsSync(expectedPath)).toBe(true);

      // MVP-02 & RNF-02: Validate 1920x1080, ~900s A/V sync, and watermark tags via ffprobe
      const probeJson = execFileSync(
        'ffprobe',
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', expectedPath],
        { encoding: 'utf8' },
      );
      const probe = JSON.parse(probeJson) as {
        streams: Array<{
          codec_type: string;
          width?: number;
          height?: number;
          duration?: string;
        }>;
        format: {
          duration?: string;
          tags?: { comment?: string; title?: string };
        };
      };

      const videoStream = probe.streams.find((s) => s.codec_type === 'video');
      const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
      expect(videoStream).toBeDefined();
      expect(audioStream).toBeDefined();
      expect(videoStream?.width).toBe(1920);
      expect(videoStream?.height).toBe(1080);

      const vDur = Number(videoStream?.duration ?? probe.format.duration ?? 0);
      const aDur = Number(audioStream?.duration ?? probe.format.duration ?? 0);
      expect(vDur).toBeGreaterThanOrEqual(895);
      expect(vDur).toBeLessThanOrEqual(905);
      expect(Math.abs(vDur - aDur)).toBeLessThan(1.0);

      const comment = probe.format.tags?.comment ?? '';
      expect(comment).toContain('KW-BENCH-900');
      expect(comment).toContain('watermarkId');
      expect(comment).toContain('sig');
    } finally {
      db.close();
    }
  }, 60000);
});

