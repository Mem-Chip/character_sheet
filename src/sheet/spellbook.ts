/**
 * 法师法术书管理（2024 XPHB 规则）：
 * - 支持主法术书与多本法术书（备用手抄本、战利品古籍等）
 * - 支持新建法术书、克隆/备份法术书、重命名、删除法术书
 * - 支持法术抄写入书、移出书
 * - 在法术书中准备法术与取消准备
 * - 保持 char.spellbook 向下兼容同步
 */
import type { CharData } from './character';
import type { Json } from './store';

export interface SpellbookItem {
  id: string;
  name: string;
  spells: string[];
}

/** 获取角色的所有法术书（如果没有，以现有的 char.spellbook 创建默认的主法术书） */
export function getSpellbooks(char: CharData): SpellbookItem[] {
  if (Array.isArray(char.spellbooks) && char.spellbooks.length > 0) {
    return char.spellbooks;
  }
  const oldSpells = Array.isArray(char.spellbook) ? char.spellbook : [];
  return [{ id: 'main', name: '主法术书', spells: [...oldSpells] }];
}

/** 规范化法术书存储，保证 char.spellbooks 与 char.spellbook（兼容并集）同步 */
export function syncSpellbooks(char: CharData, books: SpellbookItem[], activeId?: string): void {
  char.spellbooks = books;
  if (activeId) {
    char.activeSpellbookId = activeId;
  } else if (!char.activeSpellbookId || !books.some((b) => b.id === char.activeSpellbookId)) {
    char.activeSpellbookId = books[0]?.id ?? 'main';
  }
  // char.spellbook 保持为所有书的法术并集，保证旧代码与计算管线完全兼容
  const allSpells = new Set<string>();
  for (const b of books) {
    for (const s of b.spells) allSpells.add(s);
  }
  char.spellbook = [...allSpells];
}

/** 新建一本法术书 */
export function createSpellbook(char: CharData, name: string, cloneFromId?: string): SpellbookItem {
  const books = getSpellbooks(char);
  const id = 'book_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  let spells: string[] = [];
  if (cloneFromId) {
    const src = books.find((b) => b.id === cloneFromId);
    if (src) spells = [...src.spells];
  }
  const newBook: SpellbookItem = { id, name: name.trim() || '新法术书', spells };
  const nextBooks = [...books, newBook];
  syncSpellbooks(char, nextBooks, id);
  return newBook;
}

/** 重命名法术书 */
export function renameSpellbook(char: CharData, bookId: string, nextName: string): void {
  const trimmed = nextName.trim();
  if (!trimmed) return;
  const books = getSpellbooks(char).map((b) => (b.id === bookId ? { ...b, name: trimmed } : b));
  syncSpellbooks(char, books);
}

/** 删除法术书（如果只有 1 本则不允许删除） */
export function deleteSpellbook(char: CharData, bookId: string): boolean {
  const books = getSpellbooks(char);
  if (books.length <= 1) return false;
  const nextBooks = books.filter((b) => b.id !== bookId);
  syncSpellbooks(char, nextBooks, nextBooks[0]?.id);
  return true;
}

/** 抄写入指定的法术书 */
export function addSpellToBook(char: CharData, bookId: string, spellName: string): void {
  const books = getSpellbooks(char).map((b) => {
    if (b.id === bookId) {
      if (!b.spells.includes(spellName)) {
        return { ...b, spells: [...b.spells, spellName] };
      }
    }
    return b;
  });
  syncSpellbooks(char, books, bookId);
}

/** 从法术书中移除法术（若已在所有法术书中绝迹，同时从已准备列表中移除） */
export function removeSpellFromBook(char: CharData, bookId: string, spellName: string): void {
  const books = getSpellbooks(char).map((b) => {
    if (b.id === bookId) {
      return { ...b, spells: b.spells.filter((s) => s !== spellName) };
    }
    return b;
  });
  syncSpellbooks(char, books, bookId);
  // 检查是否还在任何其他法术书里
  const stillInAny = books.some((b) => b.spells.includes(spellName));
  if (!stillInAny) {
    char.spells = (char.spells || []).filter((s: Json) => !(s.name === spellName && (s.cls ?? '法师') === '法师'));
  }
}

/** 法师在法术书中切换准备状态 */
export function togglePrepareFromBook(char: CharData, spellName: string): boolean {
  const spells: Json[] = char.spells || [];
  const idx = spells.findIndex((s: Json) => s.name === spellName && (s.cls ?? '法师') === '法师');
  if (idx >= 0) {
    if (spells[idx].prepared === false) {
      spells[idx].prepared = true;
      char.spells = [...spells];
      return true;
    } else {
      // 取消准备：从未准备列表中移除
      spells.splice(idx, 1);
      char.spells = [...spells];
      return false;
    }
  } else {
    // 加入准备列表
    spells.push({ name: spellName, prepared: true, cls: '法师' });
    char.spells = [...spells];
    return true;
  }
}
