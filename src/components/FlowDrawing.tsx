"use client";

import dynamic from "next/dynamic";

// The drawing laid out in the browser (issue #62), behind ?draw=flow. ELK,
// React Flow and d3-force are loaded only here, when it is asked for.
const FlowCanvas = dynamic(() => import("./flow/FlowCanvas"), {
  ssr: false,
  loading: () => <div className="flow-frame" />,
});

// `hrefs` gives the page of each workflow's box on a system's map, by its id
// in the engine's drawing.
export function FlowDrawing({ text, hrefs }: { text: string; hrefs?: Record<string, string> }) {
  return <FlowCanvas text={text} hrefs={hrefs} />;
}
