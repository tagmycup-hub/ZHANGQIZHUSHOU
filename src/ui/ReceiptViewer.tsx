import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Modal } from './feedback';

/** 查看付款凭证照片 */
export function ReceiptViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const { repo } = useStore();
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let u: string | null = null;
    let gone = false;
    repo
      .getImage(id)
      .then((b) => {
        if (gone) return;
        u = b ? URL.createObjectURL(b) : null;
        setUrl(u);
      })
      .catch(() => !gone && setUrl(null));
    return () => {
      gone = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [id, repo]);
  return (
    <Modal title="付款凭证" onClose={onClose}>
      {url === undefined ? <span className="spin" /> : url ? <img src={url} alt="付款凭证" style={{ width: '100%', borderRadius: 10 }} /> : <p className="small muted">这张照片不在这台设备上（凭证照片不参与云同步，只保存在拍摄的设备）。</p>}
    </Modal>
  );
}
