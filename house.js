// The figures that belong to the portal rather than to any one table: how long a table waits
// before dealing itself.
//
// They live in their own file because two places need them and both must say the same thing. The
// server enforces them; the rules sheet every table carries states them. When those two drifted
// apart the sheet was the last place anybody would think to look, and a rule nobody can read
// correctly is not much of a rule.
module.exports = {
  START_GRACE_MS: Number(process.env.START_GRACE_MS || 6000),
};
