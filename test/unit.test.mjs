import test from "node:test";
import assert from "node:assert/strict";
import { parse, visit, Kind } from "graphql";

import * as gql from "../dist/gql.js";
import { parseArgs, getValue, getAll, getPositiveInt } from "../dist/args.js";
import { parseIdentifier, isUuid, resolveStateByName } from "../dist/resolve.js";
import { sanitizeForTerminal, truncate, actorLabel } from "../dist/output.js";
import { redact, registerSecret } from "../dist/errors.js";

/* -------------------------------------------------------------------------- */
/* GraphQL documents                                                           */
/* -------------------------------------------------------------------------- */

const DOCUMENTS = Object.entries(gql).filter(
  ([name, value]) =>
    typeof value === "string" && /query|mutation|fragment/.test(value) && name === name.toUpperCase(),
);

test("every exported GraphQL document parses", () => {
  assert.ok(DOCUMENTS.length >= 10, `expected documents, found ${DOCUMENTS.length}`);
  for (const [name, doc] of DOCUMENTS) {
    assert.doesNotThrow(() => parse(doc), `${name} failed to parse`);
  }
});

test("every fragment spread resolves within its own document", () => {
  // Only the operation documents are self-contained; the bare fragment exports
  // are building blocks that get interpolated into them.
  const operations = DOCUMENTS.filter(([, doc]) => /\b(query|mutation)\s/.test(doc));
  assert.ok(operations.length >= 8);

  for (const [name, doc] of operations) {
    const ast = parse(doc);
    const defined = new Set();
    const spread = new Set();
    visit(ast, {
      [Kind.FRAGMENT_DEFINITION](node) {
        assert.ok(
          !defined.has(node.name.value),
          `${name}: fragment ${node.name.value} defined twice`,
        );
        defined.add(node.name.value);
      },
      [Kind.FRAGMENT_SPREAD](node) {
        spread.add(node.name.value);
      },
    });
    for (const used of spread) {
      assert.ok(defined.has(used), `${name}: uses ...${used} but never defines it`);
    }
  }
});

test("documents never request a token-like field", () => {
  for (const [name, doc] of DOCUMENTS) {
    assert.ok(!/accessToken|apiKey|secret/i.test(doc), `${name} selects a secret field`);
  }
});

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                            */
/* -------------------------------------------------------------------------- */

const LIST_SPEC = { value: ["team", "state", "limit"], boolean: ["delegated"] };

test("parses value flags in both --k v and --k=v form", () => {
  const a = parseArgs(["--team", "ENG", "--state=In Progress"], LIST_SPEC);
  assert.equal(getValue(a, "team"), "ENG");
  assert.equal(getValue(a, "state"), "In Progress");
});

test("collects repeated flags", () => {
  const a = parseArgs(["--label", "bug", "--label", "p1"], { value: ["label"] });
  assert.deepEqual(getAll(a, "label"), ["bug", "p1"]);
});

test("treats a bare - as a positional, not a flag", () => {
  const a = parseArgs(["ENG-42", "-"], {});
  assert.deepEqual(a.positionals, ["ENG-42", "-"]);
});

test("-- stops flag parsing so bodies may start with --", () => {
  const a = parseArgs(["ENG-42", "--", "--not-a-flag"], {});
  assert.deepEqual(a.positionals, ["ENG-42", "--not-a-flag"]);
});

test("--json is accepted on every command", () => {
  assert.ok(parseArgs(["--json"], {}).booleans.has("json"));
});

test("rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--nope"], {}), /Unknown option --nope/);
});

test("rejects a value flag with no value", () => {
  assert.throws(() => parseArgs(["--team"], LIST_SPEC), /--team requires a value/);
});

test("rejects a value given to a boolean flag", () => {
  assert.throws(() => parseArgs(["--delegated=1"], LIST_SPEC), /does not take a value/);
});

