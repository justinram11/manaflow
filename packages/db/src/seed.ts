import { getDb, closeDb } from "./connection";
import { teams, teamMemberships, users } from "./schema/index";
import { eq } from "drizzle-orm";

// Same seed data used by the local auth system
const LOCAL_USERS = [
  {
    id: "local-user-00000000-0000-0000-0000-000000000010",
    email: "justin@getsenes.com",
    displayName: "Justin",
    teamSlug: "justin",
    teamId: "local-team-00000000-0000-0000-0000-000000000010",
  },
  {
    id: "local-user-00000000-0000-0000-0000-000000000020",
    email: "colby@getsenes.com",
    displayName: "Colby",
    teamSlug: "colby",
    teamId: "local-team-00000000-0000-0000-0000-000000000020",
  },
];

console.log("Seeding database...");
const db = getDb();

for (const u of LOCAL_USERS) {
  const now = Date.now();

  // Upsert team
  const existingTeam = db
    .select()
    .from(teams)
    .where(eq(teams.teamId, u.teamId))
    .get();

  if (!existingTeam) {
    db.insert(teams)
      .values({
        id: u.teamId, // Use teamId as the row ID for simplicity
        teamId: u.teamId,
        slug: u.teamSlug,
        displayName: `${u.displayName}'s Team`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    console.log(`  Created team: ${u.teamSlug} (${u.teamId})`);
  } else {
    console.log(`  Team already exists: ${u.teamSlug}`);
  }

  // Upsert user
  const existingUser = db
    .select()
    .from(users)
    .where(eq(users.userId, u.id))
    .get();

  if (!existingUser) {
    db.insert(users)
      .values({
        id: u.id, // Use userId as the row ID
        userId: u.id,
        primaryEmail: u.email,
        displayName: u.displayName,
        selectedTeamId: u.teamId,
        selectedTeamDisplayName: `${u.displayName}'s Team`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    console.log(`  Created user: ${u.displayName} (${u.id})`);
  } else {
    console.log(`  User already exists: ${u.displayName}`);
  }

  // Upsert team membership
  const existingMembership = db
    .select()
    .from(teamMemberships)
    .where(eq(teamMemberships.teamId, u.teamId))
    .get();

  if (!existingMembership) {
    db.insert(teamMemberships)
      .values({
        teamId: u.teamId,
        userId: u.id,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    console.log(`  Created membership: ${u.displayName} -> ${u.teamSlug}`);
  } else {
    console.log(`  Membership already exists: ${u.displayName} -> ${u.teamSlug}`);
  }
}

console.log("Seed complete.");
closeDb();
