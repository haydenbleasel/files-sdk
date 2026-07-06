import { Audio, Sequence, staticFile } from "remotion";

const PACK = "mxblack";
const GENERIC_ROWS = 5;

const pressSampleFor = (char: string, index: number): string => {
  if (char === " ") {
    return `${PACK}/press/SPACE.mp3`;
  }
  if (char === "\n") {
    return `${PACK}/press/ENTER.mp3`;
  }
  return `${PACK}/press/GENERIC_R${index % GENERIC_ROWS}.mp3`;
};

const releaseSampleFor = (char: string): string => {
  if (char === " ") {
    return `${PACK}/release/SPACE.mp3`;
  }
  if (char === "\n") {
    return `${PACK}/release/ENTER.mp3`;
  }
  return `${PACK}/release/GENERIC.mp3`;
};

const pseudoRandom = (i: number): number => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43_758.5453;
  return x - Math.floor(x);
};

interface TypingSoundsProps {
  startFrame: number;
  text: string;
  charsPerSec: number;
  fps: number;
  baseVolume?: number;
  releaseDelayFrames?: number;
  enabled?: boolean;
}

export const TypingSounds: React.FC<TypingSoundsProps> = ({
  startFrame,
  text,
  charsPerSec,
  fps,
  baseVolume = 0.55,
  releaseDelayFrames = 3,
  enabled = true,
}) => {
  if (!enabled) {
    return null;
  }
  const frameStep = fps / charsPerSec;
  const events: { frame: number; src: string; volume: number }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) {
      continue;
    }
    const pressFrame = Math.round(startFrame + i * frameStep);
    const volJitter = 0.82 + 0.22 * pseudoRandom(i + 7);
    events.push(
      {
        frame: pressFrame,
        src: pressSampleFor(ch, i),
        volume: baseVolume * volJitter,
      },
      {
        frame: pressFrame + releaseDelayFrames,
        src: releaseSampleFor(ch),
        volume: baseVolume * volJitter * 0.65,
      }
    );
  }
  const tail = Math.max(2, Math.ceil(fps * 0.3));
  return (
    <>
      {events.map((e, idx) => (
        <Sequence
          key={idx}
          from={e.frame}
          durationInFrames={tail}
          layout="none"
        >
          <Audio src={staticFile(e.src)} volume={e.volume} />
        </Sequence>
      ))}
    </>
  );
};