test("--limit validates and caps", () => {
  assert.equal(getPositiveInt(parseArgs(["--limit", "5"], LIST_SPEC), "limit", 25, 250), 5);
  assert.equal(getPositiveInt(parseArgs(["--limit", "900"], LIST_SPEC), "limit", 25, 250), 250);
  assert.throws(
    () => getPositiveInt(parseArgs(["--limit", "0"], LIST_SPEC), "limit", 25, 250),
    /positive integer/,
  );
  assert.throws(
    () => getPositiveInt(parseArgs(["--limit", "abc"], LIST_SPEC), "limit", 25, 250),
    /positive integer/,
  );
});

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                 */
/* -------------------------------------------------------------------------- */

test("parses human identifiers, case-insensitively", () => {
  assert.deepEqual(parseIdentifier("ENG-42"), { teamKey: "ENG", number: 42 });
  assert.deepEqual(parseIdentifier("eng-42"), { teamKey: "ENG", number: 42 });
  assert.deepEqual(parseIdentifier("  ENG-7  "), { teamKey: "ENG", number: 7 });
  assert.deepEqual(parseIdentifier("ABC123-9"), { teamKey: "ABC123", number: 9 });
});

test("rejects things that are not identifiers", () => {
  for (const bad of ["ENG", "42", "ENG-", "-42", "ENG-4x", "", "ENG 42"]) {
    assert.throws(() => parseIdentifier(bad), /not a Linear issue identifier/, bad);
  }
});

test("recognises uuids", () => {
  assert.ok(isUuid("7b1f4c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"));
  assert.ok(!isUuid("ENG-42"));
});

/* -------------------------------------------------------------------------- */
/* Workflow states                                                             */
/* -------------------------------------------------------------------------- */

const STATES = [
  { id: "s1", name: "Todo", type: "unstarted", position: 1 },
  { id: "s2", name: "In Progress", type: "started", position: 2 },
  { id: "s3", name: "In Review", type: "started", position: 3 },
];

test("resolves state names case-insensitively", () => {
  assert.equal(resolveStateByName(STATES, "in progress", "ENG").id, "s2");
  assert.equal(resolveStateByName(STATES, "IN REVIEW", "ENG").id, "s3");
  assert.equal(resolveStateByName(STATES, "  Todo ", "ENG").id, "s1");
});

test("an unknown state lists the valid ones", () => {
  try {
    resolveStateByName(STATES, "Shipped", "ENG");
    assert.fail("expected a throw");
  } catch (error) {
    assert.match(error.message, /no workflow state named "Shipped"/);
    assert.match(error.hint, /In Progress/);
    assert.match(error.hint, /In Review/);
    assert.equal(error.code, 4);
  }
});

/* -------------------------------------------------------------------------- */
/* Output hygiene                                                              */
/* -------------------------------------------------------------------------- */

test("strips terminal control sequences from untrusted text", () => {
  const ESC = "\u001B";
  const BEL = "\u0007";
  const DEL = "\u007F";
  const hostile = `before${ESC}[2Jafter${BEL}${DEL}`;
  const clean = sanitizeForTerminal(hostile);
  assert.ok(!clean.includes(ESC), "escape survived");
  assert.ok(!clean.includes(BEL), "bell survived");
  assert.ok(!clean.includes(DEL), "DEL survived");
  assert.ok(clean.includes("before") && clean.includes("after"));
});

test("keeps newlines and tabs, which markdown needs", () => {
  assert.equal(sanitizeForTerminal("a\nb\tc"), "a\nb\tc");
});

test("redacts registered secrets anywhere in a string", () => {
  registerSecret("lin_oauth_supersecrettokenvalue");
  const out = redact("failed with token lin_oauth_supersecrettokenvalue in header");
  assert.ok(!out.includes("supersecret"));
  assert.match(out, /\[REDACTED\]/);
});

test("does not redact trivially short values", () => {
  registerSecret("abc");
  assert.equal(redact("abc def"), "abc def");
});

test("marks app actors in bylines", () => {
  assert.equal(actorLabel({ name: "Claude", displayName: "Claude", app: true }), "Claude (app)");
  assert.equal(actorLabel({ name: "Alvaro", displayName: "Alvaro", app: false }), "Alvaro");
  assert.equal(actorLabel(null, { name: "Someone" }), "Someone (external)");
  assert.equal(actorLabel(null), "unknown");
});

test("truncate collapses whitespace and adds an ellipsis", () => {
  assert.equal(truncate("a  b\nc", 20), "a b c");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
});
