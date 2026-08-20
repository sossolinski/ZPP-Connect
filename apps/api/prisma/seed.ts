import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { defaultOrganizations, defaultProfile, defaultRoles, dictionaries } from "@zpp/shared";

const prisma = new PrismaClient();

const roleAssignments: Record<string, string[]> = {
  "coordinator@lot.pl": ["zpp-coordinator"],
  "admin@lot.pl": ["system-admin", "zpp-coordinator", "tec-coordinator"],
  "tec@lot.pl": ["tec-member"],
  "zpp@lot.pl": ["zpp-group-leader"],
  "volunteer@lot.pl": ["zpp-member"],
  "viewer@lot.pl": ["observer"]
};

const sampleUsers = [
  { email: "coordinator@lot.pl", displayName: "ZPP Coordinator", department: "Emergency Response", organizationKey: "lot" },
  { email: "admin@lot.pl", displayName: "System Admin", department: "IT / configuration", organizationKey: "lot" },
  { email: "tec@lot.pl", displayName: "TEC Member", department: "Telephone Enquiry Centre", organizationKey: "tec" },
  { email: "zpp@lot.pl", displayName: "ZPP Group Leader", department: "Zespół Pomocy Poszkodowanym", organizationKey: "zpp" },
  { email: "volunteer@lot.pl", displayName: "ZPP Member 01", department: "Zespół Pomocy Poszkodowanym", organizationKey: "zpp" },
  { email: "viewer@lot.pl", displayName: "Observer", department: "Training / observation", organizationKey: "lot" }
];

const obsoleteDemoUsers = ["intake@lot.pl", "matching@lot.pl", "logistics@lot.pl"];
const obsoleteDemoRoles = ["admin", "coordinator", "tec", "zpp", "volunteer", "viewer", "intake_agent", "family_assistance", "matching_officer", "welfare_logistics"];

async function seedOrganizations() {
  for (const organization of defaultOrganizations) {
    await prisma.organization.upsert({
      where: { key: organization.key },
      update: {
        name: organization.name,
        type: organization.type,
        status: organization.status,
        contactEmail: organization.contactEmail,
        description: organization.description
      },
      create: organization
    });
  }
}

async function seedRolesAndUsers() {
  for (const role of defaultRoles) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {
        displayName: role.displayName,
        description: role.description,
        permissions: role.permissions
      },
      create: {
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        permissions: role.permissions
      }
    });
  }

  for (const user of sampleUsers) {
    const organization = await prisma.organization.findUnique({
      where: { key: user.organizationKey }
    });
    const userData = {
      email: user.email,
      displayName: user.displayName,
      department: user.department,
      organizationId: organization?.id
    };
    const dbUser = await prisma.user.upsert({
      where: { email: user.email },
      update: userData,
      create: userData
    });

    for (const roleName of roleAssignments[user.email] ?? []) {
      const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
      const scopeType = user.email === "zpp@lot.pl" && roleName === "zpp-group-leader" ? "GROUP" : "GLOBAL";
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: dbUser.id, roleId: role.id } },
        update: { scopeType },
        create: {
          userId: dbUser.id,
          roleId: role.id,
          scopeType,
          assignedBy: "seed"
        }
      });
    }
  }

  await prisma.userRole.deleteMany({
    where: {
      OR: [
        { user: { email: { in: obsoleteDemoUsers } } },
        { role: { name: { in: obsoleteDemoRoles } } }
      ]
    }
  });
  await prisma.user.deleteMany({ where: { email: { in: obsoleteDemoUsers } } });
  await prisma.role.deleteMany({ where: { name: { in: obsoleteDemoRoles } } });
}

async function seedDictionaries() {
  const profileRows: Array<[string, string, string]> = [
    ["profile", "organizationName", defaultProfile.organizationName],
    ["profile", "appSubtitle", defaultProfile.appSubtitle],
    ["profile", "genericSubtitle", defaultProfile.genericSubtitle],
    ["profile", "teamName", defaultProfile.teamName],
    ["profile", "contactEmail", defaultProfile.contactEmail],
    ["profile", "author", defaultProfile.author],
    ["profile", "footerText", defaultProfile.footerText]
  ];

  for (let index = 0; index < profileRows.length; index += 1) {
    const [category, key, label] = profileRows[index]!;
    await prisma.dictionary.upsert({
      where: {
        profile_category_key: {
          profile: defaultProfile.id,
          category,
          key
        }
      },
      update: { label, sortOrder: index },
      create: {
        profile: defaultProfile.id,
        category,
        key,
        label,
        sortOrder: index
      }
    });
  }

  for (const [category, values] of Object.entries(dictionaries)) {
    for (let index = 0; index < values.length; index += 1) {
      const label = values[index]!;
      const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      await prisma.dictionary.upsert({
        where: {
          profile_category_key: {
            profile: defaultProfile.id,
            category,
            key
          }
        },
        update: { label, sortOrder: index, isActive: true },
        create: {
          profile: defaultProfile.id,
          category,
          key,
          label,
          sortOrder: index,
          isActive: true
        }
      });
    }
  }
}

