// Tasks page — replaces v0.1 Board.tsx. Hosts the editorial header,
// the TaskGrid (filters / sort / kanban-vs-list view) and the
// NewTaskDialog action.

import TaskGrid from "@/components/TaskGrid";
import NewTaskDialog from "@/components/NewTaskDialog";

export default function Tasks() {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-10">
      <header className="mb-10 flex items-end justify-between gap-6">
        <div>
          <h1 className="font-mono text-display font-semibold tracking-tightish text-foreground">
            cross-repo console
          </h1>
          <p className="mt-2 max-w-xl text-small text-muted-foreground">
            tasks coordinate child claude sessions across the apps registered in{" "}
            <span className="font-mono text-foreground">bridge.json</span>. move cards
            between sections as work progresses; the bridge owns git.
          </p>
        </div>
      </header>

      <TaskGrid newTaskTrigger={<NewTaskDialog />} />
    </div>
  );
}
