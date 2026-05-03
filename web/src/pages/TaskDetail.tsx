// /tasks/:id page wrapper. Routing + breadcrumb only — the body of
// the page lives in `<TaskDetailView />` so it can be lifted into
// other surfaces (modal preview, side panel) in future.

import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import TaskDetailView from "@/components/TaskDetailView";

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();

  if (!id) {
    return (
      <div className="px-6 py-10 font-mono text-small text-status-blocked">
        missing task id.
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      <div className="shrink-0 border-b border-border bg-bg px-6 py-2">
        <Link
          to="/tasks"
          className="inline-flex items-center gap-2 font-mono text-micro uppercase tracking-wideish text-muted hover:text-fg"
        >
          <ArrowLeft size={12} />
          tasks
        </Link>
      </div>
      <TaskDetailView taskId={id} />
    </div>
  );
}
