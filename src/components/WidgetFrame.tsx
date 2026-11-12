import type { ReactNode } from "react";
import TitleBar from "./TitleBar";
import { SigilDefs } from "./Sigils";

type Props = { title: string; icon: ReactNode; children: ReactNode };

/** The frame of a popped-out widget window: gunmetal border, title bar, shared SVG defs. */
export default function WidgetFrame({ title, icon, children }: Props) {
  return (
    <div className="widget">
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <SigilDefs />
      </svg>
      <TitleBar title={title} icon={icon} />
      {children}
    </div>
  );
}
