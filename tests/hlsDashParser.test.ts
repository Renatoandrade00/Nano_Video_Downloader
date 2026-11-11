import { describe, expect, it } from 'vitest';
import { parseDashManifest } from '../src/main/media/dashParser';
import { parseHlsPlaylist } from '../src/main/media/hlsParser';
import { selectVariantByHeight } from '../src/main/media/mediaInspector';

describe('HLS & DASH parsers + Resolution selection (RF-06, RF-07)', () => {
  it('parses HLS master playlist with separate audio and media segments with AES-128 key', () => {
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Portuguese",DEFAULT=YES,URI="audio/prog.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="audio"
720p/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,AUDIO="audio"
1080p/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,AUDIO="audio"
480p/prog.m3u8`;

    const parsedMaster = parseHlsPlaylist(master, 'https://cdn.example.com/v1/master.m3u8');
    expect(parsedMaster.isMaster).toBe(true);
    if (!parsedMaster.isMaster) return;

    expect(parsedMaster.variants).toHaveLength(3);
    expect(parsedMaster.audioRenditions[0].uri).toBe(
      'https://cdn.example.com/v1/audio/prog.m3u8',
    );

    const chosen1080 = selectVariantByHeight(parsedMaster.variants, '1080p');
    expect(chosen1080.resolutionHeight).toBe(1080);

    const fallback360 = selectVariantByHeight(parsedMaster.variants, '360p');
    expect(fallback360.resolutionHeight).toBe(480);

    const media = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001
#EXTINF:4.0,
seg0.ts
#EXTINF:4.0,
seg1.ts`;

    const parsedMedia = parseHlsPlaylist(media, 'https://cdn.example.com/v1/1080p/prog.m3u8');
    expect(parsedMedia.isMaster).toBe(false);
    if (parsedMedia.isMaster) return;
    expect(parsedMedia.segments).toHaveLength(2);
    expect(parsedMedia.segments[0].key?.method).toBe('AES-128');
    expect(parsedMedia.segments[0].key?.uri).toBe('https://cdn.example.com/v1/1080p/key.bin');
  });

  it('parses DASH MPD with SegmentTemplate and SegmentTimeline', () => {
    const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="v720" bandwidth="2000000" height="720">
        <SegmentTemplate initialization="init_$RepresentationID$.mp4" media="seg_$RepresentationID$_$Number$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="4000" r="2"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
      <Representation id="v1080" bandwidth="4000000" height="1080">
        <SegmentTemplate initialization="init_$RepresentationID$.mp4" media="seg_$RepresentationID$_$Number$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="4000" r="2"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio">
      <Representation id="a128" bandwidth="128000">
        <SegmentTemplate initialization="init_$RepresentationID$.mp4" media="seg_$RepresentationID$_$Number$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="4000" r="2"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

    const parsed = parseDashManifest(mpd, 'https://cdn.example.com/dash/manifest.mpd');
    expect(parsed.videoRepresentations).toHaveLength(2);
    expect(parsed.audioRepresentations).toHaveLength(1);
    expect(parsed.videoRepresentations[0].height).toBe(1080);
    expect(parsed.videoRepresentations[0].segments).toHaveLength(3);
    expect(parsed.videoRepresentations[0].segments[2].uri).toBe(
      'https://cdn.example.com/dash/seg_v1080_3.m4s',
    );
  });
});

