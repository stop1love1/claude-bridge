import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Play, Trash2, Users } from "lucide-react";
import {
  useApps,
  useClearTask,
  useContinueTask,
  useDeleteTask,
  usePatchTask,
  useSpawnAgent,
  useTask,
  useTaskSummary,
} from "@/api/queries";
import { useTaskEvents } from "@/api/sse";
import RunRow from "@/components/RunRow";
import StatusDot from "@/components/StatusDot";
import Modal from "@/components/Modal";
import { SECTIONS, type TaskSection } from "@/api/types";
import { cn } from "@/lib/cn";

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading, error } = useTask(id);
  const { data: summary } = useTaskSummary(id);
  useTaskEvents(id);

  const patch = usePatchTask();
  const del = useDeleteTask();
  const continueTask = useContinueTask(id ?? "");
  const clearTask = useClearTask(id ?? "");

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [spawnOpen, setSpawnOpen] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.taskTitle);
      setBody(task.taskBody);
    }
  }, [task]);

  const liveCount = useMemo(
    () => task?.runs.filter((r) => r.status === "running").length ?? 0,
    [task],
  );

  if (isLoading) {
    return (
      <Container>
        <p className="font-mono text-micro tracking-wideish text-muted">
          loading task…
        </p>
      </Container>
    );
  }
  if (error || !task) {
    return (
      <Container>
        <p className="font-mono text-small text-status-blocked">
          {error ? (error as Error).message : "task not found"}
        </p>
      </Container>
    );
  }

  const commit = (field: "title" | "body") => {
    if (!id || !task) return;
    const value = field === "title" ? title : body;
    const original = field === "title" ? task.taskTitle : task.taskBody;
    if (value === original) return;
    patch.mutate({ id, patch: { [field]: value } });
  };

  const moveSection = (section: TaskSection) => {
    if (!id) return;
    patch.mutate({ id, patch: { section } });
  };

  const toggleChecked = () => {
    if (!id || !task) return;
    patch.mutate({
      id,
      patch: {
        section: "DONE — not yet archived",
        checked: !task.taskChecked,
      },
    });
  };

  return (
    <Container>
      <div className="mb-8 flex items-center gap-4">
        <Link
          to="/"
          className="inline-flex items-center gap-2 font-mono text-micro uppercase tracking-wideish text-muted hover:text-fg"
        >
          <ArrowLeft size={12} />
          board
        </Link>
        <span className="font-mono text-micro text-muted-2">/</span>
        <span className="font-mono text-micro tracking-wideish text-muted-2">
          {task.taskId}
        </span>
        {liveCount > 0 && (
          <span className="ml-auto inline-flex items-center gap-2 font-mono text-micro uppercase tracking-wideish text-status-doing">
            <span className="h-1.5 w-1.5 animate-pulse-slow rounded-full bg-status-doing" />
            {liveCount} session{liveCount === 1 ? "" : "s"} live
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => commit("title")}
            className="w-full bg-transparent font-sans text-display font-semibold tracking-tightish text-fg focus:outline-none"
            placeholder="untitled task"
          />

          <div className="mt-6 flex flex-wrap items-center gap-2">
            {SECTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => moveSection(s)}
                className={cn(
                  "rounded-sm border px-3 py-1 font-mono text-micro uppercase tracking-wideish transition-colors",
                  task.taskSection === s
                    ? "border-accent bg-accent text-bg"
                    : "border-border text-muted hover:border-border-strong hover:text-fg",
                )}
              >
                {s === "DONE — not yet archived" ? "done" : s.toLowerCase()}
              </button>
            ))}
            <label className="ml-2 inline-flex items-center gap-2 font-mono text-micro uppercase tracking-wideish text-muted">
              <input
                type="checkbox"
                checked={task.taskChecked}
                onChange={toggleChecked}
                className="h-3.5 w-3.5 accent-accent"
              />
              archived
            </label>
          </div>

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => commit("body")}
            rows={Math.max(6, body.split("\n").length + 1)}
            className="mt-8 w-full resize-y rounded-sm border border-border bg-surface px-4 py-3 font-sans text-base leading-relaxed text-fg focus:border-border-strong focus:outline-none"
            placeholder="describe the task — context, acceptance criteria, links."
          />

          {summary && typeof summary === "string" && summary.trim() && (
            <section className="mt-10">
              <h3 className="mb-3 font-mono text-micro uppercase tracking-wideish text-muted">
                summary
              </h3>
              <pre className="whitespace-pre-wrap rounded-sm border border-border bg-surface p-4 font-mono text-small text-fg">
                {summary}
              </pre>
            </section>
          )}

          <section className="mt-12">
            <header className="mb-4 flex items-baseline justify-between border-b border-border pb-2">
              <h3 className="font-mono text-micro uppercase tracking-wideish text-fg">
                runs
              </h3>
              <span className="font-mono text-micro tabular-nums text-muted-2">
                {String(task.runs.length).padStart(2, "0")}
              </span>
            </header>
            {task.runs.length === 0 ? (
              <p className="rounded-sm border border-dashed border-border px-4 py-6 font-mono text-micro tracking-wideish text-muted-2">
                no sessions yet — spawn a child to start.
              </p>
            ) : (
              <ul className="rounded-sm border border-border bg-surface">
                {task.runs.map((r) => (
                  <RunRow run={r} key={r.sessionId} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-3">
          <div className="rounded-sm border border-border bg-surface p-4">
            <h4 className="mb-3 font-mono text-micro uppercase tracking-wideish text-muted">
              actions
            </h4>
            <div className="flex flex-col gap-2">
              <ActionButton
                onClick={() => continueTask.mutate(undefined)}
                pending={continueTask.isPending}
                icon={<Play size={12} />}
                label="continue"
              />
              <ActionButton
                onClick={() => setSpawnOpen(true)}
                pending={false}
                icon={<Users size={12} />}
                label="spawn agent"
              />
              <ActionButton
                onClick={() => clearTask.mutate()}
                pending={clearTask.isPending}
                icon={<Trash2 size={12} />}
                label="clear runs"
                tone="danger"
              />
            </div>
          </div>

          <div className="rounded-sm border border-border bg-surface p-4">
            <h4 className="mb-3 font-mono text-micro uppercase tracking-wideish text-muted">
              meta
            </h4>
            <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-y-2 font-mono text-micro">
              <dt className="text-muted-2 uppercase">section</dt>
              <dd className="text-fg">
                <StatusDot
                  status={task.taskStatus === "done" ? "done" : task.taskStatus === "blocked" ? "failed" : task.taskStatus === "doing" ? "running" : "queued"}
                  label
                />
              </dd>
              <dt className="text-muted-2 uppercase">app</dt>
              <dd className="text-muted">{task.taskApp ?? "—"}</dd>
              <dt className="text-muted-2 uppercase">created</dt>
              <dd className="text-muted">{task.createdAt}</dd>
            </dl>
          </div>

          <button
            type="button"
            onClick={async () => {
              if (!id) return;
              if (!confirm("delete task and all runs? meta.json will be removed.")) return;
              await del.mutateAsync(id);
              navigate("/");
            }}
            className="rounded-sm border border-status-blocked/30 px-3 py-2 font-mono text-micro uppercase tracking-wideish text-status-blocked transition-colors hover:bg-status-blocked/10"
          >
            delete task
          </button>
        </aside>
      </div>

      <SpawnModal
        open={spawnOpen}
        onClose={() => setSpawnOpen(false)}
        taskId={id ?? ""}
      />
    </Container>
  );
}

function Container({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-10">{children}</div>
  );
}

function ActionButton({
  onClick,
  pending,
  icon,
  label,
  tone = "default",
}: {
  onClick: () => void;
  pending: boolean;
  icon: React.ReactNode;
  label: string;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={cn(
        "inline-flex items-center justify-between gap-2 rounded-sm border px-3 py-2 font-mono text-micro uppercase tracking-wideish transition-colors disabled:opacity-40",
        tone === "danger"
          ? "border-status-blocked/30 text-status-blocked hover:bg-status-blocked/10"
          : "border-border text-muted hover:border-accent hover:text-accent",
      )}
    >
      <span className="inline-flex items-center gap-2">
        {icon}
        {label}
      </span>
      <span className="text-muted-2">{pending ? "…" : "↵"}</span>
    </button>
  );
}

function SpawnModal({
  open,
  onClose,
  taskId,
}: {
  open: boolean;
  onClose: () => void;
  taskId: string;
}) {
  const { data: apps } = useApps();
  const spawn = useSpawnAgent(taskId);
  const [role, setRole] = useState("coder");
  const [repo, setRepo] = useState("");
  const [prompt, setPrompt] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!role.trim()) return;
    await spawn.mutateAsync({
      role: role.trim(),
      repo: repo.trim() || undefined,
      prompt: prompt.trim() || undefined,
    });
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="spawn agent"
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
            form="spawn-form"
            disabled={spawn.isPending}
            className="rounded-sm border border-accent/40 bg-accent px-4 py-1.5 font-mono text-micro uppercase tracking-wideish text-bg disabled:opacity-40"
          >
            {spawn.isPending ? "spawning…" : "spawn"}
          </button>
        </>
      }
    >
      <form id="spawn-form" onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block font-mono text-micro uppercase tracking-wideish text-muted">
            role
          </span>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="coder | reviewer | planner"
            className="w-full rounded-sm border border-border bg-bg px-3 py-2 font-mono text-base text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block font-mono text-micro uppercase tracking-wideish text-muted">
            repo
          </span>
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="w-full rounded-sm border border-border bg-bg px-3 py-2 font-mono text-small text-fg focus:border-accent focus:outline-none"
          >
            <option value="">— current —</option>
            {(apps?.apps ?? []).map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block font-mono text-micro uppercase tracking-wideish text-muted">
            prompt
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="initial instruction for the child claude…"
            className="w-full resize-y rounded-sm border border-border bg-bg px-3 py-2 text-small text-fg focus:border-accent focus:outline-none"
          />
        </label>
        {spawn.isError && (
          <div className="font-mono text-micro text-status-blocked">
            {(spawn.error as Error).message}
          </div>
        )}
      </form>
    </Modal>
  );
}