async function seedMemberDirectory(input: {
  incidentId: string;
  adminId: string;
  tecId: string;
  zppId: string;
  volunteerId: string;
}) {
  const timestamp = new Date("2026-07-09T09:00:00.000Z");
  const members = [
    ["mem-2026-000001", "ZPP-001", input.zppId, "Anna", "Kowalska", "ZPP", "Family Assistance Lead", "Family Assistance Team", "anna.kowalska@lot.pl", "+48 600 100 001", ["PL", "EN"], "Today 06:00-14:00", "Confirmed", "Confirmed", "ZPP Coordinator"],
    ["mem-2026-000002", "TEC-001", input.tecId, "Piotr", "Nowak", "TEC", "TEC Supervisor", "Telephone Enquiry Center", "piotr.nowak@lot.pl", "+48 600 200 001", ["PL", "EN"], "Today 12:00-20:00", "Confirmed", "Confirmed", "Leader Bravo"],
    ["mem-2026-000003", "ZPP-006", null, "Marta", "Zielinska", "ZPP", "Family Assistance Member", "Family Assistance Team", "marta.zielinska@lot.pl", "+48 600 100 006", ["PL", "EN"], "Today 06:00-14:00", "Confirmed", "Confirmed", "Leader Alpha"],
    ["mem-2026-000004", "ZPP-012", null, "Monika", "Wozniak", "ZPP", "Family Assistance Member", "Family Assistance Team", "monika.wozniak@lot.pl", "+48 600 100 012", ["PL"], "Today 06:00-14:00", "Pending", "Pending", "Leader Alpha"],
    ["mem-2026-000005", "ZPP-018", null, "Ewa", "Lewandowska", "ZPP", "Welfare Support", "Welfare Support", "ewa.lewandowska@lot.pl", "+48 600 100 018", ["PL", "UA"], "Today 06:00-14:00", "Confirmed", "Available", "Leader Echo"],
    ["mem-2026-000006", "ZPP-024", null, "Agnieszka", "Kaczmarek", "ZPP", "Welfare Support", "Welfare Support", "agnieszka.kaczmarek@lot.pl", "+48 600 100 024", ["PL", "EN"], "Tomorrow 06:00-14:00", "Confirmed", "Available", "Leader Echo"],
    ["mem-2026-000007", "ZPP-030", null, "Magdalena", "Jankowska", "ZPP", "Family Assistance Member", "Family Assistance Team", "magdalena.jankowska@lot.pl", null, ["PL"], "Today 06:00-14:00", "Restricted", "Confirmed", "Leader Alpha"],
    ["mem-2026-000008", "ZPP-221", input.volunteerId, "Adam", "Dabrowski", "ZPP", "Roster Support", "Member Rostering", "adam.dabrowski@lot.pl", "+48 600 100 221", ["PL", "EN", "UA"], "Unavailable today", "Restricted", "Unavailable", "Leader Foxtrot"],
    ["mem-2026-000009", "TEC-170", null, "Adam", "Pawlak", "TEC", "Contact Center Agent", "Contact Center", "adam.pawlak@lot.pl", "+48 600 200 170", ["PL", "EN", "DE"], "Today 12:00-20:00", "Restricted", "Available", "Leader Charlie"],
    ["mem-2026-000010", "ZPP-255", null, "Krzysztof", "Szymanski", "ZPP", "Logistics Support", "Logistics Support", "krzysztof.szymanski@lot.pl", "+48 600 100 255", ["PL", "EN", "FR"], "Today 14:00-22:00", "Restricted", "Confirmed", "Leader Delta"],
  ] as const;

  for (const [id, memberId, linkedUserId, firstName, lastName, pool, role, assignedFunction, contactEmail, phone, languages, legacyAvailability, legacyTrainingStatus, legacyRosterStatus, legacyAssignedLeader] of members) {
    await prisma.memberProfile.upsert({
      where: { id },
      update: { memberId, linkedUserId, firstName, lastName, pool, role, assignedFunction, contactEmail, normalizedContactEmail: contactEmail.toLowerCase(), phone, languages: [...languages], legacyAvailability, legacyTrainingStatus, legacyRosterStatus, legacyAssignedLeader },
      create: { id, memberId, linkedUserId, firstName, lastName, pool, role, assignedFunction, contactEmail, normalizedContactEmail: contactEmail.toLowerCase(), phone, languages: [...languages], legacyAvailability, legacyTrainingStatus, legacyRosterStatus, legacyAssignedLeader, createdAt: timestamp, updatedAt: timestamp, createdById: input.adminId, updatedById: input.adminId }
    });
  }

  const groups = [
    ["grp-2026-000001", "GRP-2026-000001", "Family Assistance Alpha", "ZPP", "Family Assistance Team", "Active", "Primary family assistance group for the current operating period."],
    ["grp-2026-000002", "GRP-2026-000002", "TEC Evening Team", "TEC", "Telephone Enquiry Center", "Active", "Evening call intake and enquiry triage coverage."],
    ["grp-2026-000003", "GRP-2026-000003", "Welfare Support Reserve", "ZPP", "Welfare Support", "Standby", "Reserve pool for welfare support escalation."],
    ["grp-2026-000004", "GRP-2026-000004", "Documentation Cell", "Mixed", "Documentation Support", "Draft", "Documentation and handover support group."],
  ] as const;
  for (const [id, operationalId, name, pool, functionName, status, notes] of groups) {
    await prisma.operationalGroup.upsert({
      where: { id },
      update: { incidentId: input.incidentId, operationalId, name, pool, functionName, status, notes },
      create: { id, operationalId, incidentId: input.incidentId, name, pool, functionName, status, notes, createdAt: timestamp, updatedAt: timestamp, createdById: input.adminId, updatedById: input.adminId }
    });
  }

  const memberships = [
    ["gmb-2026-000001", "grp-2026-000001", "mem-2026-000001", "Leader"],
    ["gmb-2026-000002", "grp-2026-000001", "mem-2026-000003", "Member"],
    ["gmb-2026-000003", "grp-2026-000001", "mem-2026-000004", "Member"],
    ["gmb-2026-000004", "grp-2026-000001", "mem-2026-000005", "Member"],
    ["gmb-2026-000005", "grp-2026-000001", "mem-2026-000006", "Member"],
    ["gmb-2026-000006", "grp-2026-000001", "mem-2026-000007", "Member"],
    ["gmb-2026-000007", "grp-2026-000002", "mem-2026-000002", "Leader"],
    ["gmb-2026-000008", "grp-2026-000002", "mem-2026-000009", "Member"],
    ["gmb-2026-000009", "grp-2026-000002", "mem-2026-000010", "Member"],
    ["gmb-2026-000010", "grp-2026-000003", "mem-2026-000005", "Reserve"],
    ["gmb-2026-000011", "grp-2026-000003", "mem-2026-000006", "Leader"],
    ["gmb-2026-000012", "grp-2026-000004", "mem-2026-000008", "Leader"],
  ] as const;
  for (const [id, groupId, memberProfileId, role] of memberships) {
    await prisma.groupMembership.upsert({
      where: { id },
      update: { groupId, memberProfileId, role, removedAt: null, removedById: null },
      create: { id, groupId, memberProfileId, role, addedAt: timestamp, addedById: input.adminId }
    });
  }

  const zppLeaderRole = await prisma.role.findUniqueOrThrow({ where: { name: "zpp-group-leader" } });
  await prisma.groupRoleAssignment.upsert({
    where: { id: "gra-zpp-alpha" },
    update: { userId: input.zppId, roleId: zppLeaderRole.id, groupId: "grp-2026-000001", status: "Active", revokedAt: null, revokedBy: null },
    create: { id: "gra-zpp-alpha", userId: input.zppId, roleId: zppLeaderRole.id, groupId: "grp-2026-000001", status: "Active", assignedAt: timestamp, assignedBy: input.adminId }
  });

  await prisma.$executeRawUnsafe(`SELECT setval('"MemberProfile_id_seq"', 10, true)`);
  await prisma.$executeRawUnsafe(`SELECT setval('"MemberProfile_business_seq"', 255, true)`);
  await prisma.$executeRawUnsafe(`SELECT setval('"OperationalGroup_id_seq"', 4, true)`);
  await prisma.$executeRawUnsafe(`SELECT setval('"GroupMembership_id_seq"', 12, true)`);
}

