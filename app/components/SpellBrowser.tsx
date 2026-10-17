/**
 * 选法术弹窗（兼容模式）：内部复用 SpellPicker
 */
import type { CharData, Json } from '../../src/sheet';
import type { Engine } from '../lib/engine';
import { SpellPicker } from './SpellPicker';
import { Dialog } from './ui';

interface Props {
  engine: Engine;
  id: string;
  char: CharData;
  sheet: Json;
  onClose: () => void;
}

export function SpellBrowser(p: Props) {
  return (
    <Dialog title="法术库" onClose={p.onClose}>
      <SpellPicker {...p} onClose={p.onClose} />
    </Dialog>
  );
}
