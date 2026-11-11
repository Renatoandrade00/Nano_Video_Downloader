export interface HlsKeyInfo {
  method: 'NONE' | 'AES-128' | 'SAMPLE-AES';
  uri?: string;
  iv?: string;
}

export interface HlsSegment {
  index: number;
  uri: string;
  durationSec: number;
  key?: HlsKeyInfo;
  initSegmentUri?: string;
}

export interface HlsVariant {
  bandwidth: number;
  resolutionHeight: number;
  resolutionLabel: string;
  uri: string;
  audioGroupId?: string;
}

export interface HlsAudioRendition {
  groupId: string;
  language?: string;
  name?: string;
  uri: string;
  isDefault: boolean;
}

export interface ParsedHlsMaster {
  isMaster: true;
  variants: HlsVariant[];
  audioRenditions: HlsAudioRendition[];
}

export interface ParsedHlsMedia {
  isMaster: false;
  segments: HlsSegment[];
}

export type ParsedHlsPlaylist = ParsedHlsMaster | ParsedHlsMedia;

function resolveUrl(baseUrl: string, relativeOrAbsolute: string): string {
  try {
    return new URL(relativeOrAbsolute, baseUrl).toString();
  } catch {
    return relativeOrAbsolute;
  }
}

function parseAttributes(attrLine: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(attrLine)) !== null) {
    result[match[1]] = match[3] !== undefined ? match[3] : match[2];
  }
  return result;
}

export function parseHlsPlaylist(content: string, playlistUrl: string): ParsedHlsPlaylist {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (isMaster) {
    const variants: HlsVariant[] = [];
    const audioRenditions: HlsAudioRendition[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
        if (attrs.TYPE === 'AUDIO' && attrs.URI) {
          audioRenditions.push({
            groupId: attrs['GROUP-ID'] ?? 'default',
            language: attrs.LANGUAGE,
            name: attrs.NAME,
            uri: resolveUrl(playlistUrl, attrs.URI),
            isDefault: attrs.DEFAULT === 'YES',
          });
        }
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        const nextLine = lines[i + 1];
        if (!nextLine || nextLine.startsWith('#')) continue;

        let height = 0;
        if (attrs.RESOLUTION && attrs.RESOLUTION.includes('x')) {
          height = Number(attrs.RESOLUTION.split('x')[1]) || 0;
        }
        const bandwidth = Number(attrs.BANDWIDTH) || 0;
        variants.push({
          bandwidth,
          resolutionHeight: height,
          resolutionLabel: height > 0 ? `${height}p` : `${Math.round(bandwidth / 1000)}k`,
          uri: resolveUrl(playlistUrl, nextLine),
          audioGroupId: attrs.AUDIO,
        });
        i++;
      }
    }

    return {
      isMaster: true,
      variants: variants.sort((a, b) => b.resolutionHeight - a.resolutionHeight || b.bandwidth - a.bandwidth),
      audioRenditions,
    };
  }

  const segments: HlsSegment[] = [];
  let currentDuration = 0;
  let currentKey: HlsKeyInfo | undefined;
  let currentInitUri: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = (attrs.METHOD ?? 'NONE') as HlsKeyInfo['method'];
      currentKey = {
        method,
        uri: attrs.URI ? resolveUrl(playlistUrl, attrs.URI) : undefined,
        iv: attrs.IV,
      };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        currentInitUri = resolveUrl(playlistUrl, attrs.URI);
      }
    } else if (line.startsWith('#EXTINF:')) {
      const durStr = line.slice('#EXTINF:'.length).split(',')[0];
      currentDuration = parseFloat(durStr) || 0;
    } else if (!line.startsWith('#')) {
      segments.push({
        index: segments.length,
        uri: resolveUrl(playlistUrl, line),
        durationSec: currentDuration,
        key: currentKey,
        initSegmentUri: currentInitUri,
      });
      currentDuration = 0;
    }
  }

  return { isMaster: false, segments };
}