async function seedTraining(input: { adminId: string; coordinatorId: string; zppId: string }) {
  const timestamp = new Date("2026-07-09T09:00:00.000Z");
  const courses = [
    ["crs-2026-000001", "ERP-FAM", "ERP Familiarization", "Core briefing for working inside the active response structure.", "Core", "Briefing", 24, true, true, null],
    ["crs-2026-000002", "FAC-BASICS", "Family Assistance Basics", "Practical expectations for family support work and handover.", "Family Assistance", "Classroom", 12, true, false, null],
    ["crs-2026-000003", "PFA-AWARE", "Psychological First Aid Awareness", "Recognition, boundaries and escalation for welfare support.", "Welfare", "E-learning", 12, true, true, null],
    ["crs-2026-000004", "TEC-PROC", "Telephone Enquiry Center Procedures", "Call handling, status boundaries and escalation practice for TEC work.", "TEC", "Practical", 6, true, true, null],
    ["crs-2026-000005", "DATA-CRISIS", "Data Protection for Crisis Response", "Sensitive information handling for crisis response records.", "Data Protection", "E-learning", 12, true, true, null],
    ["crs-2026-000006", "ROLE-CARD", "Role Card Briefing", "Historical role-card briefing retained for previous completion records.", "Coordination", "Briefing", 12, false, false, "2026-07-10T12:00:00.000Z"],
  ] as const;
  for (const [id, code, title, description, category, deliveryType, validityMonths, active, selfCompletable, deactivatedAt] of courses) {
    const data = {
      code,
      normalizedCode: code,
      title,
      description,
      category,
      deliveryType,
      validityMonths,
      active,
      selfCompletable,
      deactivatedAt: deactivatedAt ? new Date(deactivatedAt) : null,
      legacyImported: true,
      legacyMetadata: { provenance: "memory-seed" },
      createdAt: timestamp,
      updatedAt: timestamp,
      createdById: input.adminId,
      updatedById: input.adminId,
    };
    await prisma.trainingCourse.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  const requirements = [
    ["trq-2026-000001", "crs-2026-000005", "Role", "ZPP Member", null, null, "Required", "2026-07-25T12:00:00.000Z"],
    ["trq-2026-000002", "crs-2026-000002", "Group", null, "grp-2026-000001", null, "Required", "2026-07-20T12:00:00.000Z"],
    ["trq-2026-000003", "crs-2026-000004", "MemberProfile", null, null, "mem-2026-000002", "Required", "2026-07-08T12:00:00.000Z"],
    ["trq-2026-000004", "crs-2026-000001", "Role", "ZPP Member", null, null, "Recommended", "2026-08-01T12:00:00.000Z"],
  ] as const;
  for (const [id, courseId, targetType, targetRole, groupId, memberProfileId, requiredStatus, dueAt] of requirements) {
    const data = {
      courseId,
      targetType,
      targetRole,
      groupId,
      memberProfileId,
      requiredStatus,
      dueAt: new Date(dueAt),
      effectiveFrom: new Date("2026-07-09T00:00:00.000Z"),
      active: true,
      provenance: { source: "memory-seed", actorEvidenceAvailable: false },
      createdAt: timestamp,
      updatedAt: timestamp,
      createdById: input.adminId,
      updatedById: input.adminId,
    };
    await prisma.trainingRequirement.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  const records = [
    ["trn-2026-000001", "TRN-2026-000001", "mem-2026-000008", "crs-2026-000005", "trq-2026-000001", "2026-07-10T08:00:00.000Z", "2026-07-20T12:00:00.000Z", "Assigned", null, null, null, null, null],
    ["trn-2026-000002", "TRN-2026-000002", "mem-2026-000008", "crs-2026-000001", null, "2026-06-15T08:00:00.000Z", "2026-08-01T12:00:00.000Z", "Completed", "2026-07-01T10:00:00.000Z", "2028-07-01T10:00:00.000Z", "Completed during response familiarization.", input.zppId, "2026-07-01T11:00:00.000Z"],
    ["trn-2026-000003", "TRN-2026-000003", "mem-2026-000003", "crs-2026-000002", "trq-2026-000002", "2026-07-09T08:00:00.000Z", "2026-07-20T12:00:00.000Z", "In Progress", null, null, null, null, null],
    ["trn-2026-000004", "TRN-2026-000004", "mem-2026-000002", "crs-2026-000004", "trq-2026-000003", "2026-07-05T08:00:00.000Z", "2026-07-08T12:00:00.000Z", "Assigned", null, null, null, null, null],
    ["trn-2026-000005", "TRN-2026-000005", "mem-2026-000001", "crs-2026-000005", "trq-2026-000001", "2025-07-01T08:00:00.000Z", "2025-08-01T12:00:00.000Z", "Completed", "2025-08-01T09:00:00.000Z", "2026-08-01T09:00:00.000Z", "Annual refresher completed.", input.adminId, "2025-08-01T10:00:00.000Z"],
    ["trn-2026-000006", "TRN-2026-000006", "mem-2026-000005", "crs-2026-000003", null, "2025-05-01T08:00:00.000Z", "2025-06-01T12:00:00.000Z", "Completed", "2025-06-01T09:00:00.000Z", "2026-06-01T09:00:00.000Z", "Previous welfare support course.", null, null],
  ] as const;
  for (const [id, operationalId, memberProfileId, courseId, sourceRequirementId, assignedAt, dueAt, status, completedAt, expiryAt, completionNote, verifiedById, verifiedAt] of records) {
    const data = {
      operationalId,
      memberProfileId,
      courseId,
      sourceRequirementId,
      assignedAt: new Date(assignedAt),
      assignedById: input.coordinatorId,
      dueAt: new Date(dueAt),
      status,
      completedAt: completedAt ? new Date(completedAt) : null,
      expiryAt: expiryAt ? new Date(expiryAt) : null,
      completionNote,
      verifiedById,
      verifiedAt: verifiedAt ? new Date(verifiedAt) : null,
      legacyImported: true,
      legacyMetadata: { provenance: "memory-seed", completionActorAvailable: false, startActorAvailable: false },
      provenance: { source: "memory-seed" },
      createdAt: timestamp,
      updatedAt: timestamp,
      createdById: input.coordinatorId,
      updatedById: input.coordinatorId,
    };
    await prisma.memberTrainingRecord.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  await prisma.$queryRaw`SELECT setval('"TrainingCourse_id_seq"', GREATEST(COALESCE((SELECT MAX(substring("id" FROM '([0-9]+)$')::BIGINT) FROM "TrainingCourse"), 0) + 1, 1), false)`;
  await prisma.$queryRaw`SELECT setval('"TrainingRequirement_id_seq"', GREATEST(COALESCE((SELECT MAX(substring("id" FROM '([0-9]+)$')::BIGINT) FROM "TrainingRequirement"), 0) + 1, 1), false)`;
  await prisma.$queryRaw`SELECT setval('"MemberTrainingRecord_id_seq"', GREATEST(COALESCE((SELECT MAX(substring("id" FROM '([0-9]+)$')::BIGINT) FROM "MemberTrainingRecord"), 0) + 1, 1), false)`;
}

async function seedDocuments(input: { adminId: string; zppId: string }) {
  const timestamp = new Date("2026-07-09T09:00:00.000Z");
  const documents = [
    ["doc-2026-000001", "ERP-ROLE-CARDS", "ERP Role Cards", "Role cards for response functions during an active session.", "Coordination", "Crisis Coordination", true, null],
    ["doc-2026-000002", "TEC-CALL-GUIDE", "TEC Call Intake Guide", "Call intake guidance for enquiries without disclosing passenger or casualty status.", "TEC", "Telephone Enquiry Center", true, null],
    ["doc-2026-000003", "FAC-HANDOVER", "Family Assistance Handover", "Handover notes and minimum briefing content for FAC teams.", "Family Assistance", "Family Assistance Team", true, null],
    ["doc-2026-000004", "DATA-SENSITIVE", "Sensitive Data Handling", "Rules for protecting passenger, crew and family information.", "Data Protection", "Data Protection", true, null],
    ["doc-2026-000005", "ROSTER-BRIEF", "Roster Coverage Briefing", "Draft briefing format for roster coverage reviews.", "Rostering", "Member Rostering", true, null],
    ["doc-2026-000006", "AIRPORT-RECEPTION", "Airport Reception Checklist", "Historical checklist retained for reference.", "Airport Support", "Airport Support", false, "2026-07-01T09:00:00.000Z"],
  ] as const;
  for (const [id, code, title, description, category, ownerFunction, active, archivedAt] of documents) {
    const data = { code, normalizedCode: code, title, description, category, ownerFunction, active, archivedAt: archivedAt ? new Date(archivedAt) : null, legacyImported: true, legacyMetadata: { provenance: "memory-seed" }, createdById: input.adminId, updatedById: input.adminId };
    await prisma.document.upsert({ where: { id }, update: data, create: { id, ...data, createdAt: timestamp, updatedAt: timestamp } });
  }

  const roleCardsV1 = "Earlier role-card guidance retained for audit history.";
  const roleCardsV2 = [
    "Use these role cards before taking work in a specialist queue.", "", "1. Confirm the active session and your assigned function.",
    "2. Open your own work queue before searching wider records.", "3. Escalate anything that involves disclosure, identity uncertainty or a welfare risk.",
    "4. Leave a concise handover note when work moves to another person.",
  ].join("\n");
  const tecGuide = "Capture who is calling, how to contact them, what they reported and whether support action is needed. Do not confirm passenger, casualty or NOK status from this workflow.";
  const facHandover = "Before handover, record the family reference, agreed next contact, open welfare needs, owner and any disclosure restriction. Keep handover notes concise and suitable for the next response member.";
  const versions = [
    { id: "dver-2026-000001", documentId: "doc-2026-000001", versionLabel: "v1.0", status: "Superseded", changeSummary: "Initial role-card set.", effectiveFrom: "2026-05-01T08:00:00.000Z", reviewDueAt: "2026-08-01T08:00:00.000Z", publishedAt: "2026-05-01T08:00:00.000Z", publishedById: input.adminId, contentMode: "Internal text", contentBody: roleCardsV1, externalUrl: null, basePublishedVersionId: null, actorId: input.adminId },
    { id: "dver-2026-000002", documentId: "doc-2026-000001", versionLabel: "v2.0", status: "Published", changeSummary: "Clarifies first action, escalation and handover checks.", effectiveFrom: "2026-07-09T08:00:00.000Z", reviewDueAt: "2026-10-01T08:00:00.000Z", publishedAt: "2026-07-09T08:00:00.000Z", publishedById: input.adminId, contentMode: "Internal text", contentBody: roleCardsV2, externalUrl: null, basePublishedVersionId: "dver-2026-000001", actorId: input.adminId },
    { id: "dver-2026-000003", documentId: "doc-2026-000002", versionLabel: "v1.1", status: "Published", changeSummary: "Adds caller-contact confirmation before enquiry save.", effectiveFrom: "2026-07-09T08:00:00.000Z", reviewDueAt: "2026-09-15T08:00:00.000Z", publishedAt: "2026-07-09T08:00:00.000Z", publishedById: input.adminId, contentMode: "Internal text", contentBody: tecGuide, externalUrl: null, basePublishedVersionId: null, actorId: input.adminId },
    { id: "dver-2026-000004", documentId: "doc-2026-000003", versionLabel: "v1.0", status: "Published", changeSummary: "First controlled handover guide.", effectiveFrom: "2026-07-09T08:00:00.000Z", reviewDueAt: "2026-09-01T08:00:00.000Z", publishedAt: "2026-07-09T08:00:00.000Z", publishedById: input.zppId, contentMode: "Internal text", contentBody: facHandover, externalUrl: null, basePublishedVersionId: null, actorId: input.zppId },
    { id: "dver-2026-000005", documentId: "doc-2026-000004", versionLabel: "v3.0", status: "Published", changeSummary: "Links to the current sensitive data handling standard.", effectiveFrom: "2026-07-09T08:00:00.000Z", reviewDueAt: "2026-12-01T08:00:00.000Z", publishedAt: "2026-07-09T08:00:00.000Z", publishedById: input.adminId, contentMode: "External link", contentBody: null, externalUrl: "https://example.com/zpp/sensitive-data-handling", basePublishedVersionId: null, actorId: input.adminId },
    { id: "dver-2026-000006", documentId: "doc-2026-000005", versionLabel: "draft-2026-07", status: "Draft", changeSummary: "Draft roster briefing structure.", effectiveFrom: null, reviewDueAt: null, publishedAt: null, publishedById: null, contentMode: "Internal text", contentBody: "Draft: identify gaps, confirm owners and record next contact time.", externalUrl: null, basePublishedVersionId: null, actorId: input.zppId },
  ] as const;
  for (const version of versions) {
    const contentDigest = version.status !== "Draft" && version.contentMode === "Internal text" ? createHash("sha256").update(version.contentBody!, "utf8").digest("hex") : null;
    const data = { documentId: version.documentId, versionLabel: version.versionLabel, normalizedVersionLabel: version.versionLabel.toLowerCase(), status: version.status, changeSummary: version.changeSummary, effectiveFrom: version.effectiveFrom ? new Date(version.effectiveFrom) : null, reviewDueAt: version.reviewDueAt ? new Date(version.reviewDueAt) : null, publishedAt: version.publishedAt ? new Date(version.publishedAt) : null, publishedById: version.publishedById, contentMode: version.contentMode, contentBody: version.contentBody, externalUrl: version.externalUrl, contentDigest, basePublishedVersionId: version.basePublishedVersionId, legacyImported: true, legacyMetadata: { provenance: "memory-seed" }, createdById: version.actorId, updatedById: version.actorId };
    await prisma.documentVersion.upsert({ where: { id: version.id }, update: data, create: { id: version.id, ...data, createdAt: timestamp, updatedAt: timestamp } });
  }

  const requirements = [
    ["dreq-2026-000001", "dver-2026-000002", "Role", "ZPP Member", null, null, true, "2026-07-30T12:00:00.000Z", input.adminId],
    ["dreq-2026-000002", "dver-2026-000003", "Role", "TEC Member", null, null, true, "2026-07-20T12:00:00.000Z", input.adminId],
    ["dreq-2026-000003", "dver-2026-000004", "Group", null, "grp-2026-000001", null, true, "2026-07-22T12:00:00.000Z", input.zppId],
    ["dreq-2026-000004", "dver-2026-000005", "MemberProfile", null, null, "mem-2026-000001", true, null, input.adminId],
    ["dreq-2026-000005", "dver-2026-000002", "Group", null, "grp-2026-000001", null, true, "2026-07-25T12:00:00.000Z", input.zppId],
  ] as const;
  for (const [id, documentVersionId, targetType, targetRole, groupId, memberProfileId, acknowledgementRequired, dueAt, actorId] of requirements) {
    const data = { documentVersionId, targetType, targetRole, groupId, memberProfileId, acknowledgementRequired, effectiveFrom: new Date("2026-07-09T08:00:00.000Z"), dueAt: dueAt ? new Date(dueAt) : null, active: true, provenance: { source: "memory-seed" }, endedAt: null, endedById: null, createdById: actorId, updatedById: actorId };
    await prisma.documentRequirement.upsert({ where: { id }, update: data, create: { id, ...data, createdAt: timestamp, updatedAt: timestamp } });
  }

  let acknowledgement = await prisma.documentAcknowledgement.findUnique({ where: { id: "dack-2026-000001" } });
  if (!acknowledgement) acknowledgement = await prisma.documentAcknowledgement.create({
    data: {
      id: "dack-2026-000001", documentVersionId: "dver-2026-000002", memberProfileId: "mem-2026-000003",
      acknowledgedAt: new Date("2026-07-10T09:00:00.000Z"), acknowledgedById: input.zppId,
      acknowledgementStatementVersion: "standard-v1", note: null, onBehalf: true,
      documentCode: "ERP-ROLE-CARDS", documentTitle: "ERP Role Cards", versionLabel: "v2.0", contentMode: "Internal text",
      contentDigestSnapshot: null, legacyImported: true,
      legacyMetadata: { provenance: "memory-seed", historicalEvidenceUnavailable: true, onBehalfNoteUnavailable: true },
      createdAt: new Date("2026-07-10T09:00:00.000Z"),
    },
  });
  for (const requirementId of ["dreq-2026-000001", "dreq-2026-000005"]) {
    const link = await prisma.documentAcknowledgementRequirement.findUnique({ where: { acknowledgementId_requirementId: { acknowledgementId: acknowledgement.id, requirementId } } });
    if (!link) await prisma.documentAcknowledgementRequirement.create({ data: { acknowledgementId: acknowledgement.id, requirementId } });
  }
  await prisma.$queryRaw`SELECT setval('"Document_id_seq"', GREATEST(COALESCE((SELECT MAX(substring("id" FROM '([0-9]+)$')::BIGINT) FROM "Document"), 0) + 1, 1), false)`;
  await prisma.$queryRaw`SELECT setval('"DocumentVersion_id_seq"', GREATEST(COALESCE((SELECT MAX(substring("id" FROM '([0-9]+)$')::BIGINT) FROM "DocumentVersion"), 0) + 1, 1), false)`;
  await prisma.$queryRaw`SELECT setval('"DocumentRequirement_id_seq"', GREATEST(COALESCE((SELECT MAX(substring("id" FROM '([0-9]+)$')::BIGINT) FROM "DocumentRequirement"), 0) + 1, 1), false)`;
  await prisma.$queryRaw`SELECT setval('"DocumentAcknowledgement_id_seq"', GREATEST(COALESCE((SELECT MAX(substring("id" FROM '([0-9]+)$')::BIGINT) FROM "DocumentAcknowledgement"), 0) + 1, 1), false)`;
}

async function seedOperationalData() {
  const coordinator = await prisma.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } });
  const tec = await prisma.user.findUniqueOrThrow({ where: { email: "tec@lot.pl" } });
  const zpp = await prisma.user.findUniqueOrThrow({ where: { email: "zpp@lot.pl" } });
  const volunteer = await prisma.user.findUniqueOrThrow({ where: { email: "volunteer@lot.pl" } });

  const session = await prisma.session.upsert({
    where: { operationalId: "SES-2026-001" },
    update: {},
    create: {
      operationalId: "SES-2026-001",
      mode: "EXERCISE",
      status: "Active",
      eventType: "Exercise",
      flightNumber: "LO3924",
      route: "KRK-WAW",
      aircraftRegistration: "SP-LRA",
      airportLocation: "Warsaw Chopin Airport",
      description: "ZPP tabletop exercise for family assistance, matching and reunification workflows.",
      startAt: new Date("2026-06-21T08:00:00.000Z"),
      createdById: coordinator.id,
      notes: "Seed exercise session. All records are simulated and must remain separated from real activations."
    }
  });

  const incidentUsers = await prisma.user.findMany({
    where: { email: { in: sampleUsers.map((user) => user.email) } }
  });
  for (const user of incidentUsers) {
    await prisma.incidentAssignment.upsert({
      where: { incidentId_userId: { incidentId: session.id, userId: user.id } },
      update: { active: true, revokedAt: null, revokedById: null, revokeReason: null },
      create: {
        incidentId: session.id,
        userId: user.id,
        function: "Seed exercise access",
        scope: "OPERATIONAL",
        createdById: admin.id
      }
    });
  }

  await seedMemberDirectory({ incidentId: session.id, adminId: admin.id, tecId: tec.id, zppId: zpp.id, volunteerId: volunteer.id });
  await seedTraining({ adminId: admin.id, coordinatorId: coordinator.id, zppId: zpp.id });
  await seedDocuments({ adminId: admin.id, zppId: zpp.id });

  const rosterTimestamp = new Date("2026-07-09T09:00:00.000Z");
  const rosterShifts = [
    ["rst-2026-000001", "RST-001", "grp-2026-000001", "mem-2026-000003", "Family Assistance Centre morning support", "Family support desk", "Family Assistance Team", "2026-07-13T04:00:00.000Z", "2026-07-13T12:00:00.000Z", "Family Assistance Centre", "Published", "Confirm readiness before the morning handover."],
    ["rst-2026-000002", "RST-002", "grp-2026-000004", "mem-2026-000008", "Documentation Cell afternoon support", "Record review", "Documentation Support", "2026-07-13T12:00:00.000Z", "2026-07-13T20:00:00.000Z", "Remote support", "Published", "Review assigned notes and confirm availability."],
    ["rst-2026-000003", "RST-003", "grp-2026-000002", "mem-2026-000002", "Telephone Enquiry Center evening supervisor", "TEC supervision", "Telephone Enquiry Center", "2026-07-13T10:00:00.000Z", "2026-07-13T18:00:00.000Z", "Hybrid", "Confirmed", "Supervisor confirmed for the evening handover."],
    ["rst-2026-000004", "RST-004", "grp-2026-000003", "mem-2026-000005", "Welfare Support reserve shift", "Reserve coverage", "Welfare Support", "2026-07-14T06:00:00.000Z", "2026-07-14T14:00:00.000Z", "On-site", "Cancelled", "Cancelled after coverage plan changed."],
    ["rst-2026-000005", "RST-005", "grp-2026-000001", "mem-2026-000001", "Family Assistance initial briefing", "Briefing support", "Family Assistance Team", "2026-07-08T06:00:00.000Z", "2026-07-08T08:00:00.000Z", "Command room", "Completed", "Briefing completed."],
    ["rst-2026-000006", "RST-006", "grp-2026-000003", null, "Airport Reception Support cover", "Reception support", "Airport Reception Support", "2026-07-15T04:00:00.000Z", "2026-07-15T12:00:00.000Z", "Airport desk", "Draft", "Assign a trained member before publishing."],
  ] as const;
  for (const [id, operationalId, groupId, assignedMemberProfileId, title, duty, functionName, startAt, endAt, location, status, notes] of rosterShifts) {
    const data = { sessionId: session.id, groupId, assignedMemberProfileId, title, duty, functionName, startAt: new Date(startAt), endAt: new Date(endAt), location, status, notes, legacyImported: true, legacyMetadata: { provenance: "memory-seed", transitionActorsAvailable: false }, createdAt: rosterTimestamp, updatedAt: rosterTimestamp, createdById: admin.id, updatedById: admin.id };
    await prisma.rosterShift.upsert({ where: { id }, update: data, create: { id, operationalId, ...data } });
  }

  const availability = [
    ["avl-2026-000001", "AVL-001", "mem-2026-000008", "2026-07-13T12:00:00.000Z", "2026-07-13T20:00:00.000Z", "Available", "Can support documentation work remotely.", volunteer.id],
    ["avl-2026-000002", "AVL-002", "mem-2026-000005", "2026-07-14T05:00:00.000Z", "2026-07-14T13:00:00.000Z", "Unavailable", "Unavailable during this window.", admin.id],
    ["avl-2026-000003", "AVL-003", "mem-2026-000006", "2026-07-15T04:00:00.000Z", "2026-07-15T12:00:00.000Z", "Preferred", "Prefers airport reception support.", admin.id],
    ["avl-2026-000004", "AVL-004", "mem-2026-000002", "2026-07-13T10:00:00.000Z", "2026-07-13T18:00:00.000Z", "Available", "TEC supervisor available for hybrid duty.", tec.id],
  ] as const;
  for (const [id, operationalId, memberProfileId, startAt, endAt, type, note, actorId] of availability) {
    const data = { memberProfileId, startAt: new Date(startAt), endAt: new Date(endAt), type, note, status: "Active", createdAt: rosterTimestamp, updatedAt: rosterTimestamp, createdById: actorId, updatedById: actorId };
    await prisma.availability.upsert({ where: { id }, update: data, create: { id, operationalId, ...data } });
  }

  await prisma.$queryRaw`SELECT setval('"RosterShift_operational_seq"', GREATEST(COALESCE((SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT) FROM "RosterShift"), 0) + 1, 1), false)`;
  await prisma.$queryRaw`SELECT setval('"Availability_operational_seq"', GREATEST(COALESCE((SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT) FROM "Availability"), 0) + 1, 1), false)`;

  const enquiry1 = await prisma.enquiry.upsert({
    where: { operationalId: "TEC-2026-000001" },
    update: {},
    create: {
      operationalId: "TEC-2026-000001",
      sessionId: session.id,
      caseId: "CASE-2026-0001",
      contactChannel: "Phone",
      callerName: "Anna Kowalska",
      callerPhone: "+48 600 100 100",
      callerEmail: "anna.kowalska@example.test",
      callerLocation: "Krakow",
      preferredLanguage: "Polish",
      claimedRelationship: "Sister",
      passengerFirstName: "Piotr",
      passengerLastName: "Kowalski",
      passengerFlight: "LO3924",
      passengerRoute: "KRK-WAW",
      lastKnownContact: "Text message before boarding",
      enquiryType: "Missing contact",
      urgency: "Urgent welfare",
      status: "Urgent welfare",
      notes: "Caller reports repeated failed contact attempts and high distress.",
      createdById: tec.id,
      updatedById: tec.id
    }
  });

  const enquiry2 = await prisma.enquiry.upsert({
    where: { operationalId: "TEC-2026-000002" },
    update: {},
    create: {
      operationalId: "TEC-2026-000002",
      sessionId: session.id,
      caseId: "CASE-2026-0002",
      contactChannel: "Email",
      callerName: "Marek Nowak",
      callerEmail: "marek.nowak@example.test",
      callerLocation: "Gdansk",
      preferredLanguage: "Polish",
      claimedRelationship: "Father",
      passengerFirstName: "Ewa",
      passengerLastName: "Nowak",
      passengerFlight: "LO3924",
      passengerRoute: "KRK-WAW",
      enquiryType: "Information request",
      urgency: "High",
      status: "Sent to family assistance",
      notes: "Caller asks for process update. No status disclosure provided by intake.",
      createdById: tec.id,
      updatedById: zpp.id
    }
  });

  await prisma.$queryRaw`
    SELECT setval(
      '"Session_operational_seq"',
      GREATEST(
        COALESCE((
          SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT)
          FROM "Session"
          WHERE "operationalId" ~ '^SES-[0-9]{4}-[0-9]+$'
        ), 0) + 1,
        1
      ),
      false
    )
  `;

  await prisma.$queryRaw`
    SELECT setval(
      '"Enquiry_operational_seq"',
      GREATEST(
        COALESCE((
          SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT)
          FROM "Enquiry"
          WHERE "operationalId" ~ '^TEC-[0-9]{4}-[0-9]+$'
        ), 0) + 1,
        1
      ),
      false
    )
  `;

  const family1 = await prisma.familyRecord.upsert({
    where: { operationalId: "FAM-2026-000001" },
    update: {},
    create: {
      operationalId: "FAM-2026-000001",
      sessionId: session.id,
      caseId: "CASE-2026-0001",
      firstName: "Anna",
      lastName: "Kowalska",
      phone: "+48 600 100 100",
      email: "anna.kowalska@example.test",
      normalizedPhone: "+48600100100",
      normalizedEmail: "anna.kowalska@example.test",
      preferredContactChannel: "Phone",
      preferredLanguage: "Polish",
      location: "Krakow",
      claimedRelationship: "Sibling",
      passengerFirstName: "Piotr",
      passengerLastName: "Kowalski",
      passengerFlight: "LO3924",
      verificationStatus: "Review required",
      verificationNotes: "Identity document reviewed by ZPP officer; relationship pending second source.",
      immediateNeeds: "Psychological First Aid, quiet waiting area, regular call-back.",
      questionsAsked: "Asked whether passenger was on board; no passenger status disclosed.",
      commitmentsMade: "Next call-back scheduled within 30 minutes.",
      nextContactDue: new Date("2026-06-21T09:00:00.000Z"),
      assignedOfficer: "ZPP",
      createdById: zpp.id,
      updatedById: zpp.id
    }
  });

  const family2 = await prisma.familyRecord.upsert({
    where: { operationalId: "FAM-2026-000002" },
    update: {},
    create: {
      operationalId: "FAM-2026-000002",
      sessionId: session.id,
      caseId: "CASE-2026-0002",
      firstName: "Marek",
      lastName: "Nowak",
      phone: "+48 600 200 200",
      email: "marek.nowak@example.test",
      normalizedPhone: "+48600200200",
      normalizedEmail: "marek.nowak@example.test",
      preferredContactChannel: "Email",
      preferredLanguage: "Polish",
      location: "Gdansk",
      claimedRelationship: "Parent",
      passengerFirstName: "Ewa",
      passengerLastName: "Nowak",
      passengerFlight: "LO3924",
      verificationStatus: "Unverified",
      immediateNeeds: "Interpreter not required. Requests call from ZPP officer.",
      assignedOfficer: "ZPP",
      createdById: zpp.id,
      updatedById: zpp.id
    }
  });

  const passenger1 = await prisma.passengerRecord.upsert({
    where: { operationalId: "PAX-2026-000001" },
    update: {},
    create: {
      operationalId: "PAX-2026-000001",
      sessionId: session.id,
      caseId: "CASE-2026-0001",
      personType: "Passenger",
      firstName: "Piotr",
      lastName: "Kowalski",
      age: 34,
      gender: "Male",
      nationality: "Polish",
      flightNumber: "LO3924",
      route: "KRK-WAW",
      seat: "12A",
      pnr: "LOTABC",
      ticketNumber: "0801234567890",
      manifestVersion: "MNF-EX-001",
      source: "Manifest",
      travellingCompanions: "None listed",
      conditionStatus: "Unknown",
      holdStatus: "Identity verification hold",
      srcConfirmed: false,
      notes: "Exercise manifest record. No status decision is implied.",
      createdById: coordinator.id,
      updatedById: zpp.id
    }
  });

  const passenger2 = await prisma.passengerRecord.upsert({
    where: { operationalId: "PAX-2026-000002" },
    update: {},
    create: {
      operationalId: "PAX-2026-000002",
      sessionId: session.id,
      caseId: "CASE-2026-0002",
      personType: "Passenger",
      firstName: "Ewa",
      lastName: "Nowak",
      age: 29,
      gender: "Female",
      nationality: "Polish",
      flightNumber: "LO3924",
      route: "KRK-WAW",
      seat: "14C",
      pnr: "LOTXYZ",
      ticketNumber: "0801234567891",
      manifestVersion: "MNF-EX-001",
      source: "Manifest",
      conditionStatus: "Unknown",
      holdStatus: "No hold",
      srcConfirmed: true,
      srcConfirmedAt: new Date("2026-06-21T08:30:00.000Z"),
      srcConfirmedById: zpp.id,
      srcConfirmationBasis: "Seeded SRC confirmation for the exercise scenario.",
      notes: "Exercise manifest record.",
      createdById: coordinator.id,
      updatedById: zpp.id
    }
  });

  await prisma.$queryRaw`
    SELECT setval(
      '"PassengerRecord_operational_seq"',
      GREATEST(
        COALESCE((
          SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT)
          FROM "PassengerRecord"
          WHERE "operationalId" ~ '^PAX-[0-9]{4}-[0-9]+$'
        ), 0) + 1,
        1
      ),
      false
    )
  `;

  await prisma.$queryRaw`
    SELECT setval(
      '"FamilyRecord_operational_seq"',
      GREATEST(
        COALESCE((
          SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT)
          FROM "FamilyRecord"
          WHERE "operationalId" ~ '^FAM-[0-9]{4}-[0-9]+$'
        ), 0) + 1,
        1
      ),
      false
    )
  `;

  for (const [family, passenger, relationship] of [
    [family1, passenger1, "Sibling"],
    [family2, passenger2, "Parent"]
  ] as const) {
    const existingClaim = await prisma.relationshipClaim.findFirst({ where: { familyRecordId: family.id, isCurrent: true } });
    if (!existingClaim) {
      await prisma.relationshipClaim.create({
        data: {
          incidentId: session.id,
          familyRecordId: family.id,
          passengerRecordId: passenger.id,
          claimedRelationshipType: relationship,
          claimedPassengerFirstName: passenger.firstName,
          claimedPassengerLastName: passenger.lastName,
          claimedPassengerFlight: passenger.flightNumber,
          source: "SEED",
          status: "PENDING",
          claimedById: zpp.id
        }
      });
    }
  }

  const familyClaim1 = await prisma.relationshipClaim.findFirstOrThrow({ where: { familyRecordId: family1.id, isCurrent: true } });
  const familyClaim2 = await prisma.relationshipClaim.findFirstOrThrow({ where: { familyRecordId: family2.id, isCurrent: true } });

  await prisma.enquiry.update({
    where: { id: enquiry1.id },
    data: { passengerRecord: { connect: { id: passenger1.id } } }
  });
  await prisma.enquiry.update({
    where: { id: enquiry2.id },
    data: { passengerRecord: { connect: { id: passenger2.id } } }
  });

  const matching1 = await prisma.matchingRecord.upsert({
    where: { operationalId: "MAT-2026-000001" },
    update: { relationshipClaimId: familyClaim1.id },
    create: {
      operationalId: "MAT-2026-000001",
      sessionId: session.id,
      caseId: "CASE-2026-0001",
      enquiryId: enquiry1.id,
      familyRecordId: family1.id,
      passengerRecordId: passenger1.id,
      relationshipClaimId: familyClaim1.id,
      status: "Hold / escalate",
      matchScore: 0.92,
      matchBasis: "Name, flight, claimed relationship and contact history align. Relationship verification still pending.",
      verificationChecklist: {
        identityDocumentChecked: true,
        relationshipEvidenceChecked: false,
        independentSourceChecked: false,
        disclosureApproved: false
      },
      holdCheck: "Identity verification hold",
      decisionNotes: "Potential match held pending relationship verification. No disclosure authorized.",
      createdById: zpp.id,
      updatedById: zpp.id
    }
  });

  const matching2 = await prisma.matchingRecord.upsert({
    where: { operationalId: "MAT-2026-000002" },
    update: { relationshipClaimId: familyClaim2.id },
    create: {
      operationalId: "MAT-2026-000002",
      sessionId: session.id,
      caseId: "CASE-2026-0002",
      enquiryId: enquiry2.id,
      familyRecordId: family2.id,
      passengerRecordId: passenger2.id,
      relationshipClaimId: familyClaim2.id,
      status: "Suggested",
      matchScore: 0.86,
      matchBasis: "Name and flight align. Family verification not yet completed.",
      verificationChecklist: {
        identityDocumentChecked: false,
        relationshipEvidenceChecked: false,
        independentSourceChecked: false,
        disclosureApproved: false
      },
      holdCheck: "No hold",
      decisionNotes: "Suggested by seed data for exercise review.",
      createdById: zpp.id,
      updatedById: zpp.id
    }
  });

  for (const [matching, claim, passenger, score, positiveSignals, conflicts] of [
    [matching1, familyClaim1, passenger1, 0.92, [{ key: "linked-passenger", label: "Passenger explicitly linked in the current claim" }, { key: "last-name", label: "Passenger surname matches the claim" }, { key: "first-name", label: "Passenger first name matches the claim" }, { key: "flight", label: "Flight matches the claim" }], []],
    [matching2, familyClaim2, passenger2, 0.86, [{ key: "linked-passenger", label: "Passenger explicitly linked in the current claim" }, { key: "last-name", label: "Passenger surname matches the claim" }, { key: "first-name", label: "Passenger first name matches the claim" }, { key: "flight", label: "Flight matches the claim" }], []]
  ] as const) {
    let suggestion = await prisma.matchSuggestion.findFirst({ where: { incidentId: session.id, relationshipClaimId: claim.id, passengerRecordId: passenger.id, algorithmVersion: "1.0.0", isCurrent: true } });
    suggestion ??= await prisma.matchSuggestion.create({ data: { incidentId: session.id, relationshipClaimId: claim.id, passengerRecordId: passenger.id, score, positiveSignals, conflicts, algorithm: "zpp-deterministic-candidate", algorithmVersion: "1.0.0", generationId: randomUUID(), claimVersion: claim.version, passengerVersion: passenger.version } });
    await prisma.matchingRecord.update({ where: { id: matching.id }, data: { suggestionId: suggestion.id } });
  }

  await prisma.$queryRaw`
    SELECT setval(
      '"MatchingRecord_operational_seq"',
      GREATEST(
        COALESCE((
          SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT)
          FROM "MatchingRecord"
          WHERE "operationalId" ~ '^MAT-[0-9]{4}-[0-9]+$'
        ), 0) + 1,
        1
      ),
      false
    )
  `;

  await prisma.request.upsert({
    where: { incidentId_operationalId: { incidentId: session.id, operationalId: "REQ-2026-000001" } },
    update: {},
    create: {
      operationalId: "REQ-2026-000001",
      incidentId: session.id,
      caseId: "CASE-2026-0001",
      relatedEnquiryId: enquiry1.id,
      relatedFamilyRecordId: family1.id,
      relatedPassengerRecordId: passenger1.id,
      category: "Psychological First Aid",
      priority: "Urgent",
      requester: "Anna Kowalska",
      ownerUserId: zpp.id,
      details: "Arrange PFA support and quiet waiting room for caller if arriving at FRC.",
      approvalStatus: "Not required",
      status: "ASSIGNED",
      notes: "Linked to urgent welfare enquiry.",
      createdById: zpp.id,
      updatedById: zpp.id
    }
  });

  await prisma.$queryRaw`
    SELECT setval(
      '"Request_operational_seq"',
      GREATEST(COALESCE((SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT) FROM "WelfareRequest"), 0) + 1, 1),
      false
    )
  `;

  const assignments = [
    {
      operationalId: "ASN-2026-000001",
      title: "Prepare welfare room briefing note",
      details: "Confirm PFA materials, quiet room setup and callback script before the next briefing.",
      status: "Open",
      priority: "Normal",
      assignedUserEmail: volunteer.email,
      legacyAssigneeLabel: null,
      relatedFunction: "Welfare Support",
      linkedRecord: "ERP-2026-001",
      caseId: "CASE-2026-0001",
      dueAt: new Date("2026-06-21T12:00:00.000Z")
    },
    {
      operationalId: "ASN-2026-000002",
      title: "Confirm TEC evening shift availability",
      details: "Check trained TEC coverage for the 18:00-22:00 operating period.",
      status: "In Progress",
      priority: "Urgent",
      assignedUserEmail: null,
      legacyAssigneeLabel: "Leader Bravo",
      relatedFunction: "Telephone Enquiry Center",
      linkedRecord: "RST-002",
      dueAt: new Date("2026-06-21T13:00:00.000Z")
    },
    {
      operationalId: "ASN-2026-000003",
      title: "Verify restricted case before first contact",
      details: "Coordinator review is required before outbound contact or disclosure.",
      status: "Escalated",
      priority: "Critical",
      assignedUserEmail: coordinator.email,
      legacyAssigneeLabel: null,
      relatedFunction: "Family Assistance",
      linkedRecord: "NOK-2026-001",
      caseId: "CASE-2026-0001",
      dueAt: new Date("2026-06-21T10:30:00.000Z")
    },
    {
      operationalId: "ASN-2026-000004",
      title: "Review role card access levels",
      details: "Confirm who can access restricted family assistance role cards.",
      status: "Completed",
      priority: "Normal",
      assignedUserEmail: admin.email,
      legacyAssigneeLabel: null,
      relatedFunction: "Documentation",
      linkedRecord: "DOC-ROLE-004",
      dueAt: new Date("2026-06-21T16:00:00.000Z")
    }
  ];

  for (const assignment of assignments) {
    const { assignedUserEmail, ...assignmentData } = assignment;
    const assignee = assignedUserEmail ? await prisma.user.findUnique({ where: { email: assignedUserEmail } }) : null;
    const identityData = { assignedUserId: assignee?.id ?? null };
    const terminalData = assignment.status === "Completed"
      ? { completedById: admin.id, completedAt: new Date("2026-06-21T09:00:00.000Z") }
      : {};
    await prisma.assignmentTask.upsert({
      where: { operationalId: assignment.operationalId },
      update: { ...identityData, ...terminalData },
      create: {
        ...assignmentData,
        ...identityData,
        ...terminalData,
        sessionId: session.id,
        createdById: zpp.id,
        updatedById: assignment.status === "Escalated" ? coordinator.id : zpp.id
      }
    });
  }

  await prisma.$queryRaw`
    SELECT setval(
      '"AssignmentTask_operational_seq"',
      GREATEST(COALESCE((SELECT MAX(substring("operationalId" FROM '([0-9]+)$')::BIGINT) FROM "AssignmentTask"), 0) + 1, 1),
      false
    )
  `;

  await prisma.exerciseInject.upsert({
    where: { sessionId_injectNumber: { sessionId: session.id, injectNumber: 1 } },
    update: {},
    create: {
      operationalId: "INJ-2026-000001",
      sessionId: session.id,
      injectNumber: 1,
      scenarioTime: new Date("2026-06-21T08:15:00.000Z"),
      targetRole: "TEC",
      text: "Caller reports missing contact with a passenger and asks if they are injured.",
      expectedAction: "Create enquiry, mark urgent welfare if appropriate, do not disclose passenger/casualty status.",
      status: "Released",
      releasedById: coordinator.id,
      releasedAt: new Date("2026-06-21T08:15:00.000Z")
    }
  });

  await prisma.exerciseObservation.upsert({
    where: { operationalId: "OBS-2026-000001" },
    update: {},
    create: {
      operationalId: "OBS-2026-000001",
      sessionId: session.id,
      area: "Intake",
      observation: "Intake correctly recorded the enquiry without confirming passenger or casualty status.",
      severity: "Low",
      recommendation: "Continue reinforcing controlled disclosure language.",
      owner: "Exercise Director",
      includeInAar: true,
      status: "Open",
      createdById: coordinator.id
    }
  });

  const timelineCount = await prisma.caseTimelineEvent.count({ where: { sessionId: session.id } });
  if (timelineCount === 0) {
    await prisma.caseTimelineEvent.createMany({
      data: [
        {
          sessionId: session.id,
          caseId: "CASE-2026-0001",
          eventType: "enquiry",
          entityType: "enquiry",
          entityId: enquiry1.id,
          title: "Urgent TEC enquiry received",
          body: "Caller seeking information about passenger. Intake did not disclose protected status.",
          createdById: tec.id
        },
        {
          sessionId: session.id,
          caseId: "CASE-2026-0001",
          eventType: "matching",
          entityType: "matchingRecord",
          title: "Potential match placed on identity verification hold",
          body: "ZPP requires additional relationship verification before disclosure or reunification.",
          createdById: zpp.id
        },
        {
          sessionId: session.id,
          caseId: "CASE-2026-0001",
          eventType: "request",
          entityType: "request",
          title: "Urgent PFA request assigned",
          body: "Welfare logistics request created and assigned.",
          createdById: zpp.id
        }
      ]
    });
  }

  const auditCount = await prisma.auditLog.count();
  if (auditCount === 0) {
    await prisma.auditLog.createMany({
      data: [
        {
          action: "create_session",
          entityType: "session",
          entityId: session.id,
          sessionId: session.id,
          actorId: coordinator.id,
          actorEmail: coordinator.email,
          summary: "Seed exercise session created."
        },
        {
          action: "create_enquiry",
          entityType: "enquiry",
          entityId: enquiry1.id,
          sessionId: session.id,
          actorId: tec.id,
          actorEmail: tec.email,
          summary: "Seed urgent welfare enquiry created."
        },
        {
          action: "create_potential_match",
          entityType: "matchingRecord",
          sessionId: session.id,
          actorId: zpp.id,
          actorEmail: zpp.email,
          summary: "Seed matching records created for exercise."
        }
      ]
    });
  }
}

