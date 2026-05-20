import { AbsoluteFill, Sequence } from "remotion";

import { AdaptersScene } from "./adapters-scene";
import { Background } from "./background";
import { CliScene } from "./cli-scene";
import { IntroScene } from "./intro-scene";
import { Outro } from "./outro";
import { SkillScene } from "./skill-scene";
import { TIMING } from "./timings";

export const FilesSdk14: React.FC = () => (
  <AbsoluteFill style={{ background: "#1a1410" }}>
    <Background />
    <Sequence
      from={TIMING.intro.from}
      durationInFrames={TIMING.intro.duration}
      layout="none"
    >
      <IntroScene />
    </Sequence>
    <Sequence
      from={TIMING.adapters.from}
      durationInFrames={TIMING.adapters.duration}
      layout="none"
    >
      <AdaptersScene />
    </Sequence>
    <Sequence
      from={TIMING.cli.from}
      durationInFrames={TIMING.cli.duration}
      layout="none"
    >
      <CliScene />
    </Sequence>
    <Sequence
      from={TIMING.skill.from}
      durationInFrames={TIMING.skill.duration}
      layout="none"
    >
      <SkillScene />
    </Sequence>
    <Sequence
      from={TIMING.outro.from}
      durationInFrames={TIMING.outro.duration}
      layout="none"
    >
      <Outro />
    </Sequence>
  </AbsoluteFill>
);
