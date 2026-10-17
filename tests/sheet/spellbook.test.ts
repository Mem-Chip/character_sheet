import { describe, expect, it } from 'vitest';
import { blankCharacter, type CharData } from '../../src/sheet';
import {
  addSpellToBook,
  createSpellbook,
  deleteSpellbook,
  getSpellbooks,
  removeSpellFromBook,
  renameSpellbook,
  togglePrepareFromBook,
} from '../../src/sheet/spellbook';

describe('法术书数据与管理 (spellbook.ts)', () => {
  it('旧卡没有 spellbooks 时自动生成默认主法术书并读取旧 spellbook', () => {
    const char: CharData = {
      ...blankCharacter(),
      spellbook: ['魔法飞弹', '护盾术'],
    };

    const books = getSpellbooks(char);
    expect(books.length).toBe(1);
    expect(books[0].name).toBe('主法术书');
    expect(books[0].spells).toEqual(['魔法飞弹', '护盾术']);
  });

  it('新建法术书、重命名与克隆', () => {
    const char: CharData = {
      ...blankCharacter(),
      spellbook: ['火球术', '飞行术'],
    };

    // 新建空法术书
    const book2 = createSpellbook(char, '备用手抄本');
    expect(book2.name).toBe('备用手抄本');
    expect(book2.spells).toEqual([]);
    expect(getSpellbooks(char).length).toBe(2);

    // 重命名
    renameSpellbook(char, book2.id, '旅行法术书');
    expect(getSpellbooks(char).find((b) => b.id === book2.id)?.name).toBe('旅行法术书');

    // 从主法术书克隆
    const book3 = createSpellbook(char, '克隆备份', 'main');
    expect(book3.spells).toEqual(['火球术', '飞行术']);
    expect(getSpellbooks(char).length).toBe(3);
  });

  it('添加与移除法术，保持 char.spellbook 兼容并集同步', () => {
    const char: CharData = {
      ...blankCharacter(),
    };

    const book1 = getSpellbooks(char)[0];
    addSpellToBook(char, book1.id, '护盾术');
    addSpellToBook(char, book1.id, '迷踪步');

    expect(char.spellbook).toContain('护盾术');
    expect(char.spellbook).toContain('迷踪步');

    const book2 = createSpellbook(char, '第二法术书');
    addSpellToBook(char, book2.id, '火球术');

    // 两个书的并集
    expect(char.spellbook).toContain('火球术');
    expect(char.spellbook).toContain('护盾术');

    // 准备火球术
    togglePrepareFromBook(char, '火球术');
    expect(char.spells.some((s: any) => s.name === '火球术' && s.prepared)).toBe(true);

    // 从 book2 移出火球术：因为别的书没有火球术，火球术同时从准备列表中剔除
    removeSpellFromBook(char, book2.id, '火球术');
    expect(char.spellbook).not.toContain('火球术');
    expect(char.spells.some((s: any) => s.name === '火球术')).toBe(false);
  });

  it('准备状态切换', () => {
    const char: CharData = {
      ...blankCharacter(),
      spells: [],
    };

    // 第一次 toggle：准备
    const prep1 = togglePrepareFromBook(char, '隐形术');
    expect(prep1).toBe(true);
    expect(char.spells.some((s: any) => s.name === '隐形术' && s.prepared)).toBe(true);

    // 第二次 toggle：取消准备
    const prep2 = togglePrepareFromBook(char, '隐形术');
    expect(prep2).toBe(false);
    expect(char.spells.some((s: any) => s.name === '隐形术')).toBe(false);
  });

  it('只有一本法术书时不允许删除', () => {
    const char: CharData = {
      ...blankCharacter(),
    };
    const books = getSpellbooks(char);
    const ok = deleteSpellbook(char, books[0].id);
    expect(ok).toBe(false);
    expect(getSpellbooks(char).length).toBe(1);
  });
});
