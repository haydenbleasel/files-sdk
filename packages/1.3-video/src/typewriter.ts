import { useCurrentFrame, useVideoConfig } from "remotion";

export const useTypewriter = (
  text: string,
  startFrame: number,
  charsPerSecond: number
) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsed = Math.max(0, frame - startFrame);
  const charsToShow = Math.min(
    text.length,
    Math.floor((elapsed / fps) * charsPerSecond)
  );
  return text.slice(0, charsToShow);
};

export const useCharBudget = (
  startFrame: number,
  charsPerSecond: number
): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsed = Math.max(0, frame - startFrame);
  return Math.floor((elapsed / fps) * charsPerSecond);
};