async function seedNotifications() {
  const [admin, coordinator, volunteer, session] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } }),
    prisma.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } }),
    prisma.user.findUniqueOrThrow({ where: { email: "volunteer@lot.pl" } }),
    prisma.session.findUniqueOrThrow({ where: { operationalId: "SES-2026-001" } }),
  ]);
  const createdAt = new Date("2026-07-09T09:30:00.000Z");
  await prisma.notification.createMany({
    skipDuplicates: true,
    data: [
      {
        id: "13000000-0000-4000-8000-000000000001", recipientUserId: coordinator.id,
        deduplicationKey: "seed:event:session:ses-2026-001:briefing", mode: "EVENT", kind: "Information", severity: "Information", category: "Session",
        title: "Exercise session available", message: "SES-2026-001 is available for operational review.", sessionId: session.id, sessionLabel: session.operationalId,
        sourceType: "session", sourceId: session.id, sourceLabel: session.operationalId, actionDestination: "/sessions", actionLabel: "Open sessions",
        metadata: { provenance: "prisma-seed" }, createdAt, updatedAt: createdAt,
      },
      {
        id: "13000000-0000-4000-8000-000000000002", recipientUserId: admin.id,
        deduplicationKey: "seed:event:access:admin-ready", mode: "EVENT", kind: "Information", severity: "Information", category: "Admin",
        title: "Administration access ready", message: "Your administration workspace is ready for review.", sourceType: "access", sourceId: admin.id, sourceLabel: "Administration",
        actionDestination: "/settings", actionLabel: "Open settings", metadata: { provenance: "prisma-seed" }, createdAt, updatedAt: createdAt,
      },
      {
        id: "13000000-0000-4000-8000-000000000003", recipientUserId: volunteer.id,
        deduplicationKey: `seed:condition:training:trn-2026-000004:${volunteer.id}`, mode: "CONDITION", kind: "Action required", severity: "Attention", category: "Training",
        title: "Training overdue", message: "Assigned crisis response training needs attention.", sourceType: "trainingRecord", sourceId: "trn-2026-000004", sourceLabel: "TRN-2026-000004",
        conditionType: "training", actionDestination: "/training", actionLabel: "Open training", metadata: { condition: true, conditionType: "training", provenance: "prisma-seed" }, createdAt, updatedAt: createdAt,
      },
    ],
  });
}

async function main() {
  await seedOrganizations();
  await seedRolesAndUsers();
  await seedDictionaries();
  await seedOperationalData();
  await seedNotifications();
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.info("ZPP Connect seed completed.");
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
