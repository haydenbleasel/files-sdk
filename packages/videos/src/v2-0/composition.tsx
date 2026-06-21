import { AbsoluteFill, Sequence } from "remotion";

import { Background } from "../shared/background";
import { IntroScene } from "../shared/intro-scene";
import { Outro } from "../shared/outro";
import { TabbedEditor } from "./tabbed-editor";
import { TIMING } from "./timings";

export const FilesSdk20: React.FC = () => (
  <AbsoluteFill style={{ background: "#1a1410" }}>
    <Background src="background-3.jpg" />
    <Sequence
      durationInFrames={TIMING.intro.duration}
      from={TIMING.intro.from}
      layout="none"
    >
      <IntroScene
        command="npm i files-sdk@2.0.0"
        durationInFrames={TIMING.intro.duration}
        tagline="client hooks · server routing · a shadcn registry"
        version="v2.0"
      />
    </Sequence>
    <Sequence
      durationInFrames={TIMING.editor.duration}
      from={TIMING.editor.from}
      layout="none"
    >
      <TabbedEditor />
    </Sequence>
    <Sequence
      durationInFrames={TIMING.outro.duration}
      from={TIMING.outro.from}
      layout="none"
    >
      <Outro tagline="From your bucket to the browser. One API." />
    </Sequence>
  </AbsoluteFill>
);
