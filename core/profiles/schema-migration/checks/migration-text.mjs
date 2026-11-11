// Reading migration files without a database: split up and down, cut statements, and find lock risks,
// dropped or renamed names and the tables a migration touches. Covers plain SQL (dbmate, goose,
// golang-migrate, Prisma), Alembic, Knex and Rails. Not a check: check-profiles loads only listed ids.

// [ \t]* rather than \s*: under the m flag \s would start the match on an earlier blank line.
const DOWN_MARKERS = [
  /^[ \t]*--[ \t]*migrate:down\b/im,
  /^[ \t]*--[ \t]*\+goose[ \t]+Down\b/im,
  /^[ \t]*def[ \t]+downgrade[ \t]*\(/m,
  /^[ \t]*def[ \t]+down\b/m,
  /^[ \t]*exports\.down\b/m,
  /^[ \t]*export[ \t]+(?:async[ \t]+)?function[ \t]+down\b/m,
  /^[ \t]*(?:public[ \t]+)?(?:async[ \t]+)?down[ \t]*\(/m,
];
const RAILS_CHANGE = /^[ \t]*def[ \t]+change\b/m;
const RAILS_IRREVERSIBLE_IN_CHANGE = /\b(?:execute|change_column)\b|\bremove_column\s+:\w+\s*,\s*:\w+\s*$/m;
const EMPTY_DOWN_LINE = /^\s*(?:$|--|#|\/\/|pass\b|end\b|[})\]]+;?\s*$|return;?\s*$)/;
const NOT_A_ROLLBACK = /NotImplementedError|IrreversibleMigration|irreversible/i;

/** { up, down }: down is the text after the first down marker, or null when the file has none. */
export function splitDirections(text) {
  const positions = DOWN_MARKERS.map((marker) => text.search(marker)).filter((index) => index >= 0);
  if (positions.length === 0) return { up: text, down: null };
  const at = Math.min(...positions);
  return { up: text.slice(0, at), down: text.slice(at) };
}

/** A down section counts only when it does something: not empty, not "pass", not a raise saying it cannot. */
export function downDoesSomething(down) {
  if (down === null || NOT_A_ROLLBACK.test(down)) return false;
  return down.split('\n').slice(1).some((line) => !EMPTY_DOWN_LINE.test(line));
}

/** Rails `def change` with only reversible operations rolls back by itself. */
export function railsReversibleChange(text) {
  return RAILS_CHANGE.test(text) && !RAILS_IRREVERSIBLE_IN_CHANGE.test(text);
}

/** The down file next to an up file: x.up.sql -> x.down.sql. */
export function siblingDownPath(filePath) {
  return /\.up\.[^/]+$/.test(filePath) ? filePath.replace(/\.up\.([^/]+)$/, '.down.$1') : null;
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Statements with their 1-based start line. SQL splits on semicolons; code splits on lines, joining
 * continuation lines until brackets balance so a multi-line call is one statement.
 */
export function statementsOf(filePath, text) {
  const statements = [];
  if (/\.sql$/i.test(filePath)) {
    let start = 0;
    for (const part of text.split(';')) {
      const lead = part.length - part.trimStart().length;
      if (part.trim()) statements.push({ text: part.trim(), line: lineAt(text, start + lead) });
      start += part.length + 1;
    }
    return statements;
  }
  let current = null;
  let depth = 0;
  text.split('\n').forEach((line, index) => {
    if (current === null) current = { text: '', line: index + 1 };
    current.text += `${line}\n`;
    for (const char of line) {
      if ('([{'.includes(char)) depth += 1;
      else if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
    }
    if (depth === 0) {
      if (current.text.trim()) statements.push({ text: current.text.trim(), line: current.line });
      current = null;
    }
  });
  if (current?.text.trim()) statements.push({ text: current.text.trim(), line: current.line });
  return statements;
}

export const LOCK_RISKS = {
  'index-not-concurrent': (s) =>
    (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY)/i.test(s)) ||
    (/\bop\.create_index\(/.test(s) && !/postgresql_concurrently\s*=\s*True/.test(s)) ||
    (/\badd_index\b/.test(s) && !/algorithm:\s*:concurrently/.test(s)),
  'add-column-not-null-no-default': (s) =>
    (/\bADD\s+(?:COLUMN\s+)?(?!CONSTRAINT\b)"?\w+"?\s+\w[^,]*\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s)) ||
    (/\badd_column\(/.test(s) && /nullable\s*=\s*False/.test(s) && !/server_default/.test(s)) ||
    (/\badd_column\s+:/.test(s) && /null:\s*false/.test(s) && !/default:/.test(s)),
  'column-type-change': (s) =>
    /\bALTER\s+COLUMN\s+"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(s) || /\balter_column\([\s\S]*\btype_\s*=/.test(s) || /\bchange_column\s+:/.test(s),
  'constraint-validated': (s) =>
    (/\bADD\s+(?:CONSTRAINT\s+"?\w+"?\s+)?(?:FOREIGN\s+KEY|CHECK)\b/i.test(s) && !/\bNOT\s+VALID\b/i.test(s)) ||
    /\bop\.create_foreign_key\(/.test(s) || /\badd_foreign_key\b(?![\s\S]*validate:\s*false)/.test(s),
  'set-not-null': (s) =>
    /\bALTER\s+COLUMN\s+"?\w+"?\s+SET\s+NOT\s+NULL\b/i.test(s) || (/\balter_column\(/.test(s) && /nullable\s*=\s*False/.test(s)) || /\bchange_column_null\b[^\n]*\bfalse\b/.test(s),
  'table-rewrite': (s) => /\bVACUUM\s+FULL\b|\bCLUSTER\s+\w/i.test(s),
  rename: (s) =>
    /\bRENAME\s+(?:COLUMN\s+\S+\s+)?TO\b/i.test(s) || /\b(?:rename_column|rename_table|renameColumn|renameTable)\b/.test(s) || /\bnew_column_name\s*=/.test(s),
};

/** Lock risks in the up direction: [{ risk, line }]. */
export function lockRisks(filePath, upText) {
  const found = [];
  for (const statement of statementsOf(filePath, upText)) {
    for (const [risk, test] of Object.entries(LOCK_RISKS)) if (test(statement.text)) found.push({ risk, line: statement.line });
  }
  return found;
}

const REMOVED_NAME_PATTERNS = [
  { kind: 'column', pattern: /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi },
  { kind: 'column', pattern: /\bRENAME\s+COLUMN\s+"?(\w+)"?\s+TO\b/gi },
  { kind: 'table', pattern: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi },
  { kind: 'table', pattern: /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?\s+RENAME\s+TO\b/gi },
  { kind: 'column', pattern: /\bop\.drop_column\(\s*['"]\w+['"]\s*,\s*['"](\w+)['"]/g },
  { kind: 'column', pattern: /\bop\.alter_column\(\s*['"]\w+['"]\s*,\s*['"](\w+)['"][^)]*\bnew_column_name\s*=/g },
  { kind: 'table', pattern: /\bop\.(?:drop_table|rename_table)\(\s*['"](\w+)['"]/g },
  { kind: 'column', pattern: /\.(?:dropColumn|renameColumn)\(\s*['"](\w+)['"]/g },
  { kind: 'table', pattern: /\.(?:dropTable|dropTableIfExists|renameTable)\(\s*['"](\w+)['"]/g },
  { kind: 'column', pattern: /\b(?:remove_column|rename_column)\s+:\w+\s*,\s*:(\w+)/g },
  { kind: 'table', pattern: /\b(?:drop_table|rename_table)\s+:(\w+)/g },
];

/** Columns and tables the up direction drops or renames away: [{ kind, name, line }]. */
export function removedNames(upText) {
  const names = [];
  for (const { kind, pattern } of REMOVED_NAME_PATTERNS) {
    for (const match of upText.matchAll(pattern)) names.push({ kind, name: match[1], line: lineAt(upText, match.index) });
  }
  return names;
}

const TABLE_PATTERNS = [
  /\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi,
  /\bINDEX\b[^;]*?\bON\s+(?:ONLY\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?\w+"?\.)?"?(\w+)"?/gi,
  /\bop\.(?:add_column|drop_column|alter_column|create_table|drop_table|rename_table|bulk_insert|execute_on)\(\s*['"](\w+)['"]/g,
  /\bop\.(?:create_index|create_unique_constraint|create_foreign_key|create_check_constraint)\(\s*['"]\w+['"]\s*,\s*['"](\w+)['"]/g,
  /\bschema\.(?:createTable|alterTable|table|dropTable|dropTableIfExists|renameTable)\(\s*['"](\w+)['"]/g,
  /\b(?:create_table|drop_table|add_column|remove_column|change_column|rename_column|add_index|remove_index|change_column_null|change_column_default|add_foreign_key|add_reference)\s+:(\w+)/g,
];
// Words the SQL patterns can capture that are not table names (ON UPDATE CASCADE, DO UPDATE SET...).
const NOT_TABLES = new Set(['if', 'only', 'set', 'table', 'index', 'cascade', 'restrict', 'no']);

/** Table names the up direction creates, alters, drops, indexes or writes rows to. */
export function touchedTables(upText) {
  const tables = new Set();
  for (const pattern of TABLE_PATTERNS) {
    for (const match of upText.matchAll(pattern)) if (!NOT_TABLES.has(match[1].toLowerCase())) tables.add(match[1]);
  }
  return [...tables].sort();
}

/** snake_case column names are often read as camelCase in application code. */
export function nameVariants(name) {
  const camel = name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
  return camel === name ? [name] : [name, camel];
}
