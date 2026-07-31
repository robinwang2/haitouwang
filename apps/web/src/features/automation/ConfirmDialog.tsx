'use client';

import { useEffect, useId, useRef, useState } from 'react';
import styles from './automation.module.css';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly dangerous?: boolean;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  dangerous = false,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (open) {
      setAcknowledged(false);
      window.setTimeout(() => cancelRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel, open]);

  if (!open) {
    return null;
  }

  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !busy) {
        onCancel();
      }
    }}>
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        role="dialog"
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        <label className={styles.confirmCheck}>
          <input
            checked={acknowledged}
            disabled={busy}
            onChange={(event) => setAcknowledged(event.target.checked)}
            type="checkbox"
          />
          <span>我已阅读影响范围，并确认本次操作会写入审计记录。</span>
        </label>
        <div className={styles.actionRow}>
          <button
            className={styles.secondaryButton}
            disabled={busy}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            返回检查
          </button>
          <button
            className={dangerous ? styles.dangerButton : styles.primaryButton}
            disabled={!acknowledged || busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
