import { createFileRoute } from "@tanstack/react-router";
import { File } from "lucide-react";

import { PersonalEmptyTab } from "~/features/personal/PersonalEmptyTab";

function FilesRouteView() {
  return (
    <PersonalEmptyTab
      title="Files"
      heading="No files yet"
      description="Files and attachments from your bot chats will be collected here."
      icon={File}
    />
  );
}

export const Route = createFileRoute("/_personal/files")({
  component: FilesRouteView,
});
