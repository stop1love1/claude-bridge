import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import Column from "@/components/Column";
import TaskCard from "@/components/TaskCard";
import Modal from "@/components/Modal";
import { useApps, useCreateTask, useTasksMeta } from "@/api/queries";
import { SECTIONS, type TaskMeta, type TaskSection } from "@/api/types";

export default function Board() {
  const { data, isLoading, error } = useTasksMeta();
  const [createOpen, setCreateOpen] = useState(false);

  const grouped = useMemo(() => {
    const m: Record<TaskSection, TaskMeta[]> = {
      TODO: [],
      DOING: [],
      BLOCKED: [],
      "DONE — not yet archived": [],
    };
    for (const t of data?.tasks ?? []) {
      const sec = SECTIONS.includes(t.taskSection) ? t.taskSection : "TODO";
      m[sec].push(t);
    }
    // Sort within each column: live runs first, then most recently created.
    for (const s of SECTIONS) {
      m[s].sort((a, b) => {
        const al = a.runs.some((r) => r.status === "running") ? 1 : 0;
        const bl = b.runs.some((r) => r.status === "running") ? 1 : 0;
        if (al !== bl) return bl - al;
        return b.createdAt.localeCompare(a.createdAt);
      });
    }
    return m;
  }, [data]);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-10">
      <div className="mb-10 flex items-end justify-between gap-6">
        <div>
          <h1 className="font-mono text-display font-semibold tracking-tightish text-fg">
            cross-repo console
          </h1>
          <p className="mt-2 max-w-xl text-small text-muted">
            tasks coordinate child claude sessions across the apps registered in{" "}
            <span className="font-mono text-fg">bridge.json</span>.
            move cards between columns as work progresses; the bridge owns git.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded-sm border border-accent/40 bg-accent/10 px-4 py-2 font-mono text-micro uppercase tracking-wideish text-accent transition-colors hover:bg-accent hover:text-bg"
        >
          <Plus size={14} />
          new task
        </button>
      </div>

      {isLoading && (
        <div className="font-mono text-micro tracking-wideish text-muted">
          loading sessions…
        </div>
      )}
      {error && (
        <div className="rounded-sm border border-status-blocked/40 bg-status-blocked/10 px-4 py-3 font-mono text-small text-status-blocked">
          {(error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-2 xl:grid-cols-4">
        {SECTIONS.map((s) => (
          <Column section={s} count={grouped[s].length} key={s}>
            {grouped[s].length === 0 ? (
              <EmptyHint section={s} />
            ) : (
              grouped[s].map((t, i) => <TaskCard task={t} index={i} key={t.taskId} />)
            )}
          </Column>
        ))}
      </div>

      <CreateTaskModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function EmptyHint({ section }: { section: TaskSection }) {
  const HINT: Record<TaskSection, string> = {
    TODO: "queue is clear.",
    DOING: "no active work.",
    BLOCKED: "nothing stuck.",
    "DONE — not yet archived": "shipped — drag here when reviewed.",
  };
  return (
    <div className="rounded-sm border border-dashed border-border bg-transparent px-4 py-6 font-mono text-micro tracking-wideish text-muted-2">
      {HINT[section]}
    </div>
  );
}

function CreateTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: apps } = useApps();
  const create = useCreateTask();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [app, setApp] = useState<string>("");

  function reset() {
    setTitle("");
    setBody("");
    setApp("");
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await create.mutateAsync({
      title: title.trim(),
      body: body.trim(),
      app: app || undefined,
    });
    reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="new task"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 font-mono text-micro uppercase tracking-wideish text-muted hover:text-fg"
          >
            cancel
          </button>
          <button
            type="submit"
            form="create-task-form"
            disabled={create.isPending || !title.trim()}
            className="rounded-sm border border-accent/40 bg-accent px-4 py-1.5 font-mono text-micro uppercase tracking-wideish text-bg transition-opacity disabled:opacity-40"
          >
            {create.isPending ? "creating…" : "create"}
          </button>
        </>
      }
    >
      <form id="create-task-form" onSubmit={submit} className="space-y-4">
        <Field label="title">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="short, imperative — e.g. ‘embed dist into go binary’"
            className="w-full rounded-sm border border-border bg-bg px-3 py-2 text-base text-fg placeholder:text-muted-2 focus:border-accent focus:outline-none"
          />
        </Field>
        <Field label="body">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="context, links, acceptance criteria…"
            className="w-full resize-y rounded-sm border border-border bg-bg px-3 py-2 text-small text-fg placeholder:text-muted-2 focus:border-accent focus:outline-none"
          />
        </Field>
        <Field label="app (optional)">
          <select
            value={app}
            onChange={(e) => setApp(e.target.value)}
            className="w-full rounded-sm border border-border bg-bg px-3 py-2 font-mono text-small text-fg focus:border-accent focus:outline-none"
          >
            <option value="">— none —</option>
            {(apps?.apps ?? []).map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        {create.isError && (
          <div className="font-mono text-micro text-status-blocked">
            {(create.error as Error).message}
          </div>
        )}
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-micro uppercase tracking-wideish text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
