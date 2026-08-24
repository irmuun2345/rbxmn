// Composition root for the data layer.
//
// `dbHelpers` used to be a single 1,100-line object literal holding all 95
// query helpers. It is now composed from one repository per domain, each of
// which is a plain factory: given the connection, return that domain's
// helpers. Nothing in the repositories knows about the others.
//
// The composed object is deliberately identical to what the old literal
// exported — same names, same signatures, same callback style — so every
// caller in the app is unaffected. That is the point of composing rather than
// re-architecting: the seam moves, the contract does not.
//
// Adding a domain means adding a file and one line below.
const { db } = require('./connection');
const applySchema = require('./schema');

const repositories = [
  require('./repositories/users'),
  require('./repositories/sessions'),
  require('./repositories/orders'),
  require('./repositories/transactions'),
  require('./repositories/phone-links'),
  require('./repositories/packages'),
  require('./repositories/referrals'),
  require('./repositories/audit'),
  require('./repositories/group-memberships'),
  require('./repositories/receipts'),
  require('./repositories/gift-cards'),
  require('./repositories/payments'),
  require('./repositories/bank-accounts'),
  require('./repositories/admins'),
  require('./repositories/seller-bots'),
  require('./repositories/settings'),
  require('./repositories/events')
];

applySchema(db);

// A name defined by two repositories would silently shadow one of them, and
// the loser would be whichever happened to be listed second. Cheap to check
// at boot, and it turns a subtle wrong-query bug into a startup crash.
const dbHelpers = {};
repositories.forEach((createRepository) => {
  Object.entries(createRepository(db)).forEach(([name, helper]) => {
    if (Object.prototype.hasOwnProperty.call(dbHelpers, name)) {
      throw new Error(`Duplicate db helper "${name}" — two repositories define it.`);
    }
    dbHelpers[name] = helper;
  });
});

module.exports = { db, dbHelpers };
