import { NextResponse, type NextRequest } from "next/server";
import { getBuiltinSlashCommands } from "@/lib/claudeBuiltinSlash";
import {
  discoverProjectSlashCommands,
  discoverUserSlashCommands,
  type SlashDiscoverySource,
} from "@/lib/claudeSlashDiscovery";
import { BRIDGE_ROOT, readBridgeMd } from "@/lib/paths";
import { resolveRepoCwd } from "@/lib/repos";
import { isValidAppName } from "@/lib/apps";

export const dynamic = "force-dynamic";

export type SlashCommandsItemDto = {
  slug: string;
  description: string | null;
  source: SlashDiscoverySource | "builtin";
};

/** Project overrides user overrides builtin for the same slug (same precedence as Claude Code). */
function mergeBySlug(
  builtinDto: SlashCommandsItemDto[],
  userDto: SlashCommandsItemDto[],
  projectDto: SlashCommandsItemDto[],
): SlashCommandsItemDto[] {
  const map = new Map<string, SlashCommandsItemDto>();
  for (const b of builtinDto) map.set(b.slug, b);
  for (const u of userDto) {
    const prev = map.get(u.slug);
    map.set(u.slug, {
      slug: u.slug,
      description: u.description ?? prev?.description ?? null,
      source: "user",
    });
  }
  for (const p of projectDto) {
    const prev = map.get(p.slug);
    map.set(p.slug, {
      slug: p.slug,
      description: p.description ?? prev?.description ?? null,
      source: "project",
    });
  }
  const rank = (s: SlashCommandsItemDto["source"]) =>
    s === "project" ? 0 : s === "user" ? 1 : 2;
  return [...map.values()].sort(
    (a, b) => rank(a.source) - rank(b.source) || a.slug.localeCompare(b.slug),
  );
}

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  if (!isValidAppName(name)) {
    return NextResponse.json({ error: "invalid app name" }, { status: 400 });
  }
  const md = readBridgeMd();
  const cwd = resolveRepoCwd(md, BRIDGE_ROOT, name);
  if (!cwd) return NextResponse.json({ error: "unknown repo" }, { status: 404 });

  let project: Awaited<ReturnType<typeof discoverProjectSlashCommands>>;
  let user: Awaited<ReturnType<typeof discoverUserSlashCommands>>;
  try {
    project = await discoverProjectSlashCommands(cwd);
  } catch {
    project = [];
  }
  try {
    user = await discoverUserSlashCommands();
  } catch {
    user = [];
  }
  const builtins = getBuiltinSlashCommands();

  const builtinDto: SlashCommandsItemDto[] = builtins.map((b) => ({
    slug: b.slug,
    description: b.description,
    source: "builtin",
  }));
  const userDto: SlashCommandsItemDto[] = user.map((u) => ({
    slug: u.slug,
    description: u.description,
    source: "user",
  }));
  const projectDto: SlashCommandsItemDto[] = project.map((p) => ({
    slug: p.slug,
    description: p.description,
    source: "project",
  }));

  const items = mergeBySlug(builtinDto, userDto, projectDto);
  return NextResponse.json({ items });
}
