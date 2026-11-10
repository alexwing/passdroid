import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')));
const ok = isDeepStrictEqual(a, b);
console.log(ok ? 'DEEP-EQUAL' : 'DIFFERENT');
process.exit(ok ? 0 : 1);
