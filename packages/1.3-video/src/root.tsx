import "./index.css";
import { Composition } from "remotion";

import { FilesSdk13 } from "./composition";
import { TOTAL_DURATION } from "./timings";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="FilesSdk13"
      component={FilesSdk13}
      durationInFrames={TOTAL_DURATION}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);
