import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  text: string;
  bad?: boolean;
  action?: { label: string; run: () => void };
}

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  cancelLabel?: string;
}

interface Feedback {
  toast(text: string, opts?: { bad?: boolean; action?: Toast['action'] }): void;
  confirm(opts: ConfirmOpts): Promise<boolean>;
}

const Ctx = createContext<Feedback>(null as any);
export const useFeedback = () => useContext(Ctx);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dlg, setDlg] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const seq = useRef(0);

  const toast = useCallback<Feedback['toast']>((text, opts = {}) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, text, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.action ? 6000 : 3200);
  }, []);

  const confirm = useCallback<Feedback['confirm']>((opts) => new Promise((resolve) => setDlg({ ...opts, resolve })), []);

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.bad ? ' bad' : ''}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  setToasts((x) => x.filter((y) => y.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
      {dlg && (
        <Modal
          title={dlg.title}
          onClose={() => {
            dlg.resolve(false);
            setDlg(null);
          }}
        >
          {dlg.body && <div className="stack small">{dlg.body}</div>}
          <div className="row end">
            <button
              className="btn btn-ghost"
              onClick={() => {
                dlg.resolve(false);
                setDlg(null);
              }}
            >
              {dlg.cancelLabel ?? '取消'}
            </button>
            <button
              className={`btn ${dlg.danger ? 'btn-danger' : 'btn-primary'}`}
              autoFocus
              onClick={() => {
                dlg.resolve(true);
                setDlg(null);
              }}
            >
              {dlg.confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

/** 叠在一起的弹窗：Esc 只关闭最上面那个 */
const modalStack: object[] = [];

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const token = useRef({});
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const me = token.current;
    modalStack.push(me);
    const prev = document.activeElement as HTMLElement | null;
    // 打开时把焦点移进弹窗（已有 autoFocus 的输入框除外）
    requestAnimationFrame(() => {
      if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== me) return;
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      // Tab 只在弹窗内循环
      if (e.key === 'Tab' && ref.current) {
        const els = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = modalStack.lastIndexOf(me);
      if (i >= 0) modalStack.splice(i, 1);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
