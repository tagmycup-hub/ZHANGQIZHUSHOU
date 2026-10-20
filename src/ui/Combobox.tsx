import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface ComboItem {
  id: string;
  label: string;
  sub?: string;
  terms?: string[];
  isDefault?: boolean;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

export function Combobox(props: {
  id: string;
  items: ComboItem[];
  value: string | null;
  /** 没有 id 时显示的文本（如历史快照） */
  fallbackLabel?: string;
  onChange: (id: string | null) => void;
  onCreate?: (name: string) => Promise<string | null>;
  createLabel?: string;
  placeholder?: string;
  className?: string;
  describedBy?: string;
}) {
  const { items, value, onChange, onCreate } = props;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const selected = items.find((i) => i.id === value);
  const shown = selected ? selected.label : props.fallbackLabel ?? '';

  const results = useMemo(() => {
    const nq = norm(q);
    const list = nq ? items.filter((i) => [i.label, i.sub ?? '', ...(i.terms ?? [])].some((t) => norm(t).includes(nq))) : items;
    return [...list].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
  }, [q, items]);
  const exact = items.some((i) => [i.label, ...(i.terms ?? [])].some((t) => norm(t) === norm(q)));
  const canCreate = !!onCreate && norm(q).length > 0 && !exact;
  const total = results.length + (canCreate ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    document.addEventListener('touchstart', h);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('touchstart', h);
    };
  }, [open]);

  useEffect(() => setActive(0), [q]);

  const pick = async (idx: number) => {
    if (idx < results.length) {
      onChange(results[idx].id);
      setOpen(false);
      setQ('');
      return;
    }
    if (canCreate && onCreate) {
      setBusy(true);
      const id = await onCreate(q.trim());
      setBusy(false);
      if (id) {
        // 调用方负责选中新建项
        setOpen(false);
        setQ('');
      }
    }
  };

  return (
    <div className={`combo ${props.className ?? ''}`} ref={ref}>
      <input
        ref={inputRef}
        id={props.id}
        className={`input ${props.className ?? ''}`}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && total > 0 ? `${listId}-opt-${active}` : undefined}
        aria-describedby={props.describedBy}
        autoComplete="off"
        placeholder={shown || props.placeholder}
        value={open ? q : shown}
        onFocus={() => {
          setOpen(true);
          setQ('');
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onBlur={(e) => {
          // Tab 离开时收起列表（点选项时 onMouseDown 已阻止失焦）
          if (!ref.current?.contains(e.relatedTarget as Node | null)) {
            setOpen(false);
            setQ('');
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(total - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            if (open && total > 0) {
              e.preventDefault();
              pick(active);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        style={{ paddingRight: value ? 44 : undefined }}
      />
      {value && !open && (
        <button type="button" className="clear" aria-label="清除选择" onClick={() => onChange(null)}>
          ×
        </button>
      )}
      {open && (
        <div className="list" role="listbox" id={listId}>
          {results.map((r, i) => (
            <div
              key={r.id}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className="opt"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span>
                {r.label} {r.isDefault && <span className="pill brand xs">默认</span>}
              </span>
              {r.sub && <span className="sub">{r.sub}</span>}
            </div>
          ))}
          {canCreate && (
            <div id={`${listId}-opt-${results.length}`} role="option" aria-selected={active === results.length} className="opt add" onMouseEnter={() => setActive(results.length)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(results.length)}>
              {busy ? '保存中…' : `＋ ${props.createLabel ?? '新增并保存'}「${q.trim()}」`}
            </div>
          )}
          {!results.length && !canCreate && <div className="opt muted">{q ? '已存在同名项（可能已停用，请到「资料」页启用）' : '还没有记录，输入名称即可新增'}</div>}
        </div>
      )}
    </div>
  );
}
