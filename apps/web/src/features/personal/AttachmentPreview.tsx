import type { EnvironmentId } from "@t3tools/contracts";
import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import { AttachmentFilePreview } from "~/components/files/AttachmentFilePreview";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";

export interface AttachmentPreviewData {
  name: string;
  type: string;
  mimeType: string;
  sizeBytes: number;
  imageUrl?: string;
  file?: Blob | null;
  attachmentId?: string | undefined;
}

export function AttachmentPreview({
  attachment,
  environmentId,
  onClose,
}: {
  attachment: AttachmentPreviewData;
  environmentId: EnvironmentId;
  onClose: () => void;
}) {
  const asset = attachment.attachmentId
    ? { environmentId, attachmentId: attachment.attachmentId }
    : undefined;
  if (attachment.type === "image") {
    return (
      <ExpandedImageDialog
        onClose={onClose}
        preview={{
          index: 0,
          images: [
            {
              name: attachment.name,
              src: attachment.imageUrl ?? null,
              ...(asset
                ? {
                    actionsSource: {
                      kind: "image" as const,
                      name: attachment.name,
                      src: null,
                      asset: {
                        environmentId,
                        resource: { _tag: "attachment" as const, attachmentId: asset.attachmentId },
                      },
                    },
                  }
                : {}),
            },
          ],
        }}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="h-[90dvh] w-[96vw] max-w-5xl overflow-hidden p-0">
        <DialogTitle className="sr-only">{attachment.name}</DialogTitle>
        <AttachmentFilePreview
          name={attachment.name}
          mimeType={attachment.mimeType}
          sizeBytes={attachment.sizeBytes}
          {...(attachment.file ? { file: attachment.file } : {})}
          {...(asset ? { asset } : {})}
          origin="Attachments"
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}
