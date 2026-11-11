import { ResolutionOption, StreamType, TrackType } from '../../shared/types';
import { FetchLike } from '../adapters/hotmartAdapter';
import { MediaDescriptor } from '../adapters/platformAdapter';
import { parseDashManifest } from './dashParser';
import { HlsKeyInfo, parseHlsPlaylist } from './hlsParser';

export interface SegmentDownloadTask {
  trackType: TrackType;
  segmentIndex: number;
  uri: string;
  initSegmentUri?: string;
  byteRange?: { start: number; end: number };
  hlsKey?: HlsKeyInfo;
}

export interface InspectedMediaPlan {
  streamType: StreamType;
  selectedResolution: string;
  headers: Record<string, string>;
  segments: SegmentDownloadTask[];
  estimatedTotalBytes: number;
}

const RESOLUTION_HEIGHT_MAP: Record<ResolutionOption, number> = {
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
  '360p': 360,
};

const DIRECT_CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB virtual chunks for resumable HTTP range downloads

/**
 * Selects the best matching variant height: exact match if available, otherwise highest
 * available <= target, or lowest available if all exceed target.
 */
export function selectVariantByHeight<T extends { resolutionHeight?: number; height?: number }>(
  variants: T[],
  target: ResolutionOption,
): T {
  if (variants.length === 0) {
    throw new Error('Nenhuma variante de vídeo disponível no manifesto.');
  }
  const targetHeight = RESOLUTION_HEIGHT_MAP[target];
  const withHeight = variants.map((v) => ({
    v,
    h: v.resolutionHeight ?? v.height ?? 0,
  }));

  const exact = withHeight.find((x) => x.h === targetHeight);
  if (exact) return exact.v;

  const lowerOrEqual = withHeight
    .filter((x) => x.h > 0 && x.h <= targetHeight)
    .sort((a, b) => b.h - a.h);
  if (lowerOrEqual.length > 0) return lowerOrEqual[0].v;

  const sortedAsc = [...withHeight].sort((a, b) => a.h - b.h);
  return sortedAsc[0].v;
}

export class MediaStreamInspector {
  private readonly fetchFn: FetchLike;

  constructor(fetchFn: FetchLike = fetch) {
    this.fetchFn = fetchFn;
  }

  async inspect(
    descriptor: MediaDescriptor,
    preferredResolution: ResolutionOption,
  ): Promise<InspectedMediaPlan> {
    if (descriptor.kind === 'DRM_UNSUPPORTED') {
      throw new Error('DRM_UNSUPPORTED: Conteúdo protegido por DRM comercial não suportado.');
    }
    if (descriptor.kind === 'NO_VIDEO' || !descriptor.manifestUrl) {
      throw new Error('NO_VIDEO: Aula não possui vídeo elegível.');
    }

    const headers = descriptor.headers ?? {};
    if (descriptor.kind === 'HLS') {
      return this.inspectHls(descriptor.manifestUrl, headers, preferredResolution);
    }
    if (descriptor.kind === 'DASH') {
      return this.inspectDash(descriptor.manifestUrl, headers, preferredResolution);
    }
    return this.inspectDirect(descriptor.manifestUrl, headers, descriptor.directContentLength);
  }

