import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";

import { permissionRepositoryContract } from "../testing/contracts/permission-repository.contract.js";
import { policyRepositoryContract } from "../testing/contracts/policy-repository.contract.js";
import { roleRepositoryContract } from "../testing/contracts/role-repository.contract.js";
import { userRoleAssignmentRepositoryContract } from "../testing/contracts/user-role-assignment-repository.contract.js";
import { startTestDatabase, type TestDatabase } from "../testing/database-harness.js";

import { PrismaPermissionRepository } from "./prisma-permission-repository.js";
import { PrismaPolicyRepository } from "./prisma-policy-repository.js";
import { PrismaRoleRepository } from "./prisma-role-repository.js";
import { PrismaUserRoleAssignmentRepository } from "./prisma-user-role-assignment-repository.js";

const database = await startTestDatabase();

const USER_1 = "11111111-1111-4111-8111-111111111111";
const USER_2 = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const ROLE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG_X = "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx";
const ORG_Y = "yyyyyyyy-yyyy-4yyy-8yyy-yyyyyyyyyyyy";

describe.skipIf(database === undefined)("Prisma authorization repositories (real Postgres)", () => {
  const db = database as TestDatabase;

  beforeAll(async () => {
    await db.prisma.$connect();
  }, 120_000);

  afterEach(async () => {
    await db.prisma.userRoleAssignment.deleteMany({});
    await db.prisma.rolePermission.deleteMany({});
    await db.prisma.permission.deleteMany({});
    await db.prisma.role.deleteMany({});
    await db.prisma.policy.deleteMany({});
    await db.prisma.organizationMembership.deleteMany({});
    await db.prisma.organization.deleteMany({});
    await db.prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await db.stop();
  }, 120_000);

  describe("PrismaPermissionRepository", () => {
    permissionRepositoryContract(() => new PrismaPermissionRepository(db.prisma));
  });

  describe("PrismaRoleRepository", () => {
    roleRepositoryContract(() => new PrismaRoleRepository(db.prisma));
  });

  describe("PrismaPolicyRepository", () => {
    policyRepositoryContract(() => new PrismaPolicyRepository(db.prisma));
  });

  describe("PrismaUserRoleAssignmentRepository", () => {
    beforeEach(async () => {
      // Seed required relational dependencies
      for (const id of [USER_1, USER_2, ADMIN]) {
        await db.prisma.user.create({
          data: {
            id,
            email: `user-${id}@example.com`,
            displayName: `Contract User ${id.slice(0, 4)}`,
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }

      for (const id of [ROLE_A, ROLE_B]) {
        await db.prisma.role.create({
          data: {
            id,
            name: `role-${id.slice(0, 4)}`,
            description: `Contract test role ${id.slice(0, 4)}`,
            isSystemRole: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }

      for (const id of [ORG_X, ORG_Y]) {
        await db.prisma.organization.create({
          data: {
            id,
            name: `org-${id.slice(0, 4)}`,
            slug: `org-${id.slice(0, 4)}`,
            status: "active",
            ownerId: ADMIN,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }
    });

    userRoleAssignmentRepositoryContract(() => new PrismaUserRoleAssignmentRepository(db.prisma));
  });
});
