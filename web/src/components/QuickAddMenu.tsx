import { Plus, Upload, FileText } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

/**
 * Composer "Add" menu — paperclip-style entry point for upload + @ mention.
 * Image-clipboard paste is deferred (see InteractionLayer notes).
 */
export function QuickAddMenu({
  onAttach,
  onMention,
}: {
  onAttach: () => void;
  onMention: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="iconSm"
          title="Add"
          aria-label="Add"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuItem onSelect={() => onAttach()}>
          <Upload className="text-muted-foreground" />
          <span>Upload from computer</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onMention()}>
          <FileText className="text-muted-foreground" />
          <span>Add file from repo</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
