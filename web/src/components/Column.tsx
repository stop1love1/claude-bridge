import type { ReactNode } from "react";
import type { TaskSection } from "@/api/types";
import { cn } from "@/lib/cn";

interface Props {
  section: TaskSection;
  count: number;
  children: ReactNode;
}

const ACCENT: Record<TaskSection, string> = {
  TODO: "bg-status-todo",
  DOING: "bg-status-doing",
  BLOCKED: "bg-status-blocked",
  "DONE — not yet archived": "bg-status-done",
};

const LABEL: Record<TaskSection, string> = {
  TODO: "todo",
  DOING: "doing",
  BLOCKED: "blocked",
  "DONE — not yet archived": "done",
};

export default function Column({ section, count, children }: Props) {
  return (
    <section className="flex min-w-0 flex-col">
      <header className="mb-4 flex items-baseline gap-3 border-b border-border pb-2">
        <span className={cn("h-1.5 w-1.5 self-center rounded-full", ACCENT[section])} />
        <h2 className="font-mono text-micro uppercase tracking-wideish text-fg">
          {LABEL[section]}
        </h2>
        <span className="ml-auto font-mono text-micro tabular-nums text-muted-2">
          {String(count).padStart(2, "0")}
        </span>
      </header>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}
