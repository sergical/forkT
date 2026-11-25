import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { BookMarkedIcon } from "lucide-react";
import { use } from "react";

import { TimelineRowCtx } from "../chat/timelineRowContext";
import { WorkLogButton, WorkLogRow } from "../chat/WorkLog";
import type { MemoryChange } from "./memories.logic";
import { memoryDetailSearch } from "./memories.logic";

/** One quiet line for a memory an agent saved, updated or removed in this thread. */
export function MemoryChangeTimelineRow({ change }: { change: MemoryChange }) {
  const gt = useGT();
  const navigate = useNavigate();
  const { threadRef } = use(TimelineRowCtx);
  const label =
    change.title === null
      ? gt(
          "{action, select, saved {Saved memory} updated {Updated memory} other {Removed memory}}",
          { action: change.action },
        )
      : gt(
          "{action, select, saved {Saved memory · {title}} updated {Updated memory · {title}} other {Removed memory · {title}}}",
          { action: change.action, title: change.title },
        );
  const icon = <BookMarkedIcon className="size-3.5 text-icon-muted" aria-hidden />;
  const environmentId = change.memory?.environmentId ?? threadRef?.environmentId ?? null;
  const memory = change.memory;
  return change.linked && memory !== null && environmentId !== null ? (
    <WorkLogButton
      icon={icon}
      label={label}
      onClick={() =>
        void navigate({
          to: "/settings/memories",
          search: memoryDetailSearch({ ...memory, environmentId }),
        })
      }
    />
  ) : (
    <WorkLogRow icon={icon} label={label} />
  );
}
