/**
 * 规则数据审计：npm run check:data
 * 编译数据里的全部表达式、检查模板引用与事件名、双计。有问题就以非 0 退出。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RuleBook, auditRuleBook, type RuleFile } from '../src/combat';

const FILES = ['data/rules-2024.json', 'data/dyn/spells.json', 'data/dyn/features.json'];
const files = FILES.map((f) => JSON.parse(readFileSync(resolve(import.meta.dirname, '..', f), 'utf8')) as RuleFile);
const book = new RuleBook(files);
const problems = auditRuleBook(book);
const entries = book.keys().length;
if (problems.length) {
  console.error(`规则数据审计：${entries} 条，发现 ${problems.length} 个问题`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log(`规则数据审计：${entries} 条，没有问题`);
