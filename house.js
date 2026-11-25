// The figures that belong to the portal rather than to any one table: how long a table waits
// before dealing itself, what the stacks are rounded to when the night is settled, and how long
// a debt may sit before it starts costing somebody his seat.
//
// They live in their own file because two places need them and both must say the same thing. The
// server enforces them; the rules sheet every table carries states them. When those two drifted
// apart the sheet was the last place anybody would think to look, and a rule nobody can read
// correctly is not much of a rule.
module.exports = {
  START_GRACE_MS: Number(process.env.START_GRACE_MS || 6000),
  ROUND_TO: Number(process.env.ROUND_TO || 50),
  YELLOW_AFTER_MS: Number(process.env.YELLOW_AFTER_MS || 48 * 3600e3),
  RED_AFTER_MS: Number(process.env.RED_AFTER_MS || 96 * 3600e3),
  RED_AT_DEBTS: Number(process.env.RED_AT_DEBTS || 3),
};
