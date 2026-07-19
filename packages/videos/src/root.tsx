import "./index.css";
import { Composition } from "remotion";

import { FilesSdkLaunch } from "./launch/composition";
import { TOTAL_DURATION as LAUNCH_DURATION } from "./launch/timings";
import { FilesSdk13 } from "./v1-3/composition";
import { TOTAL_DURATION as V13_DURATION } from "./v1-3/timings";
import { FilesSdk14 } from "./v1-4/composition";
import { TOTAL_DURATION as V14_DURATION } from "./v1-4/timings";
import { FilesSdk15 } from "./v1-5/composition";
import { TOTAL_DURATION as V15_DURATION } from "./v1-5/timings";
import { FilesSdk16 } from "./v1-6/composition";
import { TOTAL_DURATION as V16_DURATION } from "./v1-6/timings";
import { FilesSdk17 } from "./v1-7/composition";
import { TOTAL_DURATION as V17_DURATION } from "./v1-7/timings";
import { FilesSdk18 } from "./v1-8/composition";
import { TOTAL_DURATION as V18_DURATION } from "./v1-8/timings";
import { FilesSdk19 } from "./v1-9/composition";
import { TOTAL_DURATION as V19_DURATION } from "./v1-9/timings";
import { FilesSdk20 } from "./v2-0/composition";
import { TOTAL_DURATION as V20_DURATION } from "./v2-0/timings";
import { FilesSdk22 } from "./v2-2/composition";
import { TOTAL_DURATION as V22_DURATION } from "./v2-2/timings";

const VIDEOS = [
  {
    component: FilesSdkLaunch,
    duration: LAUNCH_DURATION,
    id: "FilesSdkLaunch",
  },
  { component: FilesSdk13, duration: V13_DURATION, id: "FilesSdk13" },
  { component: FilesSdk14, duration: V14_DURATION, id: "FilesSdk14" },
  { component: FilesSdk15, duration: V15_DURATION, id: "FilesSdk15" },
  { component: FilesSdk16, duration: V16_DURATION, id: "FilesSdk16" },
  { component: FilesSdk17, duration: V17_DURATION, id: "FilesSdk17" },
  { component: FilesSdk18, duration: V18_DURATION, id: "FilesSdk18" },
  { component: FilesSdk19, duration: V19_DURATION, id: "FilesSdk19" },
  { component: FilesSdk20, duration: V20_DURATION, id: "FilesSdk20" },
  { component: FilesSdk22, duration: V22_DURATION, id: "FilesSdk22" },
];

export const RemotionRoot: React.FC = () => (
  <>
    {VIDEOS.map(({ id, component, duration }) => (
      <Composition
        component={component}
        durationInFrames={duration}
        fps={30}
        height={1080}
        id={id}
        key={id}
        width={1920}
      />
    ))}
  </>
);
