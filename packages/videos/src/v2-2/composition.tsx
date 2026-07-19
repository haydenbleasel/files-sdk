import { AbsoluteFill, Sequence } from "remotion";

import { Background } from "../shared/background";
import { IntroScene } from "../shared/intro-scene";
import { Outro } from "../shared/outro";
import { NativeScene } from "./native-scene";
import { NestjsScene } from "./nestjs-scene";
import { R2FetchScene } from "./r2-fetch-scene";
import { TIMING } from "./timings";

const SCENES = [
  { Component: NestjsScene, key: "nestjs" as const },
  { Component: R2FetchScene, key: "r2Fetch" as const },
  { Component: NativeScene, key: "native" as const },
];

export const FilesSdk22: React.FC = () => (
  <AbsoluteFill style={{ background: "#1a1410" }}>
    <Background src="background-2.jpg" />
    <Sequence
      durationInFrames={TIMING.intro.duration}
      from={TIMING.intro.from}
      layout="none"
    >
      <IntroScene
        command="npm i files-sdk@2.2.0"
        durationInFrames={TIMING.intro.duration}
        tagline="first-class NestJS · an AWS-SDK-free R2 client · React Native"
        version="v2.2"
      />
    </Sequence>
    {SCENES.map(({ Component, key }) => (
      <Sequence
        durationInFrames={TIMING[key].duration}
        from={TIMING[key].from}
        key={key}
        layout="none"
      >
        <Component />
      </Sequence>
    ))}
    <Sequence
      durationInFrames={TIMING.outro.duration}
      from={TIMING.outro.from}
      layout="none"
    >
      <Outro tagline="One API for every runtime." />
    </Sequence>
  </AbsoluteFill>
);