  private async inspectHls(
    manifestUrl: string,
    headers: Record<string, string>,
    preferredResolution: ResolutionOption,
  ): Promise<InspectedMediaPlan> {
    const res = await this.fetchFn(manifestUrl, { headers });
    if (!res.ok) {
      throw new Error(`HLS manifest fetch failed (${res.status})`);
    }
    const text = await res.text();
    const parsed = parseHlsPlaylist(text, manifestUrl);

    if (!parsed.isMaster) {
      return {
        streamType: 'HLS',
        selectedResolution: preferredResolution,
        headers,
        estimatedTotalBytes: 0,
        segments: parsed.segments.map((s) => ({
          trackType: 'MUXED',
          segmentIndex: s.index,
          uri: s.uri,
          initSegmentUri: s.initSegmentUri,
          hlsKey: s.key,
        })),
      };
    }

    const chosenVariant = selectVariantByHeight(parsed.variants, preferredResolution);
    const videoRes = await this.fetchFn(chosenVariant.uri, { headers });
    if (!videoRes.ok) {
      throw new Error(`HLS video variant fetch failed (${videoRes.status})`);
    }
    const videoParsed = parseHlsPlaylist(await videoRes.text(), chosenVariant.uri);
    if (videoParsed.isMaster) {
      throw new Error('Unexpected nested HLS master playlist.');
    }

    const hasSeparateAudio = Boolean(
      chosenVariant.audioGroupId &&
        parsed.audioRenditions.some((a) => a.groupId === chosenVariant.audioGroupId),
    );
    const segments: SegmentDownloadTask[] = videoParsed.segments.map((s) => ({
      trackType: hasSeparateAudio ? 'VIDEO' : 'MUXED',
      segmentIndex: s.index,
      uri: s.uri,
      initSegmentUri: s.initSegmentUri,
      hlsKey: s.key,
    }));

    if (hasSeparateAudio) {
      const audioRendition =
        parsed.audioRenditions.find(
          (a) => a.groupId === chosenVariant.audioGroupId && a.isDefault,
        ) ??
        parsed.audioRenditions.find((a) => a.groupId === chosenVariant.audioGroupId)!;

      const audioRes = await this.fetchFn(audioRendition.uri, { headers });
      if (!audioRes.ok) {
        throw new Error(`HLS audio rendition fetch failed (${audioRes.status})`);
      }
      const audioParsed = parseHlsPlaylist(await audioRes.text(), audioRendition.uri);
      if (!audioParsed.isMaster) {
        for (const s of audioParsed.segments) {
          segments.push({
            trackType: 'AUDIO',
            segmentIndex: s.index,
            uri: s.uri,
            initSegmentUri: s.initSegmentUri,
            hlsKey: s.key,
          });
        }
      }
    }

    return {
      streamType: 'HLS',
      selectedResolution: chosenVariant.resolutionLabel,
      headers,
      segments,
      estimatedTotalBytes: 0,
    };
  }

  private async inspectDash(
    mpdUrl: string,
    headers: Record<string, string>,
    preferredResolution: ResolutionOption,
  ): Promise<InspectedMediaPlan> {
    const res = await this.fetchFn(mpdUrl, { headers });
    if (!res.ok) {
      throw new Error(`DASH MPD fetch failed (${res.status})`);
    }
    const xml = await res.text();
    const parsed = parseDashManifest(xml, mpdUrl);

    const chosenVideo = selectVariantByHeight(parsed.videoRepresentations, preferredResolution);
    const hasAudio = parsed.audioRepresentations.length > 0;
    const segments: SegmentDownloadTask[] = chosenVideo.segments.map((s) => ({
      trackType: hasAudio ? 'VIDEO' : 'MUXED',
      segmentIndex: s.index,
      uri: s.uri,
      initSegmentUri: s.initUri,
    }));

    if (hasAudio) {
      const chosenAudio = parsed.audioRepresentations[0];
      for (const s of chosenAudio.segments) {
        segments.push({
          trackType: 'AUDIO',
          segmentIndex: s.index,
          uri: s.uri,
          initSegmentUri: s.initUri,
        });
      }
    }

    return {
      streamType: 'DASH',
      selectedResolution: chosenVideo.height > 0 ? `${chosenVideo.height}p` : preferredResolution,
      headers,
      segments,
      estimatedTotalBytes: 0,
    };
  }

  private async inspectDirect(
    url: string,
    headers: Record<string, string>,
    knownLength?: number,
  ): Promise<InspectedMediaPlan> {
    let totalBytes = knownLength ?? 0;
    let supportsRanges = false;

    try {
      const headRes = await this.fetchFn(url, { method: 'HEAD', headers });
      if (headRes.ok) {
        const lenHeader = headRes.headers.get('content-length');
        if (lenHeader) totalBytes = Number(lenHeader) || totalBytes;
        supportsRanges = (headRes.headers.get('accept-ranges') ?? '').toLowerCase() === 'bytes';
      }
    } catch {
      // Fallback to single-segment download if HEAD is blocked
    }

    if (!supportsRanges || totalBytes <= DIRECT_CHUNK_SIZE_BYTES) {
      return {
        streamType: 'DIRECT',
        selectedResolution: 'direct',
        headers,
        estimatedTotalBytes: totalBytes,
        segments: [
          {
            trackType: 'MUXED',
            segmentIndex: 0,
            uri: url,
          },
        ],
      };
    }

    const segments: SegmentDownloadTask[] = [];
    let offset = 0;
    let index = 0;
    while (offset < totalBytes) {
      const end = Math.min(totalBytes - 1, offset + DIRECT_CHUNK_SIZE_BYTES - 1);
      segments.push({
        trackType: 'MUXED',
        segmentIndex: index,
        uri: url,
        byteRange: { start: offset, end },
      });
      offset = end + 1;
      index++;
    }

    return {
      streamType: 'DIRECT',
      selectedResolution: 'direct',
      headers,
      estimatedTotalBytes: totalBytes,
      segments,
    };
  }
}

