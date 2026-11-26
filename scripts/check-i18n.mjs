// Fails if any language is missing a namespace file or a key that exists in the
// reference language (en), has keys that en does not have, or has empty strings.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'packages', 'i18n', 'src', 'locales');
const reference = 'en';
const languages = readdirSync(root);

/** @param {unknown} obj @param {string} prefix @returns {Map<string, unknown>} */
function flatten(obj, prefix = '') {
  const out = new Map();
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (obj))) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      for (const [k, v] of flatten(value, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

/** @param {string} lang @param {string} file */
const load = (lang, file) => JSON.parse(readFileSync(join(root, lang, file), 'utf8'));
const problems = [];
const namespaces = readdirSync(join(root, reference)).filter((f) => f.endsWith('.json'));

for (const lang of languages) {
  const files = new Set(readdirSync(join(root, lang)));
  for (const ns of namespaces) {
    if (!files.has(ns)) {
      problems.push(`${lang}: missing namespace file ${ns}`);
      continue;
    }
    const ref = flatten(load(reference, ns));
    const cur = flatten(load(lang, ns));
    for (const key of ref.keys())
      if (!cur.has(key)) problems.push(`${lang}/${ns}: missing "${key}"`);
    for (const key of cur.keys()) if (!ref.has(key)) problems.push(`${lang}/${ns}: extra "${key}"`);
    for (const [key, value] of cur) {
      if (typeof value !== 'string' || value.trim() === '') {
        problems.push(`${lang}/${ns}: empty "${key}"`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`i18n check failed (${problems.length} problem(s)):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`i18n check passed: ${languages.join(', ')} x ${namespaces.length} namespaces`);
