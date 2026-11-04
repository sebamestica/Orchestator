/** Diálogo de confirmación (como ConfirmDialog de studyapp). */
import { Button, Modal } from '@heroui/react';
import type { ReactNode } from 'react';
import { Notice } from './shared.tsx';

interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  isPending: boolean;
  error: string | null;
  onConfirm: () => void;
}

export function ConfirmDialog({ isOpen, onOpenChange, title, description, confirmLabel, isPending, error, onConfirm }: ConfirmDialogProps) {
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading className="break-words">{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              <p className="text-[0.875rem] text-muted">{description}</p>
              {error ? <Notice>{error}</Notice> : null}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onPress={() => onOpenChange(false)}>
                  Cancelar
                </Button>
                <Button variant="danger" isPending={isPending} onPress={onConfirm}>
                  {confirmLabel}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
