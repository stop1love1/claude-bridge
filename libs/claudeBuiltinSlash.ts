import raw from "./data/claude-builtin-slash.json";

export interface BuiltinSlashCommand {
  slug: string;
  description: string;
}

export function getBuiltinSlashCommands(): BuiltinSlashCommand[] {
  const j = raw as { commands: BuiltinSlashCommand[] };
  return j.commands.slice();
}
